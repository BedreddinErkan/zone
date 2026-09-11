import { randomUUID } from "node:crypto";
import type { DiskTrustEntry } from "../../api/diskTrust.js";
import type { DiskApiKey, ApiKeyProvider } from "../../api/diskKeys.js";
import type { ProviderProfile } from "../../llm/providerProfile.js";
import type { DiskSession, SessionMeta } from "../../api/diskSessions.js";
import type { TuiMode } from "../dispatch.js";
import type { DiskModelSettings } from "../../api/diskModel.js";
import { visibleModelRows, selectedIndexForCurrent } from "./modelPickerList.js";
import { supportsEffort, effortLevelsFor, USER_FACING_MODELS, getDefaultModelId } from "../../llm/modelRegistry.js";
import type { EffortLevel } from "../../llm/modelRegistry.js";
import type { LLMProvider } from "../../llm/types.js";
import type { RunTodo, TodoStatus } from "../../core/todoLifecycle.js";
import { startTodo, completeTodo } from "../../core/todoLifecycle.js";
import type { UserCommand } from "./userCommands.js";
import type { StagedFile } from "../../core/fileDiff.js";
import type { UserHooksConfig } from "../../api/diskHooks.js";
import { READ_ONLY_TOOLS } from "../../tools/toolDefinitions.js";

// Local copy, not a mutation of the shared export: READ_ONLY_TOOLS also gates
// EXPLORE_ALLOWED_TOOLS and AUDIT_ALLOWED_TOOLS (subagents.ts) — real subagent
// tool-availability, not just a display concept. AUDIT_ALLOWED_TOOLS's own
// `[...READ_ONLY_TOOLS, "run_command_readonly"]` is direct evidence that tool is
// deliberately excluded from the shared list; adding it here to widen batching
// would silently widen Explore-subagent tool access too. This Set is for
// TUI-display read/write classification only.
const READ_ONLY_TOOL_SET = new Set<string>(READ_ONLY_TOOLS);

// Small, tunable — not deeply derived. Mirrors the "5+ reads is a smell" figure
// already in agentLoop.ts's EFFICIENCY CONTRACT directive.
const READ_ONLY_BATCH_MAX_SIZE = 5;

export type { TuiMode };

export type ToastEntry = {
  id: string;
  message: string;
  level: "info" | "warning" | "error";
};

export type ModalKind = "approval" | "revision";

export type ModalEntry = {
  kind: ModalKind;
  id: string;
  message: string;
};

export type LiveTailState = {
  currentToolCall: { toolName: string; args: string; patch?: string } | null;
  narrationBuffer: string;
  /**
   * Consecutive successful read-only calls, buffered for one collapsed transcript
   * entry instead of one line each. No `ok` field: a failed read-only call is
   * never pushed here at all (it flushes whatever is pending, then commits
   * individually via the ordinary `tool_call` path, so its existing glyph +
   * error-detail rendering is never lost inside a group's count) — so every
   * entry that ever reaches this array is, by construction, a success. `arg`
   * carries the call's identifying detail (path/pattern) so the committed group
   * can render it — dropping it collapses to a bare count with no way to tell
   * what was actually touched.
   */
  pendingReadOnlyBatch: Array<{ toolName: string; arg: string }>;
  /**
   * Live-only preview of the assistant's streamed final-answer text. Set wholesale by
   * STREAMING_ANSWER_SET from a debounced, tail-capped buffer assembled in
   * useAgentEvents.ts — this field itself does no accumulation. Never committed to
   * `transcript`/`<Static>`: ASSISTANT_FINAL remains the sole writer of the authoritative,
   * markdown-formatted entry, so this string is discarded, not promoted, once a turn ends.
   */
  streamingAnswer: string;
};

export type TranscriptEntry =
  | { kind: "narration"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; toolName: string; args: string; patch?: string; results: { ok: boolean; detail: string; blocked?: true }[]; subagentId?: string }
  | { kind: "tool_call_group"; calls: Array<{ toolName: string; arg: string }>; subagentId?: string }
  /** Phase 6c — frozen plan/todo snapshot committed to <Static> via appendEntry.
   *  Rendered as a checklist inside the transcript. A new snapshot is appended on
   *  todos_initialized, todo_revised, and agent_loop_complete (if todos changed). */
  | { kind: "plan_snapshot"; todos: Array<{ id: string; text: string; status: TodoStatus }> }
  | { kind: "error"; text: string }
  | { kind: "user_prompt"; text: string }
  | { kind: "assistant_final"; text: string }
  /** Phase 4c — collapsed summary of earlier transcript entries. Created by appendEntry
   *  when the transcript exceeds COMPACT_THRESHOLD; replaces entries [0..N-101] with one
   *  line carrying aggregate counts so the user sees what happened without storing it all. */
  | { kind: "compact_summary"; totalCompacted: number; counts: { toolCalls: number; narrations: number; errors: number; subagents: number } }
  /** `diffShownInline` lists the paths whose diff a preceding `tool_call` entry already rendered
   *  inline, so the end-of-run block can show its aggregation (header, path, +N/-M) without
   *  repeating a diff body the user has already read. Computed once at dispatch — see the
   *  POST_EXECUTE_DIFFS reducer case — because it is a fact about the transcript at that moment,
   *  not something the renderer should re-derive on every paint. Optional so entries persisted
   *  before this field existed still load. */
  | { kind: "post_execute_diffs"; files: StagedFile[]; diffShownInline?: string[] }
  | {
      kind: "plan_ready";
      // Absent on entries persisted before these two fields existed; the disk loader casts
      // unchecked rather than validating, so absence there is not distinguishable from a bug.
      planId?: string;
      runId?: string;
      objective: string;
      steps: Array<{ title: string; description: string; filesLikely: string[] }>;
      scopeNotes?: string;
      noChangeReason?: string;
      cannotVerifyReason?: string;
      answerOnlyReason?: string;
      riskHints: string[];
      scopeSummary: string;
      /** D1/D3 (plan widening). Absent on entries persisted before this field existed —
       *  same unchecked-load reasoning as planId/runId above. */
      narrative?: string;
      filesLikely?: string[];
    };

export type StatusBarState = {
  iter: number;
  costUsd: number;
  dailyUsedUsd: number;
  capUsd: number;
  model: string;
  tokenBudgetRatio: number;
  cumulativeTokens: number;
};

export type RunState = "idle" | "running" | "done" | "aborted" | "failed" | "awaiting_input";

/**
 * Phase 2c — overlay identifiers. One entry per modal that has migrated from the legacy
 * `modalView` single-slot to the OverlayLayer stack. Kept as a string union rather than a
 * generic string so dispatching an unknown overlay ID is a compile error, not a silent
 * no-op. Extend when a new modal lands in OverlayLayer (Phase 2d will add the remaining
 * twelve entries currently on `modalView`); remove when an overlay is retired.
 */
export type OverlayId =
  | "model"
  | "keys"
  | "metrics"
  | "effort"
  | "summary"
  | "planMode"
  | "session"
  | "sessions"
  | "permissions"
  | "limits"
  | "commit"
  | "feedback"
  | "undo"
  | "trust"
  | "hookTrust"
  | "mcpTrust";

/**
 * The run is still in flight — inference or a human, either way not finished.
 * Anything that resets per-run state on ENTERING a run must use this rather than
 * `=== "running"`, or parking on a question would read as a fresh task.
 */
export function isRunInFlight(runState: RunState): boolean {
  return runState === "running" || runState === "awaiting_input";
}

/**
 * A question awaiting the user, in one of two genuinely different situations.
 *
 * A union rather than one shape with a flag, because the difference is not
 * cosmetic: a "live" question indexes an in-memory registry entry that a parked
 * agent loop is awaiting, and a "carried" one does not — that registry did not
 * survive the process. Giving a carried question an empty questionId would make
 * Composer's Enter call resolveUserQuestion, get "unknown_question_id" back, and
 * silently swallow an answer the user believes they gave. The union makes that
 * state unrepresentable rather than merely tested against, and forces every
 * consumer to say which case it is handling.
 */
export type PendingQuestion =
  | { kind: "live"; questionId: string; runId: string; question: string }
  | {
      kind: "carried";
      question: string;
      /** The dangling ask_user call the answer has to reply to. */
      toolCallId: string;
      /** The run that ASKED — not the run that will answer, which does not exist yet. */
      runId: string;
      iter: number;
      /**
       * The envelope hit the 1MB cap and dropped the conversation. Said before
       * the user types, because answering a question whose conversation is gone
       * is a worse version of losing the question in the first place.
       */
      conversationLost: boolean;
    };

/** Phase 5a — per-subagent thread state for nested transcript rendering. */
export interface SubagentThread {
  subagentId: string;
  subagentType: string;
  title: string;
  status: "running" | "completed" | "failed";
  toolCallCount: number;
  costUsd?: number;
  iterations?: number;
  summary?: string;
}

/** Phase 6a — config-as-state. The store is the single source of truth for anything the TUI
 *  reads; disk is a persistence effect; runs consume an immutable snapshot taken at run start.
 *  Fields mirror the mutable subset of CliConfig so that onModelApply and key fallbacks route
 *  through CONFIG_PATCHED instead of mutating the original object. */
export interface RunConfigShape {
  model: string;
  provider: LLMProvider;
  profile?: ProviderProfile;
  profileApiKey?: string;
  pendingProfileId?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  effort?: EffortLevel;
  summaryFormat?: "compact" | "detailed";
  memoryEnabled?: boolean;
  commitOnSuccess?: boolean;
  webSearchEnabled?: boolean;
  dailyCapUsd: number;
}

/** Phase 7a — boot-time identity/context snapshot. Collected once at runTui startup,
 *  committed to Static via WelcomeFrame. Every field has a safe fallback — a broken git or
 *  missing CHANGELOG must never block boot. */
export interface BootData {
  version: string;
  user: string;
  repoPath: string;
  branch: string;
  model: string;
  provider: string;
  dailyCapUsd: number;
  keySource: "byok" | "gateway";
  whatsNew: string[];
}

