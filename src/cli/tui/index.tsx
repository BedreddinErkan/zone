import { randomUUID } from "node:crypto";
import { exec, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { render } from "ink";
import qrcode from "qrcode-terminal";

const execAsync = promisify(exec);
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import type { CliFlags } from "../config.js";
import { loadCliConfig, validateCliConfig, applyDiskKeyFallbacks, type CliConfig } from "../config.js";
import { runOneShotInner, type TuiMode } from "../dispatch.js";
import { ApiKeyError, ProviderRequestError, PlanRefusalError } from "../../llm/factory.js";
import { resolveInitialTuiMode } from "./initialMode.js";
import { buildBannerLine } from "./banner.js";
import type { LlmPatchFlowResult } from "../../core/runLlmPatchFlow.js";
import { createEventBus } from "../eventBus.js";
import { applyStdoutInterception, applyStderrInterception } from "./stdoutShield.js";
import type { LlmPatchProgressUpdate } from "../../core/agentLifecycleEvents.js";
import { loadDiskTrust, diskTrustPrefixes } from "../../api/diskTrust.js";
import { saveSession, saveSessionSync, pruneOldSessions, loadLastSession, loadSessionById, type DiskSession } from "../../api/diskSessions.js";
import { latestResumableEnvelope, listResumableEnvelopes, stampEnvelopeStatus, envelopeKeyFor } from "../../api/diskRunEnvelope.js";
import { emitAskUserRefused } from "../../llm/loopTelemetry.js";
import { buildResumeFlowInput } from "../dispatch.js";
import { loadDiskModel, type DiskModelSettings } from "../../api/diskModel.js";
import { loadDiskHooks, hooksConfigHash, type UserHooksConfig } from "../../api/diskHooks.js";
import { isHooksTrusted } from "../../api/diskTrustedHooks.js";
import { loadDiskMcp, mcpConfigHash, type McpConfig } from "../../api/diskMcp.js";
import { isMcpTrusted } from "../../api/diskTrustedMcp.js";
import { McpClientManager } from "../../mcp/mcpClientManager.js";
import { log } from "../../utils/logger.js";
import type { StoreState, StoreAction, PendingQuestion } from "./store.js";
import { isRunInFlight } from "./store-core.js";
import { deriveCommitMessage, shouldAutoCommit } from "./commitMessage.js";
import { executeCommit } from "./components/CommitModal.js";
import { loadUserCommands, type UserCommand } from "./userCommands.js";
import { shouldRedrawOnResize, applyResizeRedraw } from "./resize.js";
import { getUsage } from "../../usage/usageTracker.js";
import { startRemoteControlServer, type RemoteControlServerHandle } from "../../remote/controlServer.js";
import { createRemoteControlAdapter } from "../../remote/remoteControlAdapter.js";

const _bannerRequire = createRequire(import.meta.url);
const { version: _zoneVersion } = _bannerRequire("../../../package.json") as { version: string };

function _getGitBranch(): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

function writeBannerToStdout(opts: { isResumed: boolean }): void {
  // Construction lives in banner.ts so it can be asserted on byte-for-byte; this side of it is
  // only the stdout write.
  process.stdout.write(
    buildBannerLine({
      version: _zoneVersion,
      cwd: process.cwd(),
      branch: _getGitBranch(),
      isResumed: opts.isResumed,
    })
  );
}

function emitTranscriptLine(
  dispatch: ((action: StoreAction) => void) | null | undefined,
  text: string
): void {
  dispatch?.({ type: "USER_PROMPT", text });
}

function renderRemoteControlQr(url: string): string {
  let rendered = "";
  qrcode.generate(url, { small: true }, (qr) => {
    rendered = qr.trimEnd();
  });
  return rendered;
}

function emitRemoteControlBanner(
  dispatch: ((action: StoreAction) => void) | null | undefined,
  server: RemoteControlServerHandle
): void {
  const qr = renderRemoteControlQr(server.url);
  const lines = [
    `=== REMOTE CONTROL HOST: ${server.host}:${server.port} ===`,
    "Remote control server started. Scan the QR code or use the URL below.",
    server.url,
    "A connected remote will be able to drive this session once Inc-1b lands.",
    "Transport caveat: V1 uses ws without TLS — encrypted over Tailscale, cleartext over plain LAN. Prefer Tailscale or a trusted LAN; TLS comes later.",
  ];

  for (const line of lines) {
    emitTranscriptLine(dispatch, line);
  }

  if (!qr) {
    return;
  }

  for (const line of qr.split("\n")) {
    emitTranscriptLine(dispatch, line);
  }
}

/** Strip the well-known banner lines that prefix patchPreview on the agent-loop path. */
function stripBanner(s: string): string {
  return s.replace(/^=== [A-Z ]+===\n/, "");
}

// Continuation-intent detection — two verb tiers with different reference requirements.
//
// Strong verbs (continue/proceed/…) can match bare report/findings/summary — these
// rarely name code artifacts. Bare output/response are excluded even here (too ambiguous).
//
// Weak fetch verbs (give me/show me) require a specific qualifier: section+digit,
// "rest of the X", "previous/prior X", or "what you wrote/produced/generated".
// This prevents "show me the coverage report" and "give me the response" from firing.
const _STRONG_VERB_RE = /\b(?:continue|proceed|carry\s+on|go\s+on|finish|complete)\b/i;
const _STRONG_OUTPUT_REF_RE = new RegExp(
  [
    String.raw`\b(?:section|part)s?\s*\d`,
    String.raw`\bwhat\s+you\s+(?:wrote|produced|generated)\b`,
    String.raw`\brest\s+of\s+(?:the\s+)?(?:output|response|report|analysis|findings|summary)\b`,
    String.raw`\b(?:previous|prior|your)\s+(?:report|output|response|analysis|findings|summary)\b`,
    String.raw`\b(?:report|findings|summary)\b`,
  ].join("|"),
  "i"
);
const _WEAK_VERB_RE = /\b(?:give\s+me|show\s+me)\b/i;
const _SPECIFIC_OUTPUT_REF_RE = new RegExp(
  [
    String.raw`\b(?:section|part)s?\s*\d`,
    String.raw`\bwhat\s+you\s+(?:wrote|produced|generated)\b`,
    String.raw`\brest\s+of\s+(?:the\s+)?(?:output|response|report|analysis|findings|summary)\b`,
    String.raw`\b(?:previous|prior|your)\s+(?:report|output|response|analysis|findings|summary)\b`,
  ].join("|"),
  "i"
);
export function isContinueIntent(prompt: string): boolean {
  return (_STRONG_VERB_RE.test(prompt) && _STRONG_OUTPUT_REF_RE.test(prompt))
      || (_WEAK_VERB_RE.test(prompt)   && _SPECIFIC_OUTPUT_REF_RE.test(prompt));
}

/** Load the multi-turn session window from the FS conversation store (non-blocking, never throws). */
async function loadSessionWindow(sessionId: string, repoPath: string): Promise<string> {
  try {
    const { readFsConversationEvents } = await import("../../core/conversationFilesystemStore.js");
    const { buildSessionWindow } = await import("../../llm/sessionWindow.js");
    return buildSessionWindow(readFsConversationEvents({ repoPath, threadId: sessionId }));
  } catch { return ""; }
}

/** Derive a neutral outcome enum from the run result — never uses raw decisionMode strings. */
function deriveNeutralOutcome(
  runResult: LlmPatchFlowResult | undefined,
  changedFiles: string[]
): "applied" | "no_change" | "answered" | "reverted" | "interrupted" {
  if (!runResult) return "no_change";
  if (!runResult.ok) return "reverted";
  if (changedFiles.length > 0) return "applied";
  if ("patchPreview" in runResult && (runResult as { patchPreview?: string }).patchPreview) return "answered";
  return "no_change";
}

/** Exported for testing. Writes one atomic turn record for multi-turn session memory. */
export async function _writeTurnRecord(params: {
  config: { memoryEnabled?: boolean; repoPath: string };
  sessionId: string;
  runId: string;
  prompt: string;
  runResult: LlmPatchFlowResult | undefined;
  abortedFiles: string[] | undefined;
  aborted: boolean;
}): Promise<void> {
  const { config, sessionId, runId, prompt, runResult, abortedFiles, aborted } = params;
  if (!config.memoryEnabled || !sessionId) return;
  const { appendFsConversationEvent } = await import("../../core/conversationFilesystemStore.js");
  const { truncateSessionTurn, truncateForContinuation, MAX_CHANGED_FILES, USER_PROMPT_MAX_BYTES } =
    await import("../../llm/sessionWindow.js");

  if (aborted) {
    const changedFiles = (abortedFiles ?? []).slice(0, MAX_CHANGED_FILES);
    const fileCount = changedFiles.length;
    const summary = fileCount > 0
      ? `interrupted; ${fileCount} file${fileCount === 1 ? "" : "s"} partially modified`
      : "interrupted before any changes";
    const ok = await appendFsConversationEvent({
      repoPath: config.repoPath,
      threadId: sessionId,
      event: {
        type: "turn",
        ts: Date.now(),
        runId,
        userPrompt: prompt.slice(0, USER_PROMPT_MAX_BYTES),
        summary,
        changedFiles,
        outcome: "interrupted",
      },
    });
    if (!ok && process.env.ZONE_TUI_DEBUG === "1") {
      process.stderr.write("[zone-session-mem] interrupted turn write skipped\n");
    }
  } else if (runResult !== undefined) {
    const fd = (runResult as { fileDiffs?: Array<{ filePath: string }> }).fileDiffs ?? [];
    const changedFiles = fd.map(d => d.filePath).slice(0, MAX_CHANGED_FILES);
    const rawPreview = (runResult as { patchPreview?: string }).patchPreview;
    const summary = typeof rawPreview === "string" ? truncateSessionTurn(stripBanner(rawPreview)) : "";
    // Head-keep 16KB snapshot for continuation — omitted when no preview content.
    const fullAnswer = typeof rawPreview === "string" && rawPreview.length > 0
      ? truncateForContinuation(stripBanner(rawPreview))
      : undefined;
    const ok = await appendFsConversationEvent({
      repoPath: config.repoPath,   // NOT process.cwd() — repoPathTrap
      threadId: sessionId,
      event: {
        type: "turn",
        ts: Date.now(),
        runId,
        userPrompt: prompt.slice(0, USER_PROMPT_MAX_BYTES),
        summary,
        ...(fullAnswer !== undefined ? { fullAnswer } : {}),
        changedFiles,
        outcome: deriveNeutralOutcome(runResult, changedFiles),
      },
    });
    if (!ok && process.env.ZONE_TUI_DEBUG === "1") {
      process.stderr.write("[zone-session-mem] turn write skipped\n");
    }
  }
}

// ---------------------------------------------------------------------------
// _RunPromptDeps — explicit closure for _runPromptImpl (extracted for testability)
// ---------------------------------------------------------------------------

export interface _RunPromptDeps {
  config: CliConfig;
  storeCapture: {
    state: StoreState | null;
    lastCommitData: { filePaths: string[]; message: string; repoPath: string } | null;
    lastFeedbackData: { runId: string; sessionId: string; logs: string; version: string; repoPath: string } | null;
    dispatch: ((action: StoreAction) => void) | null;
    /**
     * Envelope key of the run in flight, for the signal handlers — which run
     * outside React and cannot read it from state. Envelopes are keyed per run,
     * so sessionId no longer names the file.
     */
    currentEnvelopeKey?: string | null;
  };
  bus: import("../eventBus.js").EventBus;
  localSessionId: string;
  /** Durable resume: consumed on the first prompt run if set; null afterward. */
  pendingEnvelopeResume?: Awaited<ReturnType<typeof buildResumeFlowInput>> | null;
}

/**
 * Resolve the effective session ID for a prompt run.
 * Falls back to the pre-computed localSessionId when storeCapture.state is null
 * (first React render tick — the pre-seeded prompt fires before onStateChange populates state).
 */
export function _resolveSessionId(
  storeState: { sessionId?: string } | null,
  localSessionId: string
): string {
  return storeState?.sessionId ?? localSessionId;
}

/**
 * Telemetry for setting a suspended run aside.
 *
 * The reason matches the in-run Esc deliberately: both are the user declining to
 * answer, and one counter for "the user declined" is the signal. `detail` is what
 * keeps the two channels separable without splitting that counter — collapse it
 * and a turn-boundary dismissal becomes indistinguishable from a mid-run skip.
 */
export function _carriedDiscardTelemetry(
  envelopeKey: string,
  iter: number,
): Parameters<typeof emitAskUserRefused>[0] {
  return {
    runId: envelopeKey || null,
    reason: "user_declined",
    archetype: null,
    iter,
    detail: "carried_over",
  };
}

/**
 * What --resume / /resume should do with the envelope it just loaded.
 *
 * Pure, and extracted rather than inlined, because the whole correctness of the
 * turn boundary is this one branch: auto-running an envelope that stopped
 * mid-question restarts the run before the user can type, and
 * reconcileDanglingToolCalls then answers on their behalf with "no answer is
 * available" — at the exact moment they asked to resume in order to answer it.
 */
export function _resumeStartupAction(
  resume: {
    pendingQuestion?: { toolCallId: string; question: string; iter: number };
    messagesOmitted?: boolean;
    envelopeKey?: string;
  } | undefined,
  task: string,
):
  | { kind: "auto_run"; prompt: string }
  | { kind: "await_answer"; carried: Extract<PendingQuestion, { kind: "carried" }> } {
  const q = resume?.pendingQuestion;
  if (!q) return { kind: "auto_run", prompt: task };
  return {
    kind: "await_answer",
    carried: {
      kind: "carried",
      question: q.question,
      toolCallId: q.toolCallId,
      // The run that ASKED. The run that will answer does not exist yet.
      runId: resume?.envelopeKey ?? "",
      iter: q.iter,
      conversationLost: resume?.messagesOmitted === true,
    },
  };
}

/**
 * What --resume <opts.resume> should load at startup, and what to tell the user if it doesn't.
 *
 * Pure aside from the diskSessions reads (which already respect _setSessionsDirForTest), and
 * extracted rather than inlined so it's callable from tests without standing up runTui's own
 * Ink render + signal-handler setup — the same reason _resumeStartupAction above is extracted.
 *
 * A string `resume` is an explicit id/prefix typed by the user and must never fall back to the
 * most recent session on a miss — that silent substitution is the defect this exists to close.
 * A bare `true` keeps the original "most recent session in this repo" behavior unchanged.
 */
export async function _resolveResumeRequest(
  resume: boolean | string | undefined,
  cwd: string,
): Promise<{ session: DiskSession | null; missMessage: string | null }> {
  if (!resume) return { session: null, missMessage: null };
  if (typeof resume === "string") {
    const session = await loadSessionById(cwd, resume);
    return {
      session,
      missMessage: session
        ? null
        : `No session matching '${resume}' found in this directory; starting fresh.`,
    };
  }
  const session = await loadLastSession(cwd);
  return {
    session,
    missMessage: session ? null : "No prior session found in this directory; starting fresh.",
  };
}

const RESUME_HINT_ID_LENGTH = 8;

/**
 * What to tell the user about resuming, given whether the session was actually saved. Pure so
 * "only print when something was actually persisted" pins to a test rather than an assumption.
 * transcriptLength and saved are checked independently rather than collapsing to one flag: a
 * thrown saveSession (transcript non-empty, but the write itself failed) must not print a hint
 * pointing at a session that doesn't exist on disk — the same false-message class the last two
 * passes closed. The caller sets `saved` immediately after saveSession returns, before
 * pruneOldSessions runs, since both share one try/catch and a prune-only failure must not read
 * as a save failure here.
 */
export function _buildExitResumeHint(
  transcriptLength: number,
  saved: boolean,
  sessionId: string,
): string | null {
  if (transcriptLength === 0 || !saved) return null;
  return `Resume this session with: zone --resume ${sessionId.slice(0, RESUME_HINT_ID_LENGTH)}`;
}

const SAVE_FAILURE_CLAUSE = "It will not be available to resume.";

/**
 * What to log and tell the user when a save fails, on either the clean-exit or the signal path.
 * Takes `saved` as an explicit input rather than assuming call-site ordering: by the time
 * pruneOldSessions runs (clean-exit only — the signal path has no prune), `saved` is already
 * true, so a caught error with saved=true can only be pruneOldSessions failing — the session
 * itself is safe on disk, and a maintenance-only failure doesn't warrant the same signal as
 * losing the conversation. Returns null in that case, deliberately: no marker, no message.
 *
 * `phase` distinguishes "the write itself failed" (phase: "write" — saveSession's own fs
 * errors) from "the session couldn't even be constructed" (phase: "build" — buildDiskSession
 * throwing, e.g. process.cwd() failing if the working directory was removed underneath the
 * process). The same catch shape and the same "Could not save" wording would misreport the
 * build case: nothing was ever attempted, so nothing "failed to save" in the way that phrase
 * implies. The marker payload carries phase too, so the two are distinguishable in records, not
 * just in the user-facing string.
 *
 * `signal` distinguishes which path reported: null on the clean-exit path, the signal name
 * (e.g. "SIGTERM") on the fatal-signal path — an explicit, visible field in every payload, not
 * an absent key that could be misread as forgotten.
 *
 * `emitLog` has no default deliberately: a default would let a call site on the signal path
 * silently fall back to the real log() instead of the handler's own injected, test-observable
 * one — observationally identical in production (both eventually reach the same sink) but
 * different in tests, where only the injected path is captured. Both clean-exit call sites pass
 * the real log() explicitly instead; the signal handler passes its own emitLog. process.stderr
 * .write for the user-facing text stays at the call site, which isn't independently reachable,
 * same split as _buildExitResumeHint's.
 */
export function _reportSaveFailure(
  err: unknown,
  saved: boolean,
  sessionId: string,
  phase: "build" | "write",
  signal: string | null,
  emitLog: (name: string, payload: string) => void,
): string | null {
  if (saved) return null;
  const isError = err instanceof Error;
  const code = isError ? ((err as NodeJS.ErrnoException).code ?? null) : null;
  const message = isError ? err.message : String(err);
  emitLog("[zone-session-save-failed]", JSON.stringify({ sessionId, phase, signal, isError, code, message }));
  return phase === "build"
    ? `Could not prepare this session to save: ${message}. ${SAVE_FAILURE_CLAUSE}`
    : `Could not save this session: ${message}. ${SAVE_FAILURE_CLAUSE}`;
}

/** The exact trailing text _resolveResumeRequest's miss messages end with — exported so a test
 *  can pin that they still do, rather than the two functions being coupled by an untested
 *  assumption. */
export const RESUME_MISS_SUFFIX = /; starting fresh\.$/;
const RESUME_FOUND_CLAUSE = ", but an interrupted run was found and is resuming.";

/**
 * Reconciles the session lookup's miss message against whether an envelope resume was also
 * found, so the user is never told "starting fresh" while a durable run is actually resuming.
 * Deferred out of _resolveResumeRequest itself, which stays envelope-agnostic — the envelope
 * outcome isn't known until after index.tsx's separate envelope-resume block has run.
 *
 * Coupled to _resolveResumeRequest's wording by RESUME_MISS_SUFFIX: String.replace silently
 * returns its input unchanged when the pattern doesn't match, which here would mean quietly
 * keeping the false "starting fresh" claim on an envelope hit — reintroducing the exact defect
 * this function exists to close. Detected explicitly below rather than trusted implicitly.
 */
export function _composeResumeMessage(
  sessionMissMessage: string | null,
  envelopeFound: boolean,
): string | null {
  if (!sessionMissMessage) return null;
  if (!envelopeFound) return sessionMissMessage;
  if (!RESUME_MISS_SUFFIX.test(sessionMissMessage)) {
    // The coupling above has drifted: _resolveResumeRequest's wording no longer ends in the
    // suffix this replace depends on. Fail loud, and don't rely on .replace here — concatenation
    // has no "pattern didn't match" case to silently no-op on, so the last thing the user reads
    // is still true, even if the full sentence reads a little redundant until this is fixed.
    log("[zone-resume-message-mismatch]", JSON.stringify({ sessionMissMessage }));
    return `${sessionMissMessage}${RESUME_FOUND_CLAUSE}`;
  }
  return sessionMissMessage.replace(RESUME_MISS_SUFFIX, RESUME_FOUND_CLAUSE);
}

/**
 * Extracted core of runPrompt — all closure deps are explicit so this function
 * can be called from tests without rendering Ink.
 * runOneShotInner is a module-level import and is vi.mockable via vi.mock("../dispatch.js").
 */
export async function _runPromptImpl(
  prompt: string,
  ac: AbortController,
  mode: TuiMode,
  images: import("../../api/imageUpload.js").ImageAttachment[] | undefined,
  deps: _RunPromptDeps
): Promise<void> {
  const { storeCapture, config, bus, localSessionId } = deps;
  const runId = randomUUID();
  const sessionId = _resolveSessionId(storeCapture.state, localSessionId);

  // ! shell escape — run cmd directly without LLM; results appear as a tool entry
  if (prompt.startsWith("!")) {
    const cmd = prompt.slice(1).trim();
    if (!cmd) return;
    const ts = Date.now();
    bus.emit("tool_call", { runId, ts, type: "tool_call", title: `[tool] shell: ${cmd}` });
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: process.cwd(), timeout: 30_000 });
      const out = [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)";
      bus.emit("tool_result", { runId, ts: Date.now(), type: "tool_result",
        toolName: "shell", title: out.slice(0, 100), detail: out, status: "success" });
    } catch (err: unknown) {
      const out = err instanceof Error ? err.message : String(err);
      bus.emit("tool_result", { runId, ts: Date.now(), type: "tool_result",
        toolName: "shell", title: out.slice(0, 100), detail: out, status: "error" });
    }
    return;
  }

  // Load prior session summary before the run (not via conversationId to avoid triggering
  // the rollback priorRunSummary path with wrong framing — load directly from the FS store).
  let priorSessionSummary: string | undefined;
  if (config.memoryEnabled && sessionId) {
    const loaded = await loadSessionWindow(sessionId, config.repoPath);
    if (loaded) priorSessionSummary = loaded;
    // On explicit continue-intent, prepend the prior turn's head-kept fullAnswer
    // so sections 1–N are visible even though the steady-state summary kept only the tail.
    // Gate: continue-intent only, previous-turn-only, capped at 64KB.
    // priorSessionSummary && precondition removed: fullAnswer can inject even when
    // the base window is thin/empty (e.g. after a first turn with a large report).
    if (isContinueIntent(prompt)) {
      const { readFsConversationEvents } = await import("../../core/conversationFilesystemStore.js");
      const { buildContinuationContext } = await import("../../llm/sessionWindow.js");
      const evts = readFsConversationEvents({ repoPath: config.repoPath, threadId: sessionId });
      const continuation = buildContinuationContext(evts);
      if (continuation) {
        priorSessionSummary =
          "PRIOR TURN FULL CONTENT (continuation requested):\n" +
          continuation +
          "\nEND PRIOR TURN CONTENT.\n\n" +
          (priorSessionSummary ?? "");
      }
    }
  }

  const onProgress = (update: LlmPatchProgressUpdate): void => {
    if (typeof update === "string") return;
    const evt = update.progress;
    if (evt) {
      bus.emit(evt.type, evt);
    }
  };
  let runResult: LlmPatchFlowResult | undefined;
  let abortedFiles: string[] | undefined;
  let emitSafetyNet = true;
  // Durable resume: consume the pending envelope resume on the first run only.
  const envelopeResume = deps.pendingEnvelopeResume ?? null;
  if (deps.pendingEnvelopeResume !== undefined) deps.pendingEnvelopeResume = null;
  // A resumed run adopts its source envelope; every other run is keyed by runId.
  storeCapture.currentEnvelopeKey = envelopeResume?.resume?.envelopeKey ?? runId;

  try {
    runResult = await runOneShotInner(prompt, config, runId, {
      externalAc: ac, onProgress, mode, priorSessionSummary, images,
      userHooks: storeCapture.state?.armedUserHooks,
      mcpManager: storeCapture.state?.armedMcpManager,
      sessionId: envelopeResume?.sessionId ?? (sessionId ?? undefined),
      // The one caller that may park on a question — see AgentLoopInput.interactiveChannel.
      interactiveChannel: "tui",
      resume: envelopeResume?.resume,
      preGeneratedPlan: envelopeResume?.preGeneratedPlan,
    });
  } catch (err: unknown) {
    if (err instanceof ApiKeyError) {
      // Missing/invalid API key: surface as red ErrorLine before any LLM call is attempted.
      bus.emit("run_failed", {
        runId,
        ts: Date.now(),
        type: "run_failed",
        title: "API key missing",
        userMessage: err.message,
        errorKind: "other" as const,
      });
      emitSafetyNet = false;
    } else if (err instanceof ProviderRequestError) {
      // Typed provider error (e.g. retention 400): surface as red ErrorLine + failed run-state.
      bus.emit("run_failed", {
        runId,
        ts: Date.now(),
        type: "run_failed",
        title: "Provider error",
        userMessage: err.userMessage,
        errorKind: err.kind,
      });
      emitSafetyNet = false;
    } else if (err instanceof PlanRefusalError) {
      // Graceful plan-path refusal: render decline reason as ASSISTANT_FINAL (not ERROR_LINE).
      bus.emit("agent_loop_complete", {
        runId,
        ts: Date.now(),
        type: "agent_loop_complete",
        title: "Plan declined",
        detail: err.declineReason,
      });
      bus.emit("run_summary", {
        runId,
        ts: Date.now(),
        type: "run_summary",
        title: "Run summary",
        cost: { totalUsd: err.costUsd, iterCount: 0, cacheHitPct: 0, avgIterUsd: 0 },
      });
      emitSafetyNet = false;
    } else {
      if (ac.signal.aborted && err instanceof Error) {
        abortedFiles = (err as Error & { filesModified?: string[] }).filesModified ?? [];
      }
      const msg = err instanceof Error ? err.message : String(err);
      bus.emit("narration", {
        runId,
        ts: Date.now(),
        type: "narration",
        title: "run error",
        text: `[zone] run error (provider=${config.provider} model=${config.model}): ${msg}`,
      });
    }
  } finally {
    // Safety net: if runLlmPatchFlow threw before emitting agent_loop_complete,
    // runState would stay "running" forever.
    if (!ac.signal.aborted && emitSafetyNet) {
      bus.emit("agent_loop_complete", {
        runId,
        ts: Date.now(),
        type: "agent_loop_complete",
        title: "Run ended",
      });
    }
  }

  // Refresh the cumulative daily cost badge now that the run's costs are on disk.
  try {
    const daily = await getUsage("local-dev", "day"); // TUI always records under "local-dev"
    storeCapture.dispatch?.({ type: "DAILY_USED_UPDATE", dailyUsedUsd: daily.totalCostUsd });
  } catch { /* non-critical */ }

  // Write atomic turn record for multi-turn memory.
  // Written post-run only — no submit-time write to avoid fire-and-forget race.
  // Aborted runs (ac.signal.aborted) also write — using files attached to the thrown error.
  // Gate is ac.signal.aborted specifically: ProviderRequestError/PlanRefusalError are ERRORED
  // (not INTERRUPTED) and must not write here.
  if (sessionId) {
    await _writeTurnRecord({
      config,
      sessionId,
      runId,
      prompt,
      runResult,
      abortedFiles,
      aborted: ac.signal.aborted,
    });
  }

  // Stash commit data for /commit command (post-run only; finalizeStaging has already flushed).
  const fileDiffs = (runResult as { fileDiffs?: Array<{ filePath: string }> } | undefined)?.fileDiffs ?? [];
  if (runResult?.ok && fileDiffs.length > 0) {
    const rawPreview = (runResult as { patchPreview?: string }).patchPreview ?? "";
    const filePaths = fileDiffs.map(d => d.filePath);
    const message = deriveCommitMessage(stripBanner(rawPreview));
    storeCapture.lastCommitData = { filePaths, message, repoPath: config.repoPath };

    if (shouldAutoCommit(runResult, config.commitOnSuccess ?? false)) {
      const autoResult = await executeCommit(config.repoPath, message, filePaths);
      const toastMsg = autoResult.ok
        ? `Auto-committed: ${autoResult.hash}`
        : `Auto-commit failed: ${autoResult.error}`;
      storeCapture.dispatch?.({
        type: "TOAST_PUSH",
        entry: { id: randomUUID(), message: toastMsg, level: autoResult.ok ? "info" : "error" },
      });
    }
  }

  // Stash feedback data for /feedback command (best-effort; errors swallowed).
  try {
    const [{ costLogDir }, fsSync, nodePath, { sanitizeDiagnostics }] = await Promise.all([
      import("../../usage/costLogger.js"),
      import("node:fs"),
      import("node:path"),
      import("../../utils/sanitizeDiagnostics.js"),
    ]);
    const prefix = runId.slice(0, 8);
    const dir = costLogDir();
    const files = (fsSync.readdirSync(dir) as string[]).filter((f) => f.endsWith(`-${prefix}.jsonl`));
    files.sort();
    const latest = files[files.length - 1];
    const raw = latest ? fsSync.readFileSync(nodePath.join(dir, latest), "utf8") as string : "";
    const tail = raw.trim().split("\n").filter(Boolean).slice(-8).join("\n");
    storeCapture.lastFeedbackData = { runId, sessionId, logs: sanitizeDiagnostics(tail), version: _zoneVersion, repoPath: config.repoPath };
  } catch { /* best-effort */ }
}

