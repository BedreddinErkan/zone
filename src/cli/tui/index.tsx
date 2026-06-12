import { randomUUID } from "node:crypto";
import { exec, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { render } from "ink";

const execAsync = promisify(exec);
import { App } from "./App.js";
import { Splash } from "./components/Splash.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import type { CliFlags } from "../config.js";
import { loadCliConfig, validateCliConfig, applyDiskKeyFallbacks } from "../config.js";
import { runOneShotInner, type TuiMode } from "../dispatch.js";
import { ProviderRequestError, PlanRefusalError } from "../../llm/factory.js";
import { resolveInitialTuiMode } from "./initialMode.js";
import type { LlmPatchFlowResult } from "../../core/runLlmPatchFlow.js";
import { createEventBus } from "../eventBus.js";
import { applyStdoutInterception, applyStderrInterception } from "./stdoutShield.js";
import type { LlmPatchProgressUpdate } from "../../core/agentLifecycleEvents.js";
import { loadDiskTrust, diskTrustPrefixes } from "../../api/diskTrust.js";
import { saveSession, pruneOldSessions, loadLastSession, type DiskSession } from "../../api/diskSessions.js";
import { loadDiskModel, type DiskModelSettings } from "../../api/diskModel.js";
import type { StoreState, StoreAction } from "./store.js";
import { deriveCommitMessage, shouldAutoCommit } from "./commitMessage.js";
import { executeCommit } from "./components/CommitModal.js";
import { loadUserCommands, type UserCommand } from "./userCommands.js";
import { shouldRedrawOnResize } from "./resize.js";
import { getUsage } from "../../usage/usageTracker.js";

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
  const RESET = "\x1b[0m";
  const MAGENTA_BOLD = "\x1b[35;1m";
  const DIM = "\x1b[2m";
  const cwd = process.cwd();
  const branch = _getGitBranch();
  const cwdBranch = branch ? `${cwd} · ${branch}` : cwd;
  const resumed = opts.isResumed ? ` ${DIM}(resumed)${RESET}` : "";
  // Model and cap are shown by the reactive <Header> component — not repeated here.
  process.stdout.write(
    `${MAGENTA_BOLD}✦${RESET}  ${MAGENTA_BOLD}Zone v${_zoneVersion}${RESET}${resumed}  ${DIM}${cwdBranch}${RESET}\n\n`
  );
}