export type StoreState = {
  /** Phase 6a — immutable config snapshot. Mutated only via CONFIG_PATCHED. */
  config: RunConfigShape;
  /** Phase 7a — boot-time identity/context. Set once at startup via BOOT_SET. */
  boot: BootData | null;
  transcript: TranscriptEntry[];
  sessionId: string;
  sessionStartedAt: string;
  isResumed: boolean;
  liveTail: LiveTailState;
  spinner: { active: boolean; label: string } | null;
  /** Label of the last SPINNER_START, so SPINNER_RESUME can restore it after a transient one. */
  spinnerBaseLabel?: string;
  /** Phase 5a — subagent thread registry. Keyed by subagentId. */
  subagentThreads: Record<string, SubagentThread>;
  /** Phase 5a — currently active subagent (for tool_call tagging by interval inference). */
  currentSubagentId: string | null;
  /** Phase 5c — spinner label stack. Pushed on SUBAGENT_STARTED, popped on COMPLETED. */
  parentSpinnerLabels: string[];
  statusBar: StatusBarState;
  runState: RunState;
  /** Wall-clock start of the CURRENT task (reset per run, not per session). */
  runStartMs?: number;
  /** Wall-clock completion of the last task — frozen so the displayed duration
   *  doesn't keep ticking while the "done" status is shown. */
  runEndMs?: number;
  /**
   * Wall-clock spent parked on a human this run, accumulated across parks.
   * Subtracted from the reported duration: a run that waited an hour for an
   * answer would otherwise report an hour of work, which corrupts latency
   * telemetry across exactly the boundary this feature introduces. Reported
   * alongside rather than hidden, so wall-clock stays derivable and a long
   * pause reads as a pause instead of as slow inference.
   */
  parkedMs: number;
  /** Start of the current park; undefined when not parked. */
  parkStartedMs?: number;
  toastQueue: ToastEntry[];
  modalStack: ModalEntry[];
  pendingApproval: { approvalId: string; runId: string; command: string; kind?: "command" | "edit" | "trust" | "mcp"; subagentId?: string } | null;
  /**
   * A question the agent is parked on. Deliberately NOT pendingApproval: that
   * field hard-blocks the Composer (Composer.tsx returns early while it is
   * non-null), and a question needs the Composer live to be answered.
   */
  pendingQuestion: PendingQuestion | null;
  sessionTrustedPrefixes: string[];
  mode: TuiMode;
  planProposal: {
    revisionId: string;
    runId: string;
    revisionType: "under_scope" | "over_scope" | "mixed";
    revisionReason: string;
    originalPlan: string;
    revisedPlanSummary: string;
    missingFiles?: string[];
    unnecessaryFiles?: string[];
  } | null;
  modalView: "none" | "permissions" | "keys" | "sessions" | "plan" | "model" | "effort" | "metrics" | "limits" | "plan_ready" | "staged_diffs" | "summary" | "session" | "commit" | "planMode" | "undo" | "feedback";
  /**
   * Phase 2c — overlay stack. Replaces the single-slot `modalView` for the modals that
   * migrate to OverlayShell. Stack semantics (push/pop/clear) so a modal that opens another
   * (e.g. model picker → gateway picker) keeps the parent alive beneath. Old `modalView`
   * is retained for the 12 modals that have NOT migrated yet (Phase 2d); both coexist
   * during the migration and `selectIsBlockingModalOpen` reads both.
   */
  overlayStack: OverlayId[];
  /** Phase 3b — true when the top overlay's content component is in a text-input or confirm
   *  sub-state. While true, the central Esc handler defers to the component's own useInput;
   *  when false, the central handler pops the overlay on Esc. Reset to false on every
   *  OVERLAY_PUSH and OVERLAY_POP so a layer change always starts with a clean sub-mode. */
  overlaySubModeOpen: boolean;
  undoModalData: { manifest: import("../../snapshots/snapshotStore.js").SnapshotManifest; driftedPaths: string[] } | null;
  planModeSelectedIndex: number;
  commitData: { filePaths: string[]; message: string; repoPath: string } | null;
  feedbackData: { runId: string; sessionId: string; logs: string; version: string; repoPath: string } | null;
  summarySelectedIndex: number;
  memorySelectedIndex: number;
  planReadyProposal: {
    planId: string;
    runId: string;
    objective: string;
    steps: Array<{ title: string; description: string; filesLikely: string[] }>;
    scopeNotes?: string;
    noChangeReason?: string;
    cannotVerifyReason?: string;
    answerOnlyReason?: string;
    riskHints: string[];
    scopeSummary: string;
    /** D1/D3 (plan widening). */
    narrative?: string;
    filesLikely?: string[];
  } | null;
  stagedDiffProposal: {
    approvalId: string;
    runId: string;
    files: StagedFile[];
    verificationSummary: string;
    trigger: string;
  } | null;
  modelSettings: DiskModelSettings | null;
  modelSelectedIndex: number;
  /** Free-text model entry. `pick-gateway` is reached ONLY when more than one gateway is
   *  configured — with exactly one the routing is shown and confirmed, never chosen. */
  modelCustomMode: "none" | "input" | "pick-gateway";
  modelCustomInput: string;
  modelGatewayIndex: number;
  /** Providers with a resolved API key, from the SAME CliConfig the run uses — env var, config
   *  file, or ~/.zone/keys.json, all three already collapsed by loadCliConfig +
   *  applyDiskKeyFallbacks before the tree mounts. Empty means no key anywhere, not "not checked
   *  yet": the picker shows every row in that case. */
  providersWithKey: string[];
  /** Gateway profile ids from the key store — the subset of `providersWithKey` that is not a
   *  vendor. Its LENGTH is what decides the free-text flow: zero refuses, one displays, many pick. */
  gatewayIds: string[];
  /** The run's active provider profile, when one is configured. Read by Composer's image gate so a
   *  profile can declare vision support for a model no catalog knows — the half of ledger item 394
   *  that has to land with `supportsVision`'s default flip, not after it. */
  activeProfile: ProviderProfile | null;
  effortSelectedIndex: number;
  permissionsList: DiskTrustEntry[];
  permissionsSelectedIndex: number;
  keysList: DiskApiKey[];
  keysSelectedIndex: number;
  /** `input-profile-id` and `input-base-url` are the gateway flow's two extra steps; the vendor
   *  flow still goes `select-provider` -> `input` in one hop. */
  keysEditMode:
    | "view"
    | "select-provider"
    | "input-profile-id"
    | "input-base-url"
    | "input"
    | "confirm-delete"
    // The optional pricing sub-flow. Reached after a gateway key saves, or via P on a priced-able
    // row — never inserted into the id -> url -> key chain, which stays exactly three steps.
    | "price-model-id"
    | "price-input"
    | "price-output"
    | "price-cache-read"
    | "price-cache-write";
  keysEditInput: string;
  keysEditProvider: ApiKeyProvider | null;
  /** Gateway draft, carried across the three input steps. Empty for a vendor key, which is what
   *  `setDiskKey` keys on to decide whether to write the gateway fields at all. */
  keysDraftProfileId: string;
  keysDraftBaseUrl: string;
  /** The row the pricing sub-flow is editing, and the prices collected so far. `keysPriceDraft`
   *  omits a cache bucket the user skipped, which is what makes skipped distinguishable from a
   *  typed zero all the way to disk. */
  keysPriceProvider: string;
  keysPriceModelId: string;
  keysPriceDraft: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  sessionsList: SessionMeta[];
  sessionsSelectedIndex: number;
  transcriptGeneration: number;
  todos: RunTodo[];
  userCommands: UserCommand[];
  /** Armed hook config (trust-verified in-memory snapshot). Null = disarmed. */
  armedUserHooks: UserHooksConfig | null;
  /** Non-null when hooks.json was found but not yet approved — triggers HookTrustModal. */
  pendingHookTrust: { config: UserHooksConfig; hash: string; projectPath: string } | null;
  /** Armed MCP client manager (trust-verified, servers connected). Null = disconnected. */
  armedMcpManager: import("../../mcp/mcpClientManager.js").McpClientManager | null;
  /** Non-null when mcp.json was found but not yet approved — triggers McpTrustModal. */
  pendingMcpTrust: { config: import("../../api/diskMcp.js").McpConfig; hash: string; projectPath: string } | null;
};

export function buildInitialState(initialValues?: {
  model: string;
  capUsd: number;
  dailyUsedUsd?: number;
  trustedPrefixes?: string[];
  resumedTranscript?: TranscriptEntry[];
  resumedSessionId?: string;
  resumedStartedAt?: string;
  modelSettings?: DiskModelSettings | null;
  providersWithKey?: string[];
  gatewayIds?: string[];
  activeProfile?: ProviderProfile | null;
  userCommands?: UserCommand[];
  mode?: TuiMode;
  armedUserHooks?: UserHooksConfig | null;
  pendingHookTrust?: { config: UserHooksConfig; hash: string; projectPath: string } | null;
  armedMcpManager?: import("../../mcp/mcpClientManager.js").McpClientManager | null;
  pendingMcpTrust?: { config: import("../../api/diskMcp.js").McpConfig; hash: string; projectPath: string } | null;
  /** --resume/--continue landing on an envelope that stopped mid-question. */
  carriedQuestion?: Extract<PendingQuestion, { kind: "carried" }> | null;
  /** Test-only seed for the live streaming-answer preview (frame-cost measurement harness). */
  seedStreamingAnswer?: string;
  /** Phase 6a — initial config snapshot from CliConfig. Required at startup. */
  initialConfig?: RunConfigShape;
  /** Phase 7a — boot-time identity/context. Collected once at runTui startup. */
  initialBoot?: BootData | null;
}): StoreState {
  // Phase 6a — config-as-state: the store owns the config snapshot. If no initial config
  // is provided (tests), construct a minimal default.
  const config: RunConfigShape = initialValues?.initialConfig ?? {
    model: initialValues?.model ?? "",
    provider: "anthropic" as LLMProvider,
    dailyCapUsd: initialValues?.capUsd ?? 10,
  };
  return {
    config,
    boot: initialValues?.initialBoot ?? null,
    transcript: initialValues?.resumedTranscript ?? [],
    sessionId: initialValues?.resumedSessionId ?? randomUUID(),
    sessionStartedAt: initialValues?.resumedStartedAt ?? new Date().toISOString(),
    isResumed: !!initialValues?.resumedTranscript,
    liveTail: {
      currentToolCall: null,
      narrationBuffer: "",
      pendingReadOnlyBatch: [],
      streamingAnswer: initialValues?.seedStreamingAnswer ?? "",
    },
    spinner: null,
    subagentThreads: {},
    currentSubagentId: null,
    parentSpinnerLabels: [],
    statusBar: {
      iter: 0,
      costUsd: 0,
      dailyUsedUsd: initialValues?.dailyUsedUsd ?? 0,
      capUsd: initialValues?.capUsd ?? 10,
      model: initialValues?.modelSettings?.model ?? initialValues?.model ?? "",
      tokenBudgetRatio: 0,
      cumulativeTokens: 0,
    },
    // A carried question means the session opens already waiting on the user, so
    // the status line says "waiting for you" rather than "idle" next to a
    // question nobody appears to be waiting for.
    runState: initialValues?.carriedQuestion ? "awaiting_input" : "idle",
    runStartMs: undefined,
    runEndMs: undefined,
    parkedMs: 0,
    parkStartedMs: undefined,
    toastQueue: [],
    modalStack: [],
    pendingApproval: null,
    pendingQuestion: initialValues?.carriedQuestion ?? null,
    sessionTrustedPrefixes: initialValues?.trustedPrefixes ?? [],
    mode: initialValues?.mode ?? "normal",
    planProposal: null,
    planReadyProposal: null,
    stagedDiffProposal: null,
    modalView: "none",
    commitData: null,
    feedbackData: null,
    modelSettings: initialValues?.modelSettings ?? null,
    modelSelectedIndex: 0,
    modelCustomMode: "none",
    modelCustomInput: "",
    modelGatewayIndex: 0,
    providersWithKey: initialValues?.providersWithKey ?? [],
    gatewayIds: initialValues?.gatewayIds ?? [],
    activeProfile: initialValues?.activeProfile ?? null,
    effortSelectedIndex: 1,
    summarySelectedIndex: 0,
    planModeSelectedIndex: 0,
    memorySelectedIndex: 0,
    permissionsList: [],
    permissionsSelectedIndex: 0,
    keysList: [],
    keysSelectedIndex: 0,
    keysEditMode: "view",
    keysEditInput: "",
    keysEditProvider: null,
    keysDraftProfileId: "",
    keysDraftBaseUrl: "",
    keysPriceProvider: "",
    keysPriceModelId: "",
    keysPriceDraft: {},
    sessionsList: [],
    sessionsSelectedIndex: 0,
    transcriptGeneration: 0,
    todos: [],
    userCommands: initialValues?.userCommands ?? [],
    undoModalData: null,
    armedUserHooks: initialValues?.armedUserHooks ?? null,
    pendingHookTrust: initialValues?.pendingHookTrust ?? null,
    armedMcpManager: initialValues?.armedMcpManager ?? null,
    pendingMcpTrust: initialValues?.pendingMcpTrust ?? null,
    // Phase 2d — trust modals render through the OverlayLayer stack. If the initial state
    // includes pending hook/MCP trust decisions (startup-time checks), push them so
    // OverlayLayer renders the right HookTrustPrompt/McpTrustPrompt content component.
    // Project-trust approvals (kind: "trust") arrive during the session via
    // PENDING_APPROVAL_SET, which pushes "trust" in the reducer.
    overlayStack: [
      ...(initialValues?.pendingHookTrust ? ["hookTrust" as const] : []),
      ...(initialValues?.pendingMcpTrust ? ["mcpTrust" as const] : []),
    ],
    overlaySubModeOpen: false,
  };
}