/** Signals that mean "this process is going away, persist what you have and exit."
 *  Codes are the conventional 128+signum. SIGHUP was missing until 2026-08-01: four
 *  consecutive dogfood runs left no session file because `tmux kill-session` sends
 *  SIGHUP, whose default action terminates immediately with no JS handler run. It is
 *  a real user-facing gap too — closing a terminal window SIGHUPs identically. */
export const FATAL_SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
} as const;

export interface FatalSignalDeps {
  /** Read at signal time, not registration time — state is null until React mounts. */
  getState: () => { transcript: unknown[]; sessionId: string; armedMcpManager?: { killAllSync(): void } } | null;
  buildSession: (state: never) => unknown;
  /** SYNC by design — see saveSessionSync's comment and the guard note below. */
  saveSessionSync: (cwd: string, session: never) => unknown;
  stopRemoteControlServer: (v: boolean) => unknown;
  unmount: () => void;
  stampEnvelopeOnExit: () => void;
  exit: (code: number) => void;
  on?: (signal: string, handler: () => void) => void;
  cwd?: () => string;
  /** Injectable for test; defaults to the real marker sink. */
  log?: (name: string, payload: string) => void;
  /** Injectable for test; defaults to reading the live process. */
  readGuard?: (signal: string) => { listeners: number; subscriberCount: number | null };
}