/** Strip the well-known banner lines that prefix patchPreview on the agent-loop path. */
function stripBanner(s: string): string {
  return s.replace(/^=== [A-Z ]+===\n/, "");
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
  const { truncateSessionTurn, MAX_CHANGED_FILES, USER_PROMPT_MAX_BYTES } =
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
    const ok = await appendFsConversationEvent({
      repoPath: config.repoPath,   // NOT process.cwd() — repoPathTrap
      threadId: sessionId,
      event: {
        type: "turn",
        ts: Date.now(),
        runId,
        userPrompt: prompt.slice(0, USER_PROMPT_MAX_BYTES),
        summary,
        changedFiles,
        outcome: deriveNeutralOutcome(runResult, changedFiles),
      },
    });
    if (!ok && process.env.ZONE_TUI_DEBUG === "1") {
      process.stderr.write("[zone-session-mem] turn write skipped\n");
    }
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
  const storeCapture: { state: StoreState | null; lastCommitData: CommitData | null; dispatch: ((action: StoreAction) => void) | null } = { state: null, lastCommitData: null, dispatch: null };

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
  if (opts.resume) {
    try {
      resumedSession = await loadLastSession(process.cwd());
      if (!resumedSession) {
        process.stderr.write("No prior session found in this directory; starting fresh.\n");
      }
    } catch (err) {
      process.stderr.write(`Resume failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

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

  function onCrash(error: Error): void {
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
  process.on("SIGINT", () => {
    instance?.unmount();
    const s = storeCapture.state;
    if (s && s.transcript.length > 0) {
      void saveSession(process.cwd(), buildDiskSession(s))
        .then(() => pruneOldSessions(process.cwd()))
        .catch(() => {})
        .finally(() => process.exit(130));
    } else {
      process.exit(130);
    }
  });
  process.on("SIGTERM", () => {
    instance?.unmount();
    const s = storeCapture.state;
    if (s && s.transcript.length > 0) {
      void saveSession(process.cwd(), buildDiskSession(s))
        .then(() => pruneOldSessions(process.cwd()))
        .catch(() => {})
        .finally(() => process.exit(143));
    } else {
      process.exit(143);
    }
  });
  process.on("uncaughtException", (err) => {
    instance?.unmount();
    console.error(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    instance?.unmount();
    console.error(err);
    process.exit(1);
  });

  const bus = createEventBus();

  const runPrompt = async (prompt: string, ac: AbortController, mode: TuiMode = "normal"): Promise<void> => {
    const runId = randomUUID();
    // Capture sessionId at submit time (storeCapture.state may be null on the first render tick).
    const sessionId = storeCapture.state?.sessionId;

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
    try {
      runResult = await runOneShotInner(prompt, config, runId, { externalAc: ac, onProgress, mode, priorSessionSummary });
    } catch (err: unknown) {
      if (err instanceof ProviderRequestError) {
        // Typed provider error (e.g. Fable retention 400): surface as red ErrorLine + failed run-state.
        // emitSafetyNet=false suppresses the finally's agent_loop_complete so RUN_FAILED isn't clobbered by RUN_DONE.
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
        // Mirrors agent-loop §6 content_filter guard and vague-task short-circuit pattern.
        // emitSafetyNet=false prevents the finally safety-net from double-emitting
        // agent_loop_complete and clobbering the cost display with iterCount:0.
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
      // runState would stay "running" forever. Aborted runs are handled by
      // App.tsx Esc handler (RUN_ABORTED dispatch) — skip those.
      // ProviderRequestError sets emitSafetyNet=false because run_failed already handles terminal state.
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
      const daily = await getUsage(USAGE_USER_ID, "day");
      storeCapture.dispatch?.({ type: "DAILY_USED_UPDATE", dailyUsedUsd: daily.totalCostUsd });
    } catch { /* non-critical */ }

    // Write atomic turn record for multi-turn memory (replaces single agent_summary write).
    // Single event per dispatch = atomic in the JSONL log (rotation never splits a turn).
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
  };

  const onSubmit = (prompt: string, ac: AbortController, mode: TuiMode): void => {
    void runPrompt(prompt, ac, mode);
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

  if (process.stdout.isTTY) {
    const splashInst = render(
      <Splash />,
      { exitOnCtrlC: false, alternateScreen: false }
    );
    await splashInst.waitUntilExit();
  }
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
        initialTrustedPrefixes={initialTrustedPrefixes}
        resumedSession={resumedSession ?? undefined}
        onStateChange={(s) => { storeCapture.state = s; }}
        initialModelSettings={diskModelSettings}
        initialUserCommands={initialUserCommands}
        onModelApply={(model, provider, effort, summaryFormat, memoryEnabled, commitOnSuccess) => {
          config.model = model;
          config.provider = provider as typeof config.provider;
          config.effort = effort;
          config.summaryFormat = summaryFormat;
          config.memoryEnabled = memoryEnabled;
          config.commitOnSuccess = commitOnSuccess ?? false;
        }}
        getCommitData={() => storeCapture.lastCommitData}
        onDispatchCapture={(d) => { storeCapture.dispatch = d; }}
        onSessionClear={(oldId) => void clearSessionMemoryGC(oldId)}
      />
    </ErrorBoundary>,
    { exitOnCtrlC: false, alternateScreen: false }
  );

  // ── Resize controller ────────────────────────────────────────────────────
  // On narrowing, full-width live lines reflow into more physical rows than Ink
  // erases → ghost rows. Fix: clear screen + scrollback, then bump the <Static>
  // key (TRANSCRIPT_REMOUNT) so Ink re-emits the transcript cleanly.
  // Widening is self-correcting (Ink over-erases); only narrowing acts.
  let prevCols = process.stdout.columns ?? 80;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  if (process.stdout.isTTY) {
    process.stdout.on("resize", () => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        const nextCols = process.stdout.columns ?? 0;
        if (shouldRedrawOnResize(prevCols, nextCols)) {
          process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clear screen + scrollback + cursor home
          storeCapture.dispatch?.({ type: "TRANSCRIPT_REMOUNT" });
        }
        prevCols = nextCols; // always update baseline (tracks widening too, no-op for clear)
      }, 100);
    });
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Single path: wait for explicit exit (Ctrl+C → \x03 in useInput → useApp.exit())
  await instance.waitUntilExit();

  const finalState = storeCapture.state;
  if (finalState && finalState.transcript.length > 0) {
    try {
      await saveSession(process.cwd(), buildDiskSession(finalState));
      await pruneOldSessions(process.cwd());
    } catch { /* non-critical */ }
  }

  restoreStdout();
  restoreStderr();
}