export type StoreAction =
  // Phase 6a — config-as-state. CONFIG_PATCHED merges a partial config update immutably.
  // CONFIG_PERSISTED is dispatched after the disk write succeeds (informational only).
  | { type: "CONFIG_PATCHED"; patch: Partial<RunConfigShape> }
  | { type: "CONFIG_PERSISTED"; path: string }
  | { type: "BOOT_SET"; boot: BootData }
  | { type: "SPINNER_START"; label: string }
  | { type: "SPINNER_UPDATE"; label: string }
  | { type: "SPINNER_RESUME" }
  | { type: "SPINNER_STOP" }
  | { type: "TRANSCRIPT_APPEND_NARRATION"; text: string }
  | { type: "TRANSCRIPT_ADD_THINKING"; text: string }
  | { type: "TOOL_CALL_OPEN"; toolName: string; args: string; patch?: string }
  | { type: "TOOL_RESULT_PUSH"; ok: boolean; detail: string; blocked?: true }
  | { type: "TOOL_CALL_CLOSE" }
  | { type: "STATUS_UPDATE"; iter?: number; costUsd?: number; tokenBudgetRatio?: number; tokens?: number }
  | { type: "DAILY_USED_UPDATE"; dailyUsedUsd: number }
  | { type: "TOAST_PUSH"; entry: ToastEntry }
  | { type: "TOAST_POP" }
  | { type: "STREAMING_ANSWER_SET"; text: string }
  | { type: "ERROR_LINE"; text: string }
  | { type: "RUN_DONE" }
  | { type: "RUN_ABORTED" }
  | { type: "RUN_FAILED" }
  | { type: "USER_PROMPT"; text: string }
  | { type: "ASSISTANT_FINAL"; text: string }
  | { type: "TRANSCRIPT_CLEAR" }
  | { type: "TRANSCRIPT_REMOUNT" }
  | { type: "PENDING_APPROVAL_SET"; approvalId: string; runId: string; command: string; kind?: "command" | "edit" | "trust" | "mcp"; subagentId?: string }
  | { type: "PENDING_APPROVAL_RESOLVED" }
  // Phase 5a — subagent lifecycle. STARTED creates a thread + sets currentSubagentId for
  // tool_call tagging. COMPLETED updates status/cost/summary + clears currentSubagentId.
  | { type: "SUBAGENT_STARTED"; subagentId: string; subagentType: string; title: string }
  | { type: "SUBAGENT_COMPLETED"; subagentId: string; status: "completed" | "failed"; costUsd?: number; iterations?: number; summary?: string }
  | { type: "USER_QUESTION_ASKED"; questionId: string; runId: string; question: string }
  | {
      type: "USER_QUESTION_CARRIED";
      question: string;
      toolCallId: string;
      runId: string;
      iter: number;
      conversationLost: boolean;
    }
  | { type: "USER_QUESTION_RESOLVED"; echo?: string }
  | { type: "USER_QUESTION_DISMISSED" }
  | { type: "SESSION_TRUST_PREFIX"; prefix: string }
  | { type: "PERMISSIONS_OPEN"; list: DiskTrustEntry[] }
  | { type: "PERMISSIONS_CLOSE" }
  | { type: "PERMISSIONS_NAV"; direction: "up" | "down" }
  | { type: "PERMISSIONS_REMOVE_SELECTED" }
  | { type: "KEYS_OPEN"; list: DiskApiKey[] }
  | { type: "KEYS_CLOSE" }
  | { type: "KEYS_NAV"; direction: "up" | "down" }
  | { type: "KEYS_START_ADD" }
  | { type: "KEYS_START_EDIT"; provider: ApiKeyProvider }
  | { type: "KEYS_PROVIDER_SELECTED"; provider: ApiKeyProvider }
  | { type: "KEYS_INPUT_CHAR"; ch: string }
  | { type: "KEYS_INPUT_BACKSPACE" }
  | { type: "KEYS_INPUT_CANCEL" }
  | { type: "KEYS_GATEWAY_START" }
  | { type: "KEYS_GATEWAY_ID_SUBMIT" }
  | { type: "KEYS_GATEWAY_URL_SUBMIT" }
  | { type: "KEYS_PRICE_START"; provider: string }
  | { type: "KEYS_PRICE_MODEL_SUBMIT" }
  | { type: "KEYS_PRICE_NUMBER_SUBMIT"; field: "input" | "output" | "cache_read" | "cache_write"; value: number }
  | { type: "KEYS_PRICE_SKIP"; field: "cache_read" | "cache_write" }
  | { type: "KEYS_PRICE_CANCEL" }
  | { type: "KEYS_START_DELETE" }
  | { type: "KEYS_DELETE_CANCELED" }
  | { type: "SESSIONS_OPEN"; list: SessionMeta[] }
  | { type: "SESSIONS_CLOSE" }
  | { type: "SESSIONS_NAV"; direction: "up" | "down" }
  | { type: "SESSION_RESUME"; session: DiskSession }
  | { type: "MODE_CYCLE" }
  | { type: "MODEL_MODAL_OPEN" }
  | { type: "MODEL_MODAL_CLOSE" }
  | { type: "MODEL_APPLY"; settings: DiskModelSettings }
  | { type: "MODEL_NAV"; direction: "up" | "down"; count: number }
  | { type: "MODEL_CUSTOM_START" }
  | { type: "MODEL_CUSTOM_CHAR"; ch: string }
  | { type: "MODEL_CUSTOM_BACKSPACE" }
  | { type: "MODEL_CUSTOM_CANCEL" }
  | { type: "MODEL_CUSTOM_PICK_GATEWAY" }
  | { type: "MODEL_GATEWAY_NAV"; direction: "up" | "down" }
  | { type: "EFFORT_MODAL_OPEN" }
  | { type: "EFFORT_MODAL_CLOSE" }
  | { type: "EFFORT_APPLY"; effort: EffortLevel }
  | { type: "EFFORT_NAV"; direction: "up" | "down" }
  | { type: "SUMMARY_MODAL_OPEN" }
  | { type: "SUMMARY_MODAL_CLOSE" }
  | { type: "SUMMARY_APPLY"; summaryFormat: "compact" | "detailed" }
  | { type: "SUMMARY_NAV"; direction: "up" | "down" }
  | { type: "PLANMODE_MODAL_OPEN" }
  | { type: "PLANMODE_MODAL_CLOSE" }
  | { type: "PLANMODE_APPLY"; planDepth: "investigate" | "quick" | "strict" }
  | { type: "PLANMODE_NAV"; direction: "up" | "down" }
  | { type: "MEMORY_MODAL_OPEN" }
  | { type: "MEMORY_MODAL_CLOSE" }
  | { type: "MEMORY_APPLY"; memoryEnabled: boolean }
  | { type: "MEMORY_NAV"; direction: "up" | "down" }
  | { type: "SESSION_MEMORY_CLEAR"; newSessionId: string }
  | { type: "METRICS_MODAL_OPEN" }
  | { type: "METRICS_MODAL_CLOSE" }
  | { type: "LIMITS_MODAL_OPEN" }
  | { type: "LIMITS_MODAL_CLOSE" }
  | { type: "LIMITS_APPLY"; capUsd: number }
  | {
      type: "PLAN_PROPOSED";
      revisionId: string;
      runId: string;
      revisionType: "under_scope" | "over_scope" | "mixed";
      revisionReason: string;
      originalPlan: string;
      revisedPlanSummary: string;
      missingFiles?: string[];
      unnecessaryFiles?: string[];
    }
  | { type: "PLAN_RESOLVED" }
  | {
      type: "PLAN_READY_PROPOSED";
      planId: string;
      runId: string;
      objective: string;
      steps: Array<{ title: string; description: string; filesLikely: string[] }>;
      scopeNotes?: string;
      noChangeReason?: string;
      cannotVerifyReason?: string;
      answerOnlyReason?: string;
      riskHints: string[];
      scopeSummary: string;
      /** D1/D3 (plan widening). */
      narrative?: string;
      filesLikely?: string[];
    }
  | { type: "PLAN_READY_RESOLVED" }
  | {
      type: "STAGED_DIFFS_PROPOSED";
      approvalId: string;
      runId: string;
      files: StagedFile[];
      verificationSummary: string;
      trigger: string;
    }
  | { type: "STAGED_DIFFS_RESOLVED" }
  | { type: "NARRATION_COMMIT" }
  | { type: "COMMIT_MODAL_OPEN"; filePaths: string[]; message: string; repoPath: string }
  | { type: "COMMIT_MODAL_CLOSE" }
  | { type: "FEEDBACK_MODAL_OPEN"; runId: string; sessionId: string; logs: string; version: string; repoPath: string }
  | { type: "FEEDBACK_MODAL_CLOSE" }
  | { type: "UNDO_MODAL_OPEN"; manifest: import("../../snapshots/snapshotStore.js").SnapshotManifest; driftedPaths: string[] }
  | { type: "UNDO_MODAL_CLOSE" }
  | { type: "AUTOCOMMIT_APPLY"; commitOnSuccess: boolean }
  | { type: "WEBSEARCH_APPLY"; webSearchEnabled: boolean }
  | { type: "TODOS_SET"; todos: RunTodo[] }
  | { type: "TODO_STATUS_SET"; todoId: string; status: TodoStatus }
  | { type: "POST_EXECUTE_DIFFS"; files: StagedFile[] }
  | { type: "HOOKS_TRUST_APPROVED"; hash: string; projectPath: string }
  | { type: "HOOKS_TRUST_DENIED" }
  | { type: "MCP_TRUST_APPROVED"; manager: import("../../mcp/mcpClientManager.js").McpClientManager }
  | { type: "MCP_TRUST_DENIED" }
  // Phase 2c — overlay stack management. OVERLAY_PUSH appends (stack semantics, so the same
  // id can legitimately appear twice if a modal re-opens itself); OVERLAY_POP removes the
  // top entry regardless of id (the central Esc handler's job is "close what's on top", not
  // "close a specific id"); OVERLAY_CLEAR empties the whole stack (used by RUN_DONE so a
  // run ending does not leave a stale overlay parked on screen).
  | { type: "OVERLAY_PUSH"; overlayId: OverlayId }
  | { type: "OVERLAY_POP" }
  | { type: "OVERLAY_CLEAR" }
  // Phase 3b — sub-mode flag. Content components dispatch OPEN when entering a text-input
  // or confirm sub-state (so the central Esc handler defers to the component's own Esc);
  // CLOSE when leaving (so the central handler regains Esc ownership for the overlay pop).
  | { type: "OVERLAY_SUBMODE_OPEN" }
  | { type: "OVERLAY_SUBMODE_CLOSE" };