/**
 * Registers one handler per fatal signal. Extracted from three near-identical inline
 * blocks (SIGINT/SIGTERM differed only in exit code) for two reasons, in this order:
 * a fourth copy would have left the new handler as untested as the two it copied —
 * nothing in the suite covered them, because they were registered inside runTui, which
 * renders Ink and awaits waitUntilExit() — and three copies of a persist-then-exit
 * sequence is three places for it to drift.
 *
 * unmount() is wrapped: it runs BEFORE the save and writes escape sequences to stdout,
 * which under SIGHUP is a terminal that has already gone away. An unhandled throw there
 * skipped the save entirely — the exact failure this exists to fix. Wrapping it changes
 * SIGINT and SIGTERM too, deliberately: today a throw there loses the session the same
 * way, on every signal rather than only this one.
 *
 * The save is SYNCHRONOUS and pruneOldSessions is NOT on this path. Ink installs
 * signal-exit (ink.js:238), whose listener force-kills via process.kill(pid, sig) when
 * `process.listeners(sig).length === emitter.count` (signal-exit/index.js:121) — a
 * comparison against a count of foreign subscribers, one of which (restore-cursor)
 * subscribes lazily when the cursor is hidden. When it matches, any in-flight async write
 * dies with the process. Prune is maintenance, not durability; it stays on the normal exit
 * path (below, after waitUntilExit) where the cap is still enforced, and is dropped from
 * here so no I/O sits between the write and the exit.
 *
 * [zone-signal-exit-guard] records both sides of that comparison at signal time, because
 * without it a passing run cannot be told apart from a lucky one: a run where the guard
 * did NOT match would have survived on the old async path too and verifies nothing.
 *
 * CORRECTION (2026-08-01): the paragraph above states the guard correctly but is incomplete
 * read alone. Once ANY handler is registered for a signal — this one included — the guard
 * can never match again: emitter.count does not count subscribers, it counts loaded
 * signal-exit module instances (load(), signal-exit/index.js:154, behind the module-local
 * `loaded` guard at :145-147), and load() also installs exactly one process listener per
 * signal (:158). Every instance adds one listener AND one count together, so
 * listeners.length === emitter.count only holds at zero foreign listeners — a state this
 * handler's own presence rules out, independent of restore-cursor or any other subscriber.
 * The sync write above is real insurance against async-loss modes in general; it has NOT
 * been shown necessary against signal-exit specifically, and by this proof cannot be. One
 * data point stays unexplained under it: a direct kill -HUP after this handler existed
 * (async write, pre-sync-write) produced no session file, which this proof says should have
 * stood down and saved instead. Recorded rather than resolved.
 */