/**
 * Commits the pending read-only batch as one `tool_call_group` transcript entry,
 * a no-op when nothing is buffered. Centralized so every call site — the
 * write-open flush, the size-cap flush, the failed-read flush, and every
 * terminal/pause transition below — builds the exact same entry shape and can
 * never forget to also clear the buffer.
 */
function flushReadOnlyBatch(state: StoreState): StoreState {
  const { pendingReadOnlyBatch } = state.liveTail;
  if (pendingReadOnlyBatch.length === 0) return state;
  const entry: TranscriptEntry = {
    kind: "tool_call_group",
    calls: pendingReadOnlyBatch,
    // Phase 5a — tag with current subagent if one is active.
    ...(state.currentSubagentId ? { subagentId: state.currentSubagentId } : {}),
  };
  return {
    ...appendEntry(state, entry),
    liveTail: { ...state.liveTail, pendingReadOnlyBatch: [] },
  };
}

/** Tools whose `tool_call` entry renders an inline DiffView. Mirrors ToolCall.tsx's own
 *  DIFF_TOOLS — the two must agree, since diffShownInline below predicts what that component
 *  rendered. */
const INLINE_DIFF_TOOLS = new Set(["apply_patch", "write_file", "multi_edit"]);

/**
 * Paths in `files` whose diff a preceding `tool_call` entry has already rendered inline.
 *
 * The predicate mirrors ToolCall.tsx's render gate exactly — diff-capable tool, a patch present,
 * and a last result that is ok and not blocked — because a mismatch in either direction is a
 * visible defect: too loose suppresses a diff the user never saw, too strict brings the duplicate
 * back. Matching on `args` is what keeps the two shapes that genuinely need the end-of-run diff:
 * a write_file overwriting an existing file carries no patch (buildToolCallPatch only builds one
 * for new files), and multi_edit's args is a summary string ("N files · find=…"), never a path,
 * so neither can match here and both keep showing their diff.
 */
function diffsAlreadyShownInline(transcript: TranscriptEntry[], files: StagedFile[]): string[] {
  const shown = new Set<string>();
  for (const entry of transcript) {
    if (entry.kind !== "tool_call") continue;
    if (!INLINE_DIFF_TOOLS.has(entry.toolName) || !entry.patch) continue;
    const last = entry.results[entry.results.length - 1];
    if (!last?.ok || last.blocked) continue;
    shown.add(entry.args);
  }
  return files.map((f) => f.path).filter((p) => shown.has(p));
}

/** Phase 4c — transcript cap. The transcript never grows beyond TRANSCRIPT_CAP entries.
 *  When it exceeds COMPACT_THRESHOLD, the oldest entries are collapsed into a single
 *  compact_summary entry carrying aggregate counts. The 100-entry tail is kept verbatim
 *  so recent context is always available. */
const TRANSCRIPT_CAP = 500;
const COMPACT_THRESHOLD = 400;
const COMPACT_TAIL_SIZE = 100;

/** Appends a transcript entry and enforces the cap. If the transcript exceeds
 *  COMPACT_THRESHOLD after appending, the oldest entries are collapsed into a
 *  compact_summary and the last COMPACT_TAIL_SIZE entries are kept verbatim.
 *  If (somehow) the transcript still exceeds TRANSCRIPT_CAP, the oldest entries
 *  beyond the cap are silently dropped. */
function appendEntry(state: StoreState, entry: TranscriptEntry): StoreState {
  let transcript = [...state.transcript, entry];

  if (transcript.length > COMPACT_THRESHOLD) {
    const compactCount = transcript.length - COMPACT_TAIL_SIZE;
    if (compactCount > 0) {
      const toCompact = transcript.slice(0, compactCount);
      const counts = { toolCalls: 0, narrations: 0, errors: 0, subagents: 0 };
      for (const e of toCompact) {
        if (e.kind === "tool_call" || e.kind === "tool_call_group") counts.toolCalls++;
        else if (e.kind === "narration") counts.narrations++;
        else if (e.kind === "error") counts.errors++;
      }
      // If there's already a compact_summary at position 0, fold its counts in
      if (toCompact[0]?.kind === "compact_summary") {
        counts.toolCalls += toCompact[0].counts.toolCalls;
        counts.narrations += toCompact[0].counts.narrations;
        counts.errors += toCompact[0].counts.errors;
        counts.subagents += toCompact[0].counts.subagents;
      }
      const summary: TranscriptEntry = {
        kind: "compact_summary",
        totalCompacted: compactCount,
        counts,
      };
      transcript = [summary, ...transcript.slice(compactCount)];
    }
  }

  // Hard cap safety — should never trigger if compaction works correctly
  if (transcript.length > TRANSCRIPT_CAP) {
    transcript = transcript.slice(transcript.length - TRANSCRIPT_CAP);
  }

  return { ...state, transcript };
}

/** Phase 6c — appends a plan_snapshot transcript entry if the todos differ from the
 *  last snapshot. Returns the new state (with the appended entry) or the original
 *  state if no append was needed. */
function maybeAppendPlanSnapshot(state: StoreState, todos: RunTodo[]): StoreState {
  if (todos.length === 0) return state;
  const snapshotTodos = todos.map(t => ({ id: t.id, text: t.text, status: t.status }));
  // Check if the last transcript entry is already an identical snapshot
  const lastEntry = state.transcript[state.transcript.length - 1];
  if (lastEntry?.kind === "plan_snapshot") {
    const lastTodos = lastEntry.todos;
    if (lastTodos.length === snapshotTodos.length &&
        lastTodos.every((t, i) => t.id === snapshotTodos[i]!.id && t.status === snapshotTodos[i]!.status)) {
      return state; // No change — skip append
    }
  }
  return appendEntry(state, { kind: "plan_snapshot", todos: snapshotTodos });
}

/** Phase 6a — constructs an immutable config snapshot from the current store state.
 *  Runs consume this snapshot at startup; mid-run CONFIG_PATCHED changes apply to the
 *  NEXT run, never the current one. The returned object is a fresh copy each time. */
export function buildRunConfig(state: StoreState): RunConfigShape {
  return { ...state.config };
}

export function reducer(state: StoreState, action: StoreAction): StoreState {
  switch (action.type) {
    // Phase 6a — config-as-state. Immutable merge; the old config object is never mutated.
    case "CONFIG_PATCHED":
      return { ...state, config: { ...state.config, ...action.patch } };
    case "CONFIG_PERSISTED":
      // Informational only — the disk write succeeded. No state change needed.
      return state;
    // Phase 7a — boot-time identity/context. Set once; WelcomeFrame reads it and Static-commits.
    case "BOOT_SET":
      return { ...state, boot: action.boot };

    case "SPINNER_START":
      return {
        ...state,
        spinner: { active: true, label: action.label },
        // Remembered so a transient label (compaction) can hand the spinner BACK to whatever was
        // standing, rather than to a generic constant. Restoring a specific label with a vaguer
        // one is the same defect as discarding evt.title at agent_loop_start; a shared resume
        // constant would have reintroduced it. SPINNER_UPDATE deliberately does not touch this —
        // that is what makes an update transient and a start durable.
        spinnerBaseLabel: action.label,
        runState: "running",
        // Reset the per-task timer only when ENTERING a run. A mid-run
        // SPINNER_START (e.g. a nested/subagent loop) keeps the original start.
        // The previous `state.runStartMs ?? Date.now()` captured the start once
        // on the first task and never reset it → durations grew monotonically
        // across the whole session (116 → 532 → 1276 …).
        // A run parked on a question is still the same run: isRunInFlight, not
        // `=== "running"`, or answering would restart the timer at zero.
        runStartMs: isRunInFlight(state.runState) ? state.runStartMs : Date.now(),
        runEndMs: isRunInFlight(state.runState) ? state.runEndMs : undefined,
        parkedMs: isRunInFlight(state.runState) ? state.parkedMs : 0,
        // Cleared alongside parkedMs. A run that ended while parked leaves this
        // set; without the reset the next run's first USER_QUESTION_RESOLVED
        // banks Date.now() minus the PREVIOUS run's park start, deducting
        // unrelated hours from a run that never waited.
        parkStartedMs: isRunInFlight(state.runState) ? state.parkStartedMs : undefined,
      };
    case "SPINNER_UPDATE":
      return { ...state, spinner: { active: true, label: action.label } };
    // Ends a transient label without ending the spinner. A mid-run SPINNER_STOP left no spinner
    // at all for the remainder of the run, since nothing downstream restarts one before RUN_DONE.
    // Resumes the remembered start label; falls back to the current label, then to a stopped
    // spinner, so it can never invent one for a run that never started.
    case "SPINNER_RESUME": {
      const resumed = state.spinnerBaseLabel ?? state.spinner?.label;
      return resumed === undefined
        ? { ...state, spinner: null }
        : { ...state, spinner: { active: true, label: resumed } };
    }
    case "SPINNER_STOP":
      return { ...state, spinner: null };

    case "TOOL_CALL_OPEN": {
      // A write tool opening closes out whatever read-only batch came before it —
      // narration/other tools never trigger this; only a write call's own open does.
      const isWrite = !READ_ONLY_TOOL_SET.has(action.toolName);
      const base = isWrite ? flushReadOnlyBatch(state) : state;
      return {
        ...base,
        liveTail: {
          ...base.liveTail,
          currentToolCall: { toolName: action.toolName, args: action.args, patch: action.patch },
        },
      };
    }

    case "TOOL_RESULT_PUSH": {
      const tc = state.liveTail.currentToolCall;
      if (!tc) return state;

      if (READ_ONLY_TOOL_SET.has(tc.toolName) && action.ok) {
        // Buffer instead of committing individually. Ink's <Static> never
        // re-renders a committed index, but nothing here is committed yet —
        // this only ever touches liveTail, never state.transcript.
        const nextBatch = [...state.liveTail.pendingReadOnlyBatch, { toolName: tc.toolName, arg: tc.args }];
        const withBatch: StoreState = { ...state, liveTail: { ...state.liveTail, pendingReadOnlyBatch: nextBatch } };
        return nextBatch.length >= READ_ONLY_BATCH_MAX_SIZE ? flushReadOnlyBatch(withBatch) : withBatch;
      }

      // A write tool's result (success or failure), or a FAILED read-only call —
      // either way this commits as its own entry, same as every call did before
      // batching existed. A failed read-only call is never absorbed into the
      // batch's count: flush what's already pending first (a write's own open
      // already flushed it, so this is a no-op there; a failed read's open never
      // does, so this is the only place it happens), then append individually so
      // ToolCall.tsx's existing glyph + error-detail rendering still applies.
      const flushed = flushReadOnlyBatch(state);
      const entry: TranscriptEntry = {
        kind: "tool_call",
        toolName: tc.toolName,
        args: tc.args,
        ...(tc.patch ? { patch: tc.patch } : {}),
        results: [{ ok: action.ok, detail: action.detail, ...(action.blocked ? { blocked: true as const } : {}) }],
        // Phase 5a — tag with current subagent (interval inference: serial execution
        // means any tool_call between STARTED and COMPLETED belongs to that subagent).
        ...(flushed.currentSubagentId ? { subagentId: flushed.currentSubagentId } : {}),
      };
      return appendEntry(flushed, entry);
    }

    case "TOOL_CALL_CLOSE":
      return {
        ...state,
        liveTail: { ...state.liveTail, currentToolCall: null },
      };

    case "STATUS_UPDATE":
      return {
        ...state,
        statusBar: {
          ...state.statusBar,
          ...(action.iter != null ? { iter: action.iter } : {}),
          ...(action.costUsd != null ? { costUsd: action.costUsd } : {}),
          ...(action.tokenBudgetRatio != null ? { tokenBudgetRatio: action.tokenBudgetRatio } : {}),
          ...(action.tokens != null ? { cumulativeTokens: action.tokens } : {}),
        },
      };

    case "TOAST_PUSH":
      return { ...state, toastQueue: [...state.toastQueue, action.entry] };

    case "TOAST_POP":
      return { ...state, toastQueue: state.toastQueue.slice(1) };

    // Wholesale set, not append — accumulation/turn-boundary reset/tail-cap all happen in the
    // ref-backed buffer in useAgentEvents.ts before this ever dispatches. Never touches
    // `transcript`: this is the one guarantee that keeps ASSISTANT_FINAL the sole writer to
    // `<Static>` for the same content.
    case "STREAMING_ANSWER_SET":
      return {
        ...state,
        liveTail: { ...state.liveTail, streamingAnswer: action.text },
      };

    case "ERROR_LINE":
      return appendEntry(state, { kind: "error", text: action.text });

    case "RUN_DONE": {
      // Self-contained flush, not reliant on a preceding NARRATION_COMMIT: RUN_DONE
      // is dispatched from multiple call sites (init.ts, eventToActions.ts), and a
      // run that ends with reads still buffered must not drop them from the record.
      const flushed = flushReadOnlyBatch(state);
      // Phase 6c — if todos exist and differ from the last snapshot, append a final one
      const withSnapshot = flushed.todos.length > 0
        ? maybeAppendPlanSnapshot(flushed, flushed.todos)
        : flushed;
      return {
        ...withSnapshot,
        spinner: null,
        runState: "done",
        // Bank a park still in flight. A run that ENDS while parked — which is
        // exactly what suspending on a question does — would otherwise report
        // the whole wait as work.
        parkedMs: withSnapshot.parkedMs + (withSnapshot.parkStartedMs != null ? Date.now() - withSnapshot.parkStartedMs : 0),
        parkStartedMs: undefined,
        // Freeze the duration at completion (excludes idle / reading time).
        runEndMs: Date.now(),
        pendingQuestion: null,
        liveTail: { ...withSnapshot.liveTail, currentToolCall: null, streamingAnswer: "" },
      };
    }

    case "RUN_ABORTED": {
      // Self-contained flush (see RUN_DONE) — RUN_ABORTED is dispatched bare, with
      // no preceding NARRATION_COMMIT, from PlanModal/PlanActionPrompt/StagedDiffModal
      // and App.tsx's Esc-abort alike; every one of those paths must surface a
      // buffered batch rather than silently discard it.
      const flushed = flushReadOnlyBatch(state);
      return {
        ...flushed,
        spinner: null,
        runState: "aborted",
        parkedMs: flushed.parkedMs + (flushed.parkStartedMs != null ? Date.now() - flushed.parkStartedMs : 0),
        parkStartedMs: undefined,
        runEndMs: Date.now(),
        pendingQuestion: null,
        liveTail: { ...flushed.liveTail, currentToolCall: null, streamingAnswer: "" },
      };
    }

    case "RUN_FAILED": {
      // Self-contained flush (see RUN_DONE).
      const flushed = flushReadOnlyBatch(state);
      return {
        ...flushed,
        spinner: null,
        runState: "failed",
        parkedMs: flushed.parkedMs + (flushed.parkStartedMs != null ? Date.now() - flushed.parkStartedMs : 0),
        parkStartedMs: undefined,
        runEndMs: Date.now(),
        pendingQuestion: null,
        liveTail: { ...flushed.liveTail, currentToolCall: null, streamingAnswer: "" },
      };
    }

    case "USER_PROMPT":
      return {
        ...appendEntry(state, { kind: "user_prompt", text: action.text }),
        todos: [],
      };

    case "ASSISTANT_FINAL": {
      // Self-contained flush, for the same reason RUN_DONE carries one: the final report must be
      // the last thing in the transcript, and reads still sitting in the batch would otherwise
      // commit after it.
      const flushed = flushReadOnlyBatch(state);
      return appendEntry(flushed, { kind: "assistant_final", text: action.text });
    }

    case "POST_EXECUTE_DIFFS":
      return appendEntry(state, {
        kind: "post_execute_diffs",
        files: action.files,
        diffShownInline: diffsAlreadyShownInline(state.transcript, action.files),
      });

    case "TRANSCRIPT_CLEAR":
      return { ...state, transcript: [], todos: [] };

    case "TRANSCRIPT_REMOUNT":
      return { ...state, transcriptGeneration: state.transcriptGeneration + 1 };

    case "PENDING_APPROVAL_SET": {
      const next: StoreState = { ...state, pendingApproval: { approvalId: action.approvalId, runId: action.runId, command: action.command, kind: action.kind, ...(action.subagentId ? { subagentId: action.subagentId } : {}) } };
      // Phase 2d — trust approvals render through the OverlayLayer stack; push "trust" so the
      // TrustPrompt content component renders inside OverlayShell.
      if (action.kind === "trust") {
        next.overlayStack = [...state.overlayStack, "trust" as const];
      }
      return next;
    }

    case "PENDING_APPROVAL_RESOLVED":
      return { ...state, pendingApproval: null };

    case "USER_QUESTION_ASKED": {
      // Flush first: this nulls currentToolCall below, which is the live
      // indicator's only render condition (Transcript.tsx) — without flushing,
      // a pending batch would go fully invisible for the whole pause, right when
      // the user is looking at the screen to answer.
      const flushed = flushReadOnlyBatch(state);
      return {
        ...flushed,
        pendingQuestion: {
          kind: "live",
          questionId: action.questionId,
          runId: action.runId,
          question: action.question,
        },
        runState: "awaiting_input",
        parkStartedMs: Date.now(),
        // Nothing is being computed while we wait, and a spinner next to a
        // question reads as "still working", i.e. "don't type".
        spinner: null,
        liveTail: { ...flushed.liveTail, currentToolCall: null, streamingAnswer: "" },
      };
    }

    case "USER_QUESTION_CARRIED":
      // Resumed from an envelope: the question outlived the process that asked
      // it. runState goes to awaiting_input so the pinned panel and the status
      // line say the same thing they do mid-run — the user's next keystroke
      // joins an old conversation, and they can see that before they type.
      return {
        ...state,
        pendingQuestion: {
          kind: "carried",
          question: action.question,
          toolCallId: action.toolCallId,
          runId: action.runId,
          iter: action.iter,
          conversationLost: action.conversationLost,
        },
        runState: "awaiting_input",
        // No parkStartedMs: the wait happened while zone was not running, so it
        // is not this session's to bank against a run duration.
        spinner: null,
      };

    case "USER_QUESTION_RESOLVED": {
      // Back to the run, not to idle — runStartMs is untouched, so the
      // reported duration never counted the wait as inference.
      const base: StoreState = {
        ...state,
        pendingQuestion: null,
        parkedMs: state.parkedMs + (state.parkStartedMs != null ? Date.now() - state.parkStartedMs : 0),
        parkStartedMs: undefined,
        runState: "running",
        spinner: { active: true, label: "Working" },
      };
      // The pinned panel disappears with the question, so the answer has to
      // land in the scrollback or there is no record of what was agreed.
      return action.echo
        ? appendEntry(base, { kind: "user_prompt" as const, text: action.echo })
        : base;
    }

    case "USER_QUESTION_DISMISSED":
      // Only reachable for a carried question: no run is starting, so this goes
      // to idle rather than "running". The next submit is an ordinary new task.
      return {
        ...state,
        pendingQuestion: null,
        parkStartedMs: undefined,
        runState: "idle",
        spinner: null,
      };

    case "SESSION_TRUST_PREFIX":
      return { ...state, sessionTrustedPrefixes: [...state.sessionTrustedPrefixes, action.prefix] };

    case "PERMISSIONS_OPEN":
      // Phase 2d — PermissionsManager renders via the OverlayLayer stack; push alongside modalView
      // so the data-seeding dispatch from Composer opens the overlay in one step.
      return { ...state, modalView: "permissions", permissionsList: action.list, permissionsSelectedIndex: 0, overlayStack: [...state.overlayStack, "permissions" as const] };

    case "PERMISSIONS_CLOSE":
      return { ...state, modalView: "none" };

    case "PERMISSIONS_NAV": {
      const len = state.permissionsList.length;
      if (len === 0) return state;
      const next = action.direction === "up"
        ? Math.max(0, state.permissionsSelectedIndex - 1)
        : Math.min(len - 1, state.permissionsSelectedIndex + 1);
      return { ...state, permissionsSelectedIndex: next };
    }

    case "PERMISSIONS_REMOVE_SELECTED": {
      const idx = state.permissionsSelectedIndex;
      const removed = state.permissionsList[idx];
      if (!removed) return state;
      const newList = state.permissionsList.filter((_, i) => i !== idx);
      const newIdx = Math.min(idx, Math.max(0, newList.length - 1));
      return {
        ...state,
        permissionsList: newList,
        permissionsSelectedIndex: newIdx,
        sessionTrustedPrefixes: state.sessionTrustedPrefixes.filter(p => p !== removed.prefix),
      };
    }

    case "KEYS_OPEN":
      return { ...state, modalView: "keys", keysList: action.list, keysSelectedIndex: 0, keysEditMode: "view", keysEditInput: "", keysEditProvider: null, keysDraftProfileId: "", keysDraftBaseUrl: "", keysPriceProvider: "", keysPriceModelId: "", keysPriceDraft: {} };

    case "KEYS_CLOSE":
      return { ...state, modalView: "none" };

    case "KEYS_NAV": {
      const len = state.keysList.length;
      if (len === 0) return state;
      const next = action.direction === "up"
        ? Math.max(0, state.keysSelectedIndex - 1)
        : Math.min(len - 1, state.keysSelectedIndex + 1);
      return { ...state, keysSelectedIndex: next };
    }

    case "KEYS_START_ADD":
      return { ...state, keysEditMode: "select-provider", keysEditInput: "", keysEditProvider: null, keysDraftProfileId: "", keysDraftBaseUrl: "", keysPriceProvider: "", keysPriceModelId: "", keysPriceDraft: {} };

    case "KEYS_START_EDIT":
      return { ...state, keysEditMode: "input", keysEditProvider: action.provider, keysEditInput: "" };

    case "KEYS_PROVIDER_SELECTED":
      return { ...state, keysEditMode: "input", keysEditProvider: action.provider, keysEditInput: "" };

    case "KEYS_INPUT_CHAR":
      return { ...state, keysEditInput: state.keysEditInput + action.ch };

    case "KEYS_INPUT_BACKSPACE":
      return { ...state, keysEditInput: state.keysEditInput.slice(0, -1) };

    case "KEYS_INPUT_CANCEL":
      return { ...state, keysEditMode: "view", keysEditInput: "", keysEditProvider: null, keysDraftProfileId: "", keysDraftBaseUrl: "", keysPriceProvider: "", keysPriceModelId: "", keysPriceDraft: {} };

    // The gateway flow's three steps all reuse KEYS_INPUT_CHAR/BACKSPACE for the buffer; these
    // three actions only move the buffer into a draft field and advance the mode.
    case "KEYS_GATEWAY_START":
      return { ...state, keysEditMode: "input-profile-id", keysEditInput: "", keysEditProvider: null, keysDraftProfileId: "", keysDraftBaseUrl: "", keysPriceProvider: "", keysPriceModelId: "", keysPriceDraft: {} };

    case "KEYS_GATEWAY_ID_SUBMIT": {
      const id = state.keysEditInput.trim();
      // A blank id, or one shadowing a built-in, cannot resolve: `resolveProviderProfile` checks
      // gateways first but `resolveProfile` would still return the built-in for these two names.
      if (!id || id === "anthropic" || id === "openai") return state;
      return { ...state, keysDraftProfileId: id, keysEditMode: "input-base-url", keysEditInput: "" };
    }

    case "KEYS_GATEWAY_URL_SUBMIT": {
      const url = state.keysEditInput.trim();
      if (!url) return state;
      return { ...state, keysDraftBaseUrl: url, keysEditMode: "input", keysEditProvider: state.keysDraftProfileId, keysEditInput: "" };
    }

    // ── The optional pricing sub-flow ──────────────────────────────────────────────────────────
    case "KEYS_PRICE_START":
      return { ...state, keysEditMode: "price-model-id", keysEditInput: "", keysPriceProvider: action.provider, keysPriceModelId: "", keysPriceDraft: {} };

    case "KEYS_PRICE_MODEL_SUBMIT": {
      const id = state.keysEditInput.trim();
      if (!id) return state;
      return { ...state, keysPriceModelId: id, keysEditMode: "price-input", keysEditInput: "" };
    }

    case "KEYS_PRICE_NUMBER_SUBMIT": {
      const next = { ...state.keysPriceDraft, [action.field]: action.value };
      const mode =
        action.field === "input" ? "price-output" as const
        : action.field === "output" ? "price-cache-read" as const
        : action.field === "cache_read" ? "price-cache-write" as const
        : "view" as const;
      return { ...state, keysPriceDraft: next, keysEditMode: mode, keysEditInput: "" };
    }

    // Skipping LEAVES THE FIELD ABSENT rather than writing a zero — the absence is the record that
    // the user never declared it, which a stored 0 could not distinguish from a declared 0.
    case "KEYS_PRICE_SKIP": {
      const mode = action.field === "cache_read" ? "price-cache-write" as const : "view" as const;
      return { ...state, keysEditMode: mode, keysEditInput: "" };
    }

    case "KEYS_PRICE_CANCEL":
      return { ...state, keysEditMode: "view", keysEditInput: "", keysPriceProvider: "", keysPriceModelId: "", keysPriceDraft: {} };

    case "KEYS_START_DELETE": {
      const entry = state.keysList[state.keysSelectedIndex];
      if (!entry) return state;
      return { ...state, keysEditMode: "confirm-delete", keysEditProvider: entry.provider };
    }

    case "KEYS_DELETE_CANCELED":
      return { ...state, keysEditMode: "view", keysEditProvider: null };

    case "SESSIONS_OPEN": {
      const seen = new Set<string>();
      const deduped = action.list.filter(s => {
        if (seen.has(s.sessionId)) return false;
        seen.add(s.sessionId);
        return true;
      });
      // Phase 2d — SessionBrowser renders via the OverlayLayer stack.
      return { ...state, modalView: "sessions", sessionsList: deduped, sessionsSelectedIndex: 0, overlayStack: [...state.overlayStack, "sessions" as const] };
    }

    case "SESSIONS_CLOSE":
      return { ...state, modalView: "none" };

    case "SESSIONS_NAV": {
      const len = state.sessionsList.length;
      if (len === 0) return state;
      const next = action.direction === "up"
        ? Math.max(0, state.sessionsSelectedIndex - 1)
        : Math.min(len - 1, state.sessionsSelectedIndex + 1);
      return { ...state, sessionsSelectedIndex: next };
    }

    case "SESSION_RESUME":
      return {
        ...state,
        transcript: action.session.transcript,
        sessionId: action.session.sessionId,
        sessionStartedAt: action.session.startedAt,
        isResumed: true,
        // Reset, not flush: the transcript this batch would flush into is about to
        // be replaced wholesale by the resumed session's own, so there is nothing
        // to preserve it for.
        liveTail: { currentToolCall: null, narrationBuffer: "", pendingReadOnlyBatch: [], streamingAnswer: "" },
        spinner: null,
        runState: "idle",
        pendingQuestion: null,
        runStartMs: undefined,
        runEndMs: undefined,
        modalView: "none",
        planProposal: null,
        planReadyProposal: null,
        statusBar: { ...state.statusBar, costUsd: 0, iter: 0 },
        transcriptGeneration: state.transcriptGeneration + 1,
        todos: [],
        // Phase 5d — restore subagent threads for nested transcript rendering.
        // Absent in pre-5d session files → empty record (backward compatible).
        subagentThreads: action.session.subagentThreads ?? {},
        currentSubagentId: null,
        parentSpinnerLabels: [],
      };

    case "MODE_CYCLE":
      if (state.modalView !== "none" || state.pendingApproval !== null) return state;
      return {
        ...state,
        mode: state.mode === "normal" ? "autoAccept"
            : state.mode === "autoAccept" ? "plan"
            : "normal",
      };

    case "PLAN_PROPOSED":
      return {
        ...state,
        modalView: "plan",
        planProposal: {
          revisionId: action.revisionId,
          runId: action.runId,
          revisionType: action.revisionType,
          revisionReason: action.revisionReason,
          originalPlan: action.originalPlan,
          revisedPlanSummary: action.revisedPlanSummary,
          ...(action.missingFiles ? { missingFiles: action.missingFiles } : {}),
          ...(action.unnecessaryFiles ? { unnecessaryFiles: action.unnecessaryFiles } : {}),
        },
      };

    case "PLAN_RESOLVED":
      return { ...state, modalView: "none", planProposal: null };

    case "PLAN_READY_PROPOSED": {
      // Flush first, then append plan_ready after it — matching chronological
      // order (the reads that informed the plan happened before the plan did).
      const flushed = flushReadOnlyBatch(state);
      const withProposal: StoreState = {
        ...flushed,
        modalView: "plan_ready",
        planReadyProposal: {
          planId: action.planId,
          runId: action.runId,
          objective: action.objective,
          steps: action.steps,
          ...(action.scopeNotes ? { scopeNotes: action.scopeNotes } : {}),
          ...(action.noChangeReason ? { noChangeReason: action.noChangeReason } : {}),
          ...(action.cannotVerifyReason ? { cannotVerifyReason: action.cannotVerifyReason } : {}),
          ...(action.answerOnlyReason ? { answerOnlyReason: action.answerOnlyReason } : {}),
          riskHints: action.riskHints,
          scopeSummary: action.scopeSummary,
          ...(action.narrative ? { narrative: action.narrative } : {}),
          ...(action.filesLikely?.length ? { filesLikely: action.filesLikely } : {}),
        },
      };
      return appendEntry(withProposal, {
        kind: "plan_ready" as const,
        planId: action.planId,
        runId: action.runId,
        objective: action.objective,
        steps: action.steps,
        ...(action.scopeNotes ? { scopeNotes: action.scopeNotes } : {}),
        ...(action.noChangeReason ? { noChangeReason: action.noChangeReason } : {}),
        ...(action.cannotVerifyReason ? { cannotVerifyReason: action.cannotVerifyReason } : {}),
        ...(action.answerOnlyReason ? { answerOnlyReason: action.answerOnlyReason } : {}),
        riskHints: action.riskHints,
        scopeSummary: action.scopeSummary,
        ...(action.narrative ? { narrative: action.narrative } : {}),
        ...(action.filesLikely?.length ? { filesLikely: action.filesLikely } : {}),
      });
    }

    case "PLAN_READY_RESOLVED":
      // Plan mode is sticky (Claude-Code-like): keep state.mode so follow-up
      // tasks stay in plan mode until the user toggles out via Shift+Tab.
      return { ...state, modalView: "none", planReadyProposal: null };

    case "STAGED_DIFFS_PROPOSED": {
      // Flush first (see PLAN_READY_PROPOSED) — reads leading up to the staged
      // diff must not sit invisible in liveTail while the user reviews it.
      const flushed = flushReadOnlyBatch(state);
      return {
        ...flushed,
        modalView: "staged_diffs",
        stagedDiffProposal: {
          approvalId: action.approvalId,
          runId: action.runId,
          files: action.files,
          verificationSummary: action.verificationSummary,
          trigger: action.trigger,
        },
      };
    }

    case "STAGED_DIFFS_RESOLVED":
      return { ...state, modalView: "none", stagedDiffProposal: null };

    case "TRANSCRIPT_APPEND_NARRATION":
      if (!action.text) return state;
      return { ...state, liveTail: { ...state.liveTail, narrationBuffer: state.liveTail.narrationBuffer + action.text } };

    case "TRANSCRIPT_ADD_THINKING":
      if (!action.text) return state;
      return appendEntry(state, { kind: "thinking" as const, text: action.text });

    case "NARRATION_COMMIT": {
      const { narrationBuffer } = state.liveTail;
      if (!narrationBuffer) return state;
      const last = state.transcript[state.transcript.length - 1];
      const cleared = { ...state, liveTail: { ...state.liveTail, narrationBuffer: "" } };
      if (last?.kind === "narration") {
        // Merge into existing narration entry — replace last, then re-check cap
        const merged: TranscriptEntry = { kind: "narration" as const, text: last.text + narrationBuffer };
        const replaced = { ...cleared, transcript: [...cleared.transcript.slice(0, -1), merged] };
        // Merging doesn't increase length, so cap is unchanged — just return
        return replaced;
      }
      // New narration entry — goes through appendEntry for cap enforcement
      return appendEntry(cleared, { kind: "narration", text: narrationBuffer });
    }

    case "MODEL_MODAL_OPEN": {
      // Seeded against the rows the modal will RENDER, never against the unfiltered catalog —
      // the two differ whenever a provider is filtered out, and an index into the wrong one lands
      // the cursor on a different model than the one in use. modelPickerList.ts owns both halves.
      const current = state.modelSettings?.model ?? getDefaultModelId();
      const rows = visibleModelRows(USER_FACING_MODELS, state.providersWithKey, current);
      return { ...state, modalView: "model", modelSelectedIndex: selectedIndexForCurrent(rows, current), modelCustomMode: "none", modelCustomInput: "", modelGatewayIndex: 0 };
    }

    case "MODEL_MODAL_CLOSE":
      return { ...state, modalView: "none", modelCustomMode: "none", modelCustomInput: "", modelGatewayIndex: 0 };

    case "MODEL_APPLY": {
      const effortToKeep = supportsEffort(action.settings.model)
        ? action.settings.effort
        : undefined;
      const settings = { ...action.settings, effort: effortToKeep };
      const newEffortCount = effortLevelsFor(settings.model).length;
      const clampedEffortIndex = newEffortCount > 0
        ? Math.min(state.effortSelectedIndex, newEffortCount - 1)
        : 0;
      return {
        ...state,
        modelSettings: settings,
        statusBar: { ...state.statusBar, model: settings.model },
        effortSelectedIndex: clampedEffortIndex,
        modalView: "none",
        modelCustomMode: "none" as const,
        modelCustomInput: "",
        modelGatewayIndex: 0,
      };
    }

    case "MODEL_CUSTOM_START":
      return { ...state, modelCustomMode: "input", modelCustomInput: "", modelGatewayIndex: 0 };

    case "MODEL_CUSTOM_CHAR":
      return { ...state, modelCustomInput: state.modelCustomInput + action.ch };

    case "MODEL_CUSTOM_BACKSPACE":
      return { ...state, modelCustomInput: state.modelCustomInput.slice(0, -1) };

    case "MODEL_CUSTOM_CANCEL":
      return { ...state, modelCustomMode: "none", modelCustomInput: "", modelGatewayIndex: 0 };

    // Reached only from the >=2 branch. With exactly one gateway the caller applies directly and
    // the routing is DISPLAYED beforehand; it is never chosen on the user's behalf here.
    case "MODEL_CUSTOM_PICK_GATEWAY":
      return { ...state, modelCustomMode: "pick-gateway", modelGatewayIndex: 0 };

    case "MODEL_GATEWAY_NAV": {
      const len = state.gatewayIds.length;
      if (len === 0) return state;
      const next = action.direction === "up"
        ? Math.max(0, state.modelGatewayIndex - 1)
        : Math.min(len - 1, state.modelGatewayIndex + 1);
      return { ...state, modelGatewayIndex: next };
    }

    case "MODEL_NAV": {
      const next = action.direction === "up"
        ? Math.max(0, state.modelSelectedIndex - 1)
        : Math.min(action.count - 1, state.modelSelectedIndex + 1);
      return { ...state, modelSelectedIndex: next };
    }

    case "EFFORT_MODAL_OPEN":
      return { ...state, modalView: "effort" };

    case "EFFORT_MODAL_CLOSE":
      return { ...state, modalView: "none" };

    case "METRICS_MODAL_OPEN":
      return { ...state, modalView: "metrics" };

    case "METRICS_MODAL_CLOSE":
      return { ...state, modalView: "none" };

    case "LIMITS_MODAL_OPEN":
      return { ...state, modalView: "limits" };

    case "LIMITS_MODAL_CLOSE":
      return { ...state, modalView: "none" };

    case "LIMITS_APPLY":
      return { ...state, statusBar: { ...state.statusBar, capUsd: action.capUsd }, modalView: "none" };

    case "DAILY_USED_UPDATE":
      return { ...state, statusBar: { ...state.statusBar, dailyUsedUsd: action.dailyUsedUsd } };

    case "EFFORT_APPLY": {
      const updated: DiskModelSettings = state.modelSettings
        ? { ...state.modelSettings, effort: action.effort, updatedAt: new Date().toISOString() }
        : { version: 2, model: "claude-sonnet-4-6", provider: "anthropic", effort: action.effort, updatedAt: new Date().toISOString() };
      return { ...state, modelSettings: updated, modalView: "none" };
    }

    case "EFFORT_NAV": {
      const effortCount = effortLevelsFor(state.modelSettings?.model ?? "").length || 3;
      const next = action.direction === "up"
        ? Math.max(0, state.effortSelectedIndex - 1)
        : Math.min(effortCount - 1, state.effortSelectedIndex + 1);
      return { ...state, effortSelectedIndex: next };
    }

    case "SUMMARY_MODAL_OPEN":
      return { ...state, modalView: "summary" };

    case "SUMMARY_MODAL_CLOSE":
      return { ...state, modalView: "none" };

    case "SUMMARY_APPLY": {
      const updated: DiskModelSettings = state.modelSettings
        ? { ...state.modelSettings, summaryFormat: action.summaryFormat, updatedAt: new Date().toISOString() }
        : { version: 2, model: "claude-sonnet-4-6", provider: "anthropic", summaryFormat: action.summaryFormat, updatedAt: new Date().toISOString() };
      return { ...state, modelSettings: updated, modalView: "none" };
    }

    case "SUMMARY_NAV": {
      const SUMMARY_COUNT = 2;
      const next = action.direction === "up"
        ? Math.max(0, state.summarySelectedIndex - 1)
        : Math.min(SUMMARY_COUNT - 1, state.summarySelectedIndex + 1);
      return { ...state, summarySelectedIndex: next };
    }

    case "PLANMODE_MODAL_OPEN":
      return { ...state, modalView: "planMode" };

    case "PLANMODE_MODAL_CLOSE":
      return { ...state, modalView: "none" };

    case "PLANMODE_APPLY": {
      const updated: DiskModelSettings = state.modelSettings
        ? { ...state.modelSettings, planDepth: action.planDepth, updatedAt: new Date().toISOString() }
        : { version: 2, model: "claude-sonnet-4-6", provider: "anthropic", planDepth: action.planDepth, updatedAt: new Date().toISOString() };
      return { ...state, modelSettings: updated, modalView: "none" };
    }

    case "PLANMODE_NAV": {
      const next = action.direction === "up"
        ? Math.max(0, state.planModeSelectedIndex - 1)
        : Math.min(1, state.planModeSelectedIndex + 1);
      return { ...state, planModeSelectedIndex: next };
    }

    case "MEMORY_MODAL_OPEN":
      return { ...state, modalView: "session" };

    case "MEMORY_MODAL_CLOSE":
      return { ...state, modalView: "none" };

    case "MEMORY_APPLY": {
      const updated: DiskModelSettings = state.modelSettings
        ? { ...state.modelSettings, memoryEnabled: action.memoryEnabled, updatedAt: new Date().toISOString() }
        : { version: 2, model: "claude-sonnet-4-6", provider: "anthropic", memoryEnabled: action.memoryEnabled, updatedAt: new Date().toISOString() };
      return { ...state, modelSettings: updated, modalView: "none" };
    }

    case "MEMORY_NAV": {
      const MEMORY_COUNT = 3;  // Off, On, Clear
      const next = action.direction === "up"
        ? Math.max(0, state.memorySelectedIndex - 1)
        : Math.min(MEMORY_COUNT - 1, state.memorySelectedIndex + 1);
      return { ...state, memorySelectedIndex: next };
    }

    case "SESSION_MEMORY_CLEAR":
      return {
        ...appendEntry(state, { kind: "user_prompt" as const, text: "Session memory cleared — starting fresh." }),
        sessionId: action.newSessionId,
        modalView: "none",
      };

    case "COMMIT_MODAL_OPEN":
      // Phase 2d — CommitEditor renders via the OverlayLayer stack.
      return { ...state, modalView: "commit", commitData: { filePaths: action.filePaths, message: action.message, repoPath: action.repoPath }, overlayStack: [...state.overlayStack, "commit" as const] };

    case "COMMIT_MODAL_CLOSE":
      return { ...state, modalView: "none" };

    case "FEEDBACK_MODAL_OPEN":
      // Phase 2d — FeedbackForm renders via the OverlayLayer stack.
      return { ...state, modalView: "feedback", feedbackData: { runId: action.runId, sessionId: action.sessionId, logs: action.logs, version: action.version, repoPath: action.repoPath }, overlayStack: [...state.overlayStack, "feedback" as const] };

    case "FEEDBACK_MODAL_CLOSE":
      return { ...state, modalView: "none" };

    case "UNDO_MODAL_OPEN":
      // Phase 2d — UndoConfirm renders via the OverlayLayer stack.
      return { ...state, modalView: "undo", undoModalData: { manifest: action.manifest, driftedPaths: action.driftedPaths }, overlayStack: [...state.overlayStack, "undo" as const] };

    case "UNDO_MODAL_CLOSE":
      return { ...state, modalView: "none", undoModalData: null };

    case "AUTOCOMMIT_APPLY": {
      const updated: DiskModelSettings = state.modelSettings
        ? { ...state.modelSettings, commitOnSuccess: action.commitOnSuccess, updatedAt: new Date().toISOString() }
        : { version: 2, model: "claude-sonnet-4-6", provider: "anthropic", commitOnSuccess: action.commitOnSuccess, updatedAt: new Date().toISOString() };
      return { ...state, modelSettings: updated };
    }

    case "WEBSEARCH_APPLY": {
      const updated: DiskModelSettings = state.modelSettings
        ? { ...state.modelSettings, webSearchEnabled: action.webSearchEnabled, updatedAt: new Date().toISOString() }
        : { version: 2, model: "claude-sonnet-4-6", provider: "anthropic", webSearchEnabled: action.webSearchEnabled, updatedAt: new Date().toISOString() };
      return { ...state, modelSettings: updated };
    }

    case "TODOS_SET": {
      // Phase 6c — append a plan_snapshot on todos_initialized / todo_revised
      const next = { ...state, todos: action.todos };
      return maybeAppendPlanSnapshot(next, action.todos);
    }

    case "TODO_STATUS_SET": {
      if (state.todos.length === 0) return state;
      let next: RunTodo[];
      if (action.status === "in_progress") {
        next = startTodo(state.todos, action.todoId);
      } else if (action.status === "completed") {
        next = completeTodo(state.todos, action.todoId);
      } else {
        next = state.todos.map(t =>
          t.id === action.todoId ? { ...t, status: action.status } : t
        );
      }
      if (next === state.todos) return state;
      // Phase 6c — status changes update the live slice only (no transcript append).
      // The final snapshot is appended on agent_loop_complete.
      return { ...state, todos: next };
    }

    case "HOOKS_TRUST_APPROVED": {
      if (!state.pendingHookTrust) return state;
      // Side-effect (recordHooksTrust) is performed by the caller before dispatch.
      return {
        ...state,
        armedUserHooks: state.pendingHookTrust.config,
        pendingHookTrust: null,
      };
    }
    case "HOOKS_TRUST_DENIED":
      return { ...state, pendingHookTrust: null, armedUserHooks: null };

    case "MCP_TRUST_APPROVED":
      // Side-effect (recordMcpTrust + McpClientManager.connect) performed by caller before dispatch.
      return { ...state, armedMcpManager: action.manager, pendingMcpTrust: null };
    case "MCP_TRUST_DENIED":
      return { ...state, pendingMcpTrust: null, armedMcpManager: null };

    // Phase 5a+5c — subagent lifecycle. STARTED creates a thread entry, sets currentSubagentId
    // for tool_call tagging (interval inference: serial execution means every tool_call between
    // STARTED and COMPLETED belongs to that subagent), and pushes the spinner label onto a stack
    // so nested subagents can restore their parent's label on completion.
    // DESIGN NOTE: this relies on serial subagent execution (toolExecutor.ts cap=1). If parallel
    // dispatch ever lands (deferred-work), the durable fix is producer-side tagging via
    // AsyncLocalStorage in emitStructuredProgress.
    case "SUBAGENT_STARTED": {
      const thread: SubagentThread = {
        subagentId: action.subagentId,
        subagentType: action.subagentType,
        title: action.title,
        status: "running",
        toolCallCount: 0,
      };
      const currentLabel = state.spinner?.label ?? "";
      const truncatedTitle = action.title.length > 40 ? action.title.slice(0, 37) + "..." : action.title;
      return {
        ...state,
        subagentThreads: { ...state.subagentThreads, [action.subagentId]: thread },
        currentSubagentId: action.subagentId,
        parentSpinnerLabels: [...state.parentSpinnerLabels, currentLabel],
        spinner: state.spinner ? { ...state.spinner, label: `↳ ${action.subagentType} · ${truncatedTitle}` } : state.spinner,
      };
    }
    case "SUBAGENT_COMPLETED": {
      const existing = state.subagentThreads[action.subagentId];
      if (!existing) return state;
      const updated: SubagentThread = {
        ...existing,
        status: action.status,
        ...(action.costUsd !== undefined ? { costUsd: action.costUsd } : {}),
        ...(action.iterations !== undefined ? { iterations: action.iterations } : {}),
        ...(action.summary !== undefined ? { summary: action.summary } : {}),
      };
      const labels = state.parentSpinnerLabels;
      const parentLabel = labels.length > 0 ? labels[labels.length - 1] : null;
      return {
        ...state,
        subagentThreads: { ...state.subagentThreads, [action.subagentId]: updated },
        currentSubagentId: null,
        parentSpinnerLabels: labels.slice(0, -1),
        spinner: state.spinner && parentLabel !== null
          ? { ...state.spinner, label: parentLabel }
          : state.spinner,
      };
    }

    // Phase 2c — overlay stack. Push appends (a modal re-opening itself stacks, deliberately —
    // the user can Esc through the history). Pop removes the top regardless of id so the
    // central Esc handler (Phase 3b) can close "whatever is on top" without knowing what it
    // is. Clear is the teardown primitive — used when a run ends or a session resets so a
    // stale overlay does not survive the transition.
    case "OVERLAY_PUSH":
      // Phase 3b — a new layer always starts with sub-mode closed.
      return { ...state, overlayStack: [...state.overlayStack, action.overlayId], overlaySubModeOpen: false };
    case "OVERLAY_POP":
      // Empty-stack pop is a pure no-op — return the same state reference so cheap
      // equality checks (`next === state`) detect no-change and the reducer doesn't
      // spuriously re-render consumers on a stray Esc.
      if (state.overlayStack.length === 0) return state;
      return { ...state, overlayStack: state.overlayStack.slice(0, -1), overlaySubModeOpen: false };
    case "OVERLAY_CLEAR":
      return { ...state, overlayStack: [], overlaySubModeOpen: false };
    case "OVERLAY_SUBMODE_OPEN":
      return { ...state, overlaySubModeOpen: true };
    case "OVERLAY_SUBMODE_CLOSE":
      return { ...state, overlaySubModeOpen: false };

    default:
      return state;
  }
}