export function registerFatalSignalHandlers(deps: FatalSignalDeps): void {
  const on = deps.on ?? ((sig, h) => { process.on(sig as NodeJS.Signals, h); });
  const cwd = deps.cwd ?? (() => process.cwd());
  const emitLog = deps.log ?? log;
  const readGuard = deps.readGuard ?? ((sig: string) => ({
    listeners: process.listeners(sig as NodeJS.Signals).length,
    // signal-exit stashes its emitter on this process global (signal-exit/index.js:36-42),
    // so the real subscriber count is readable rather than inferred.
    subscriberCount:
      (process as unknown as { __signal_exit_emitter__?: { count?: number } })
        .__signal_exit_emitter__?.count ?? null,
  }));

  for (const [signal, code] of Object.entries(FATAL_SIGNAL_EXIT_CODES)) {
    on(signal, () => {
      const guard = readGuard(signal);
      emitLog("[zone-signal-exit-guard]", JSON.stringify({
        signal,
        listeners: guard.listeners,
        subscriberCount: guard.subscriberCount,
        // The branch of signal-exit's guard this run actually exercised. "kills" is the
        // one that proves the sync write mattered; "stands_down" would have survived the
        // old async path too.
        branch: guard.subscriberCount !== null && guard.listeners === guard.subscriberCount
          ? "kills"
          : "stands_down",
      }));
      deps.getState()?.armedMcpManager?.killAllSync();
      void deps.stopRemoteControlServer(false);
      try {
        deps.unmount();
      } catch { /* terminal may already be gone — must not prevent the save below */ }
      deps.stampEnvelopeOnExit();
      const s = deps.getState();
      if (s && s.transcript.length > 0) {
        let session: unknown;
        let built = false;
        try {
          session = deps.buildSession(s as never);
          built = true;
        } catch (err) {
          try { _reportSaveFailure(err, false, s.sessionId, "build", signal, emitLog); }
          catch { /* reporting itself must not block exit */ }
        }
        if (built) {
          try {
            deps.saveSessionSync(cwd(), session as never);
          } catch (err) {
            try { _reportSaveFailure(err, false, s.sessionId, "write", signal, emitLog); }
            catch { /* reporting itself must not block exit */ }
          }
        }
      }
      deps.exit(code);
    });
  }
}

export async function runTui(
  initialPrompt: string | undefined,
  opts: CliFlags
): Promise<void> {
  // Shield must be the very first action — before loadCliConfig can emit anything.
  // Covers SIGINT/SIGTERM paths via process.on("exit") so the original write fn
  // is always restored before the process terminates.
  const restoreStdout = applyStdoutInterception();
  const restoreStderr = applyStderrInterception();
  process.on("exit", restoreStdout);
  process.on("exit", restoreStderr);

  type CommitData = { filePaths: string[]; message: string; repoPath: string };
  type FeedbackData = { runId: string; sessionId: string; logs: string; version: string; repoPath: string };
  const storeCapture: { state: StoreState | null; lastCommitData: CommitData | null; lastFeedbackData: FeedbackData | null; dispatch: ((action: StoreAction) => void) | null; currentEnvelopeKey?: string | null } = { state: null, lastCommitData: null, lastFeedbackData: null, dispatch: null, currentEnvelopeKey: null };

  const config = loadCliConfig(opts);

  let initialTrustedPrefixes: string[] = [];
  try {
    initialTrustedPrefixes = diskTrustPrefixes(await loadDiskTrust(process.cwd()));
  } catch {
    // non-critical — start with empty trust
  }

  try { await applyDiskKeyFallbacks(config); } catch { /* non-critical */ }

  let diskModelSettings: DiskModelSettings | null = null;
  try {
    diskModelSettings = await loadDiskModel(process.cwd());
    if (diskModelSettings) {
      config.model = diskModelSettings.model;
      config.provider = diskModelSettings.provider as typeof config.provider;
      config.effort = diskModelSettings.effort;
      config.summaryFormat = diskModelSettings.summaryFormat;
      // TUI default: memory on. An explicit persisted false still wins.
      config.memoryEnabled = diskModelSettings.memoryEnabled ?? true;
      config.commitOnSuccess = diskModelSettings.commitOnSuccess ?? false;
      config.webSearchEnabled = diskModelSettings.webSearchEnabled ?? true;
    } else {
      config.memoryEnabled = true;  // no disk file → TUI default is on
      config.commitOnSuccess = false;
      config.webSearchEnabled = true;
    }
  } catch { /* non-critical */ }

  // User-facing hooks: load .zone/hooks.json and check trust
  let initialArmedUserHooks: UserHooksConfig | null = null;
  let initialPendingHookTrust: { config: UserHooksConfig; hash: string; projectPath: string } | null = null;
  try {
    const hooksConfig = await loadDiskHooks(config.repoPath);
    if (hooksConfig?._rawBytes) {
      const hash = hooksConfigHash(hooksConfig._rawBytes);
      if (isHooksTrusted(config.repoPath, hash)) {
        initialArmedUserHooks = hooksConfig;
      } else if (process.env["ZONE_TRUST_HOOKS"] === "all") {
        initialArmedUserHooks = hooksConfig;
        log("[zone-hooks-trust-bypass]", "ZONE_TRUST_HOOKS=all — skipping hash verification (explicit risk escape hatch)");
      } else if (process.stdout.isTTY) {
        initialPendingHookTrust = { config: hooksConfig, hash, projectPath: config.repoPath };
      } else {
        process.stderr.write(
          "[zone-hooks] .zone/hooks.json found but not trust-approved. " +
          "Run zone once interactively (TTY) to review and approve the hooks, " +
          "or set ZONE_TRUST_HOOKS=all to bypass (explicit risk escape hatch).\n"
        );
      }
    }
  } catch { /* non-critical */ }

  // MCP: load .zone/mcp.json and check trust
  let initialArmedMcpManager: McpClientManager | null = null;
  let initialPendingMcpTrust: { config: McpConfig; hash: string; projectPath: string } | null = null;
  try {
    const mcpConfig = await loadDiskMcp(config.repoPath);
    if (mcpConfig?._rawBytes) {
      const hash = mcpConfigHash(mcpConfig._rawBytes);
      if (isMcpTrusted(config.repoPath, hash)) {
        initialArmedMcpManager = await McpClientManager.connect(mcpConfig.mcpServers, config.repoPath);
      } else if (process.env["ZONE_TRUST_MCP"] === "all") {
        initialArmedMcpManager = await McpClientManager.connect(mcpConfig.mcpServers, config.repoPath);
        log("[zone-mcp-trust-bypass]", "ZONE_TRUST_MCP=all — skipping hash verification");
      } else if (process.stdout.isTTY) {
        initialPendingMcpTrust = { config: mcpConfig, hash, projectPath: config.repoPath };
      } else {
        process.stderr.write(
          "[zone-mcp] .zone/mcp.json found but not trust-approved. " +
          "Run zone once interactively (TTY) to review and approve, " +
          "or set ZONE_TRUST_MCP=all to bypass.\n"
        );
      }
    }
  } catch { /* non-critical — MCP failure never crashes startup */ }

  let initialUserCommands: UserCommand[] = [];
  try {
    initialUserCommands = await loadUserCommands(config.repoPath); // NOT process.cwd() — repoPathTrap
  } catch { /* non-critical; loadUserCommands already never throws */ }

  // TUI always records usage under "local-dev" (dispatch.ts never threads userId into
  // runLlmPatchFlow; agentLoop defaults to "local-dev"). Read the same identifier so
  // the displayed "used" matches what checkDailyCap enforces against.
  const USAGE_USER_ID = "local-dev";
  let initialDailyUsedUsd = 0;
  try {
    initialDailyUsedUsd = (await getUsage(USAGE_USER_ID, "day")).totalCostUsd;
  } catch { /* non-critical — badge shows $0 on read error */ }

  let resumedSession: DiskSession | null = null;
  let sessionMissMessage: string | null = null;
  if (opts.resume) {
    try {
      const { session, missMessage } = await _resolveResumeRequest(opts.resume, process.cwd());
      resumedSession = session;
      sessionMissMessage = missMessage;
    } catch (err) {
      process.stderr.write(`Could not load the prior session: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Durable resume: if the CLI set ZONE_RESUME_ENVELOPE_ID (from --resume/--continue),
  // load the envelope and auto-trigger the run once the TUI mounts.
  const envResumeId = process.env["ZONE_RESUME_ENVELOPE_ID"];
  let pendingEnvelopeResume: Awaited<ReturnType<typeof buildResumeFlowInput>> | null = null;
  let initialCarriedQuestion: Extract<import("./store-core.js").PendingQuestion, { kind: "carried" }> | null = null;
  if (envResumeId) {
    delete process.env["ZONE_RESUME_ENVELOPE_ID"];
    try {
      pendingEnvelopeResume = await buildResumeFlowInput(envResumeId, opts, {});
      const action = _resumeStartupAction(pendingEnvelopeResume.resume, pendingEnvelopeResume.task);
      if (action.kind === "await_answer") {
        // Deliberately does NOT set initialPrompt — see _resumeStartupAction.
        initialCarriedQuestion = action.carried;
      } else {
        // Override initialPrompt so App.tsx mounts + auto-triggers the run.
        initialPrompt = action.prompt;
      }
      if (pendingEnvelopeResume.resume?.messagesOmitted) {
        // The user is about to rely on continuity that isn't there. Say so.
        process.stderr.write(
          "resume: the earlier conversation was too large to save and could not be restored — "
          + "only the run summary survives.\n"
        );
      }
    } catch (err) {
      process.stderr.write(`resume: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } else {
    // Passive toast: announce any unrelated interrupted run found in this repo.
    latestResumableEnvelope(process.cwd()).then(env => {
      if (env) {
        storeCapture.dispatch?.({ type: "TOAST_PUSH", entry: {
          id: randomUUID(),
          message: `Interrupted run found (${env.status}) — type /resume to continue`,
          level: "info",
        }});
      }
    }).catch(() => {});
  }

  // Reconciled against the envelope outcome above — a session-lookup miss must not claim
  // "starting fresh" when an envelope resume is about to continue the run anyway.
  const resumeMessage = _composeResumeMessage(sessionMissMessage, !!pendingEnvelopeResume);
  if (resumeMessage) process.stderr.write(`${resumeMessage}\n`);

  // Validate API key only when we're about to make API calls.
  // In no-args (idle) mode the TUI renders without a pending task — defer validation.
  if (initialPrompt !== undefined) {
    try {
      validateCliConfig(config);
    } catch (err) {
      restoreStdout();
      restoreStderr();
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  }

  let instance: ReturnType<typeof render> | undefined;
  let remoteControlServer: RemoteControlServerHandle | null = null;
  let remoteControlBusy = false;

  async function stopRemoteControlServer(announce: boolean): Promise<boolean> {
    const activeServer = remoteControlServer;
    if (!activeServer) {
      return false;
    }

    remoteControlServer = null;
    await activeServer.stop();
    if (announce) {
      emitTranscriptLine(
        storeCapture.dispatch,
        `Remote control server stopped on ${activeServer.host}:${activeServer.port}; token invalidated.`
      );
    }
    return true;
  }

  function onCrash(error: Error): void {
    void stopRemoteControlServer(false);
    instance?.unmount();
    throw error;
  }

  function buildDiskSession(state: StoreState): DiskSession {
    return {
      version: 1,
      sessionId: state.sessionId,
      startedAt: state.sessionStartedAt,
      lastActivityAt: new Date().toISOString(),
      cwd: process.cwd(),
      model: state.statusBar.model,
      transcript: state.transcript,
      totalCostUsd: state.statusBar.costUsd,
      totalTokens: state.statusBar.cumulativeTokens,
      totalElapsedMs: Date.now() - new Date(state.sessionStartedAt).getTime(),
    };
  }

  // Fallback signal handlers — in TTY raw mode Ctrl+C arrives as \x03 in useInput, not SIGINT.
  // These fire in non-TTY contexts (pipes, test runners that send real signals).
  // Durable resume: best-effort backstop — stamp the envelope "unknown" on hard exit
  // so the interrupted run becomes resumable even if the checkpoint writer was in-flight.
  function stampEnvelopeOnExit(): void {
    const s = storeCapture.state;
    const key = storeCapture.currentEnvelopeKey;
    // isRunInFlight, not `=== "running"`: a run parked on a question has left
    // "running" and is exactly the state most likely to be killed while idle.
    if (key && s && isRunInFlight(s.runState)) {
      void stampEnvelopeStatus(key, "unknown", []).catch(() => {});
    }
  }

  registerFatalSignalHandlers({
    getState: () => storeCapture.state as never,
    buildSession: (s) => buildDiskSession(s),
    saveSessionSync: (cwd, session) => saveSessionSync(cwd, session),
    stopRemoteControlServer,
    unmount: () => instance?.unmount(),
    stampEnvelopeOnExit,
    exit: (code) => process.exit(code),
  });
  process.on("uncaughtException", (err) => {
    storeCapture.state?.armedMcpManager?.killAllSync();
    void stopRemoteControlServer(false);
    instance?.unmount();
    console.error(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    storeCapture.state?.armedMcpManager?.killAllSync();
    void stopRemoteControlServer(false);
    instance?.unmount();
    console.error(err);
    process.exit(1);
  });

  const bus = createEventBus();
  // Pre-compute the session ID before React renders. On the first prompt (mount useEffect),
  // storeCapture.state is null → _resolveSessionId falls back to this guaranteed ID.
  // App.tsx receives it as initialSessionId so the store's sessionId matches (same .jsonl file).
  const localSessionId = pendingEnvelopeResume?.sessionId ?? resumedSession?.sessionId ?? randomUUID();
  const runPromptDeps: _RunPromptDeps = { config, storeCapture, bus, localSessionId, pendingEnvelopeResume };
  const runPrompt = (prompt: string, ac: AbortController, mode: TuiMode = "normal", images?: import("../../api/imageUpload.js").ImageAttachment[]): void => {
    void _runPromptImpl(prompt, ac, mode, images, runPromptDeps);
  };

  const onSubmit = (prompt: string, ac: AbortController, mode: TuiMode, images?: import("../../api/imageUpload.js").ImageAttachment[]): void => {
    void runPrompt(prompt, ac, mode, images);
  };

  const onUndoRequest = (): void => {
    void import("./undoCommand.js").then(({ resolveUndoData }) =>
      resolveUndoData(config.repoPath)
    ).then((data) => {
      if (!data) {
        storeCapture.dispatch?.({ type: "TOAST_PUSH",
          entry: { id: randomUUID(), message: "Nothing to undo", level: "info" } });
        return;
      }
      storeCapture.dispatch?.({ type: "UNDO_MODAL_OPEN",
        manifest: data.manifest, driftedPaths: data.driftedPaths });
    }).catch((err: unknown) => {
      storeCapture.dispatch?.({ type: "TOAST_PUSH",
        entry: { id: randomUUID(), message: err instanceof Error ? err.message : String(err), level: "warning" } });
    });
  };

  const onRemoteControlCommand = (argsText: string): void => {
    if (remoteControlBusy) {
      emitTranscriptLine(storeCapture.dispatch, "Remote control command already in progress.");
      return;
    }

    remoteControlBusy = true;
    void (async () => {
      try {
        if (remoteControlServer) {
          await stopRemoteControlServer(true);
          return;
        }

        if (argsText.trim().toLowerCase() === "stop") {
          emitTranscriptLine(storeCapture.dispatch, "Remote control server is not running.");
          return;
        }

        const server = await startRemoteControlServer({
          onEvent: (event) => {
            if (event.type === "client_connected") {
              emitTranscriptLine(
                storeCapture.dispatch,
                `Remote control client connected from ${event.remoteAddress ?? "unknown"}.`
              );
            }
            if (event.type === "client_disconnected") {
              emitTranscriptLine(
                storeCapture.dispatch,
                `Remote control client disconnected (${event.reason || `code ${event.code ?? "unknown"}`}).`
              );
            }
          },
        });
        remoteControlServer = server;
        const adapter = createRemoteControlAdapter({ config, broadcast: server.broadcast });
        server.setBackend(adapter);
        emitRemoteControlBanner(storeCapture.dispatch, server);
      } catch (err) {
        emitTranscriptLine(
          storeCapture.dispatch,
          `Remote control failed to start: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        remoteControlBusy = false;
      }
    })();
  };

  const onEnvelopeResume = (sessionId?: string): void => {
    void (async () => {
      try {
        const envelopeKey = sessionId;
        const env = envelopeKey
          ? await (await import("../../api/diskRunEnvelope.js")).loadRunEnvelope(envelopeKey)
          : await latestResumableEnvelope(process.cwd());
        if (!env) {
          // Nothing to offer — but "nothing found" would be a lie if runs have
          // been set aside, and it is the only place a user would look for them.
          const setAside = (await listResumableEnvelopes(process.cwd())).filter(e => e.dismissedAt);
          storeCapture.dispatch?.({ type: "TOAST_PUSH", entry: { id: randomUUID(),
            message: setAside.length > 0
              ? `No active interrupted run. ${setAside.length} set aside — `
                + setAside.slice(0, 3).map(e => `--resume ${e.key.slice(0, 8)}`).join(", ")
              : "No interrupted run found for this repo.",
            level: "warning" } });
          return;
        }
        storeCapture.dispatch?.({ type: "TOAST_PUSH", entry: { id: randomUUID(),
          message: `Resuming "${env.task.slice(0, 60)}"…`, level: "info" } });
        // Resume by the key the envelope was read from — under per-run keying the
        // filename is a runId, so env.sessionId no longer names its own file.
        const resumeInput = await buildResumeFlowInput(
          envelopeKey ?? (env as { key?: string }).key ?? envelopeKeyFor(env),
          opts,
          {},
        );
        if (resumeInput.resume?.messagesOmitted) {
          storeCapture.dispatch?.({ type: "TOAST_PUSH", entry: { id: randomUUID(),
            message: "Earlier conversation was too large to save — resuming from the summary only.",
            level: "warning" } });
        }
        runPromptDeps.pendingEnvelopeResume = resumeInput;
        const action = _resumeStartupAction(resumeInput.resume, env.task);
        if (action.kind === "await_answer") {
          // Render the question and wait — same rule as --resume at startup.
          storeCapture.dispatch?.({ type: "USER_QUESTION_CARRIED", ...action.carried });
          return;
        }
        onSubmit(action.prompt, new AbortController(), "normal");
      } catch (err: unknown) {
        storeCapture.dispatch?.({ type: "TOAST_PUSH", entry: { id: randomUUID(),
          message: err instanceof Error ? err.message : String(err), level: "warning" } });
      }
    })();
  };

  /**
   * The user answered a question carried over from a previous process.
   *
   * Not a new task and not a resolver call: there is no parked loop to unpark, so
   * this starts the resumed run with the answer threaded onto the stashed flow
   * input. From there resumeAnswer reaches the model by one of two routes —
   * reconcileDanglingToolCalls fills the dangling ask_user reply when the
   * conversation was restored, and the cold-branch kickoff carries it when the
   * conversation was too large to save.
   */
  const onCarriedAnswer = (answer: string, ac: AbortController): void => {
    const pending = runPromptDeps.pendingEnvelopeResume;
    if (!pending?.resume) return;
    pending.resume.answer = answer;
    onSubmit(pending.task, ac, "normal");
  };

  /**
   * The user pressed Esc at a carried-over question.
   *
   * Sets the suspended run aside instead of deleting it: the envelope can be the
   * only copy of staged work, so one unconfirmed keystroke must not destroy it.
   * The toast names the way back rather than merely confirming the dismissal —
   * a recovery route that exists only in a transient toast is not a recovery
   * route, which is why a bare /resume also reports what has been set aside.
   */
  const onCarriedDiscard = (envelopeKey: string, iter: number): void => {
    runPromptDeps.pendingEnvelopeResume = null;
    emitAskUserRefused(_carriedDiscardTelemetry(envelopeKey, iter));
    void (async () => {
      try {
        const { dismissEnvelope } = await import("../../api/diskRunEnvelope.js");
        await dismissEnvelope(envelopeKey);
      } catch { /* best-effort — the question is already off screen */ }
    })();
    storeCapture.dispatch?.({ type: "TOAST_PUSH", entry: {
      id: randomUUID(),
      message: `Set aside — reach it again with --resume ${envelopeKey.slice(0, 8)}`,
      level: "info",
    }});
  };

  // Best-effort GC: delete the prior sessionId's .jsonl when the user clears session memory.
  // Uses config.repoPath — NOT process.cwd() — to find the right .zone/conversations/ dir.
  const clearSessionMemoryGC = async (oldSessionId: string): Promise<void> => {
    try {
      const nodePath = await import("node:path");
      const fsPromises = await import("node:fs/promises");
      const filePath = nodePath.default.join(config.repoPath, ".zone", "conversations", `${oldSessionId}.jsonl`);
      await fsPromises.default.unlink(filePath);
      if (process.env.ZONE_TUI_DEBUG === "1") {
        process.stderr.write(`[zone-session-mem] GC: deleted ${oldSessionId}.jsonl\n`);
      }
    } catch { /* best-effort — missing file or other errors are silently ignored */ }
  };

  writeBannerToStdout({ isResumed: !!resumedSession });

  const initialMode: TuiMode = resolveInitialTuiMode(opts.permissionMode);

  instance = render(
    <ErrorBoundary onCrash={onCrash}>
      <App
        initialPrompt={initialPrompt}
        initialMode={initialMode}
        bus={bus}
        initialModel={config.model}
        capUsd={config.dailyUsdCap}
        initialDailyUsedUsd={initialDailyUsedUsd}
        onSubmit={onSubmit}
        onUndoRequest={onUndoRequest}
        onEnvelopeResume={onEnvelopeResume}
        onCarriedAnswer={onCarriedAnswer}
        onCarriedDiscard={onCarriedDiscard}
        initialCarriedQuestion={initialCarriedQuestion}
        initialTrustedPrefixes={initialTrustedPrefixes}
        resumedSession={resumedSession ?? undefined}
        initialSessionId={localSessionId}
        onStateChange={(s) => { storeCapture.state = s; }}
        initialModelSettings={diskModelSettings}
        initialUserCommands={initialUserCommands}
        initialArmedUserHooks={initialArmedUserHooks}
        initialPendingHookTrust={initialPendingHookTrust}
        initialArmedMcpManager={initialArmedMcpManager}
        initialPendingMcpTrust={initialPendingMcpTrust}
        onModelApply={(model, provider, effort, summaryFormat, memoryEnabled, commitOnSuccess) => {
          config.model = model;
          config.provider = provider as typeof config.provider;
          config.effort = effort;
          config.summaryFormat = summaryFormat;
          config.memoryEnabled = memoryEnabled;
          config.commitOnSuccess = commitOnSuccess ?? false;
        }}
        getCommitData={() => storeCapture.lastCommitData}
        getFeedbackData={() => storeCapture.lastFeedbackData}
        onRemoteControlCommand={onRemoteControlCommand}
        onDispatchCapture={(d) => { storeCapture.dispatch = d; }}
        onSessionClear={(oldId) => void clearSessionMemoryGC(oldId)}
      />
    </ErrorBoundary>,
    { exitOnCtrlC: false, alternateScreen: false }
  );

  // ── Resize controller ────────────────────────────────────────────────────
  // On any column change: clear screen + scrollback, then bump the <Static> key
  // (TRANSCRIPT_REMOUNT) so Ink re-emits the transcript at the new width.
  // Both halves are load-bearing and must stay paired — the remount re-emits the
  // transcript either way, and the clear is what wipes the old copy so the
  // re-emission replaces it instead of appending below it.
  // Widening used to be skipped as "self-correcting"; it is not — see the
  // measured explanation in resize.ts. The cost of acting on it is that widening
  // now discards native scrollback too, the same cost narrowing has always paid.
  let prevCols = process.stdout.columns ?? 80;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  if (process.stdout.isTTY) {
    process.stdout.on("resize", () => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        const nextCols = process.stdout.columns ?? 0;
        if (shouldRedrawOnResize(prevCols, nextCols)) {
          applyResizeRedraw(
            (s) => process.stdout.write(s),
            () => storeCapture.dispatch?.({ type: "TRANSCRIPT_REMOUNT" }),
          );
        }
        prevCols = nextCols; // always update baseline (tracks widening too, no-op for clear)
      }, 100);
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Single path: wait for explicit exit (Ctrl+C → \x03 in useInput → useApp.exit())
  await instance.waitUntilExit();
  await stopRemoteControlServer(false);

  // Graceful MCP shutdown — normal exit path only; signal paths use killAllSync() above.
  await storeCapture.state?.armedMcpManager?.closeAll().catch(() => {});

  const finalState = storeCapture.state;
  let saved = false;
  let saveFailureMessage: string | null = null;
  if (finalState && finalState.transcript.length > 0) {
    let session: DiskSession | null = null;
    try {
      session = buildDiskSession(finalState);
    } catch (err) {
      saveFailureMessage = _reportSaveFailure(err, saved, finalState.sessionId, "build", null, log);
    }
    if (session) {
      try {
        await saveSession(process.cwd(), session);
        saved = true;
        await pruneOldSessions(process.cwd());
      } catch (err) {
        saveFailureMessage = _reportSaveFailure(err, saved, finalState.sessionId, "write", null, log);
      }
    }
  }

  restoreStdout();
  restoreStderr();

  if (saveFailureMessage) process.stderr.write(`${saveFailureMessage}\n`);

  if (finalState) {
    const hint = _buildExitResumeHint(finalState.transcript.length, saved, finalState.sessionId);
    if (hint) process.stderr.write(`${hint}\n`);
  }
}