/**
 * Phase 2c — single source of truth for "is a blocking modal open?".
 *
 * Replaces three+ inline boolean computations that used to live in App.tsx, Composer.tsx, and
 * individual modal gates, each slightly out of sync (one missed `planProposal`, another
 * missed `overlayStack`). Every site that decides behaviour based on "is the user talking to
 * a modal right now?" reads this selector.
 *
 * "Blocking" means the Composer should stop accepting new submissions — approval, trust,
 * plan-ready, staged-diffs, scope-revision, and the new overlay stack all count. A pending
 * question does NOT (the question IS the conversation, so the composer must stay live to
 * receive the answer). A `modalView !== "none"` that is not also on `overlayStack` does NOT
 * count either — the legacy modals still on `modalView` coexist with the new stack during
 * Phase 2d migration and will be added here as they land.
 */
export const selectIsBlockingModalOpen = (state: StoreState): boolean =>
  state.pendingApproval !== null ||
  state.pendingHookTrust !== null ||
  state.pendingMcpTrust !== null ||
  state.planProposal !== null ||
  state.planReadyProposal !== null ||
  state.stagedDiffProposal !== null ||
  state.overlayStack.length > 0;

/**
 * Phase 3b — Esc-key routing. Determines which handler should own the next Esc press.
 * "submode" wins over "overlay" so a text-input inside an overlay gets Esc first (to cancel
 * the input) before the overlay itself pops. "question" wins over "run" so dismissing a
 * parked question does not also abort the run. "none" means no handler should fire.
 */
export const selectEscTarget = (state: StoreState): "submode" | "overlay" | "question" | "run" | "none" => {
  if (state.overlaySubModeOpen) return "submode";
  if (state.overlayStack.length > 0) return "overlay";
  if (state.pendingQuestion !== null) return "question";
  if (state.runState === "running") return "run";
  return "none";
};

/**
 * Phase 7b — persistent condition warnings for the StatusBar. Returns at most 2 items.
 * These are conditions that persist until resolved (unlike transient Toasts).
 * - Daily cap usage above 80% → "cap {pct}%"
 * - Remote control disconnected → "/rc failed" (reserved for future RC state integration)
 */
export const selectPersistentWarnings = (state: StoreState): string[] => {
  const warnings: string[] = [];
  const { dailyUsedUsd, capUsd } = state.statusBar;
  if (capUsd > 0 && dailyUsedUsd > 0) {
    const pct = Math.round((dailyUsedUsd / capUsd) * 100);
    if (pct >= 80) warnings.push(`cap ${pct}%`);
  }
  return warnings.slice(0, 2);
};
