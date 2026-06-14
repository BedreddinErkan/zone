import { createContext, useContext, useReducer, type Dispatch } from "react";
import { randomUUID } from "node:crypto";
import type { DiskTrustEntry } from "../../api/diskTrust.js";
import type { DiskApiKey, ApiKeyProvider } from "../../api/diskKeys.js";
import type { DiskSession, SessionMeta } from "../../api/diskSessions.js";
import type { TuiMode } from "../dispatch.js";
import type { DiskModelSettings } from "../../api/diskModel.js";
import { supportsEffort, effortLevelsFor } from "../../llm/modelRegistry.js";
import type { EffortLevel } from "../../llm/modelRegistry.js";
import type { RunTodo, TodoStatus } from "../../core/todoLifecycle.js";
import { startTodo, completeTodo } from "../../core/todoLifecycle.js";
import type { UserCommand } from "./userCommands.js";
import type { StagedFile } from "../../core/fileDiff.js";
import type { UserHooksConfig } from "../../api/diskHooks.js";

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
};

export type TranscriptEntry =
  | { kind: "narration"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; toolName: string; args: string; patch?: string; results: { ok: boolean; detail: string; blocked?: true }[] }
  | { kind: "error"; text: string }
  | { kind: "phase_marker"; phase: string }
  | { kind: "user_prompt"; text: string }
  | { kind: "assistant_final"; text: string }
  | { kind: "post_execute_diffs"; files: StagedFile[] };

export type StatusBarState = {
  iter: number;
  costUsd: number;
  dailyUsedUsd: number;
  capUsd: number;
  model: string;
  tokenBudgetRatio: number;
  cumulativeTokens: number;
};

export type RunState = "idle" | "running" | "done" | "aborted" | "failed";

export type StoreState = {
  transcript: TranscriptEntry[];
  sessionId: string;
  sessionStartedAt: string;
  isResumed: boolean;
  liveTail: LiveTailState;
  spinner: { active: boolean; label: string } | null;
  statusBar: StatusBarState;
  runState: RunState;
  /** Wall-clock start of the CURRENT task (reset per run, not per session). */
  runStartMs?: number;
  /** Wall-clock completion of the last task — frozen so the displayed duration
   *  doesn't keep ticking while the "done" status is shown. */
  runEndMs?: number;
  toastQueue: ToastEntry[];
  modalStack: ModalEntry[];
  pendingApproval: { approvalId: string; runId: string; command: string; kind?: "command" | "edit" | "trust" } | null;
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
  undoModalData: { manifest: import("../../snapshots/snapshotStore.js").SnapshotManifest; driftedPaths: string[] } | null;
  planModeSelectedIndex: number;
  commitData: { filePaths: string[]; message: string; repoPath: string } | null;
  feedbackData: { runId: string; logs: string } | null;
  summarySelectedIndex: number;
  memorySelectedIndex: number;
  planReadyProposal: {
    planId: string;
    runId: string;
    objective: string;
    steps: Array<{ title: string; description: string; filesLikely: string[] }>;
    scopeNotes?: string;
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
  effortSelectedIndex: number;
  permissionsList: DiskTrustEntry[];
  permissionsSelectedIndex: number;
  keysList: DiskApiKey[];
  keysSelectedIndex: number;
  keysEditMode: "view" | "select-provider" | "input" | "confirm-delete";
  keysEditInput: string;
  keysEditProvider: ApiKeyProvider | null;
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
  userCommands?: UserCommand[];
  mode?: TuiMode;
  armedUserHooks?: UserHooksConfig | null;
  pendingHookTrust?: { config: UserHooksConfig; hash: string; projectPath: string } | null;
  armedMcpManager?: import("../../mcp/mcpClientManager.js").McpClientManager | null;
  pendingMcpTrust?: { config: import("../../api/diskMcp.js").McpConfig; hash: string; projectPath: string } | null;
}): StoreState {
  return {
    transcript: initialValues?.resumedTranscript ?? [],
    sessionId: initialValues?.resumedSessionId ?? randomUUID(),
    sessionStartedAt: initialValues?.resumedStartedAt ?? new Date().toISOString(),
    isResumed: !!initialValues?.resumedTranscript,
    liveTail: { currentToolCall: null, narrationBuffer: "" },
    spinner: null,
    statusBar: {
      iter: 0,
      costUsd: 0,
      dailyUsedUsd: initialValues?.dailyUsedUsd ?? 0,
      capUsd: initialValues?.capUsd ?? 10,
      model: initialValues?.modelSettings?.model ?? initialValues?.model ?? "",
      tokenBudgetRatio: 0,
      cumulativeTokens: 0,
    },
    runState: "idle",
    runStartMs: undefined,
    runEndMs: undefined,
    toastQueue: [],
    modalStack: [],
    pendingApproval: null,
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
  };
}

export type StoreAction =
  | { type: "SPINNER_START"; label: string }
  | { type: "SPINNER_UPDATE"; label: string }
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
  | { type: "PHASE_MARKER"; phase: string }
  | { type: "ERROR_LINE"; text: string }
  | { type: "RUN_DONE" }
  | { type: "RUN_ABORTED" }
  | { type: "RUN_FAILED" }
  | { type: "USER_PROMPT"; text: string }
  | { type: "ASSISTANT_FINAL"; text: string }
  | { type: "TRANSCRIPT_CLEAR" }
  | { type: "TRANSCRIPT_REMOUNT" }
  | { type: "PENDING_APPROVAL_SET"; approvalId: string; runId: string; command: string; kind?: "command" | "edit" | "trust" }
  | { type: "PENDING_APPROVAL_RESOLVED" }
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
  | { type: "FEEDBACK_MODAL_OPEN"; runId: string; logs: string }
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
  | { type: "MCP_TRUST_DENIED" };

export function reducer(state: StoreState, action: StoreAction): StoreState {
  switch (action.type) {
    case "SPINNER_START":
      return {
        ...state,
        spinner: { active: true, label: action.label },
        runState: "running",
        // Reset the per-task timer only when ENTERING a run. A mid-run
        // SPINNER_START (e.g. a nested/subagent loop) keeps the original start.
        // The previous `state.runStartMs ?? Date.now()` captured the start once
        // on the first task and never reset it → durations grew monotonically
        // across the whole session (116 → 532 → 1276 …).
        runStartMs: state.runState === "running" ? state.runStartMs : Date.now(),
        runEndMs: state.runState === "running" ? state.runEndMs : undefined,
      };
    case "SPINNER_UPDATE":
      return { ...state, spinner: { active: true, label: action.label } };
    case "SPINNER_STOP":
      return { ...state, spinner: null };

    case "TOOL_CALL_OPEN":
      return {
        ...state,
        liveTail: {
          ...state.liveTail,
          currentToolCall: { toolName: action.toolName, args: action.args, patch: action.patch },
        },
      };

    case "TOOL_RESULT_PUSH": {
      const tc = state.liveTail.currentToolCall;
      if (!tc) return state;
      // Always append a fresh entry. Ink's <Static> renders each index once and
      // never re-renders existing items, so updating in-place would make repeated
      // approvals of the same command invisible. One entry per call is correct.
      const entry: TranscriptEntry = {
        kind: "tool_call",
        toolName: tc.toolName,
        args: tc.args,
        ...(tc.patch ? { patch: tc.patch } : {}),
        results: [{ ok: action.ok, detail: action.detail, ...(action.blocked ? { blocked: true as const } : {}) }],
      };
      return { ...state, transcript: [...state.transcript, entry] };
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

    case "PHASE_MARKER":
      return {
        ...state,
        transcript: [...state.transcript, { kind: "phase_marker", phase: action.phase }],
      };

    case "ERROR_LINE":
      return {
        ...state,
        transcript: [...state.transcript, { kind: "error", text: action.text }],
      };

    case "RUN_DONE":
      return {
        ...state,
        spinner: null,
        runState: "done",
        // Freeze the duration at completion (excludes idle / reading time).
        runEndMs: Date.now(),
        liveTail: { ...state.liveTail, currentToolCall: null },
      };

    case "RUN_ABORTED":
      return {
        ...state,
        spinner: null,
        runState: "aborted",
        runEndMs: Date.now(),
        liveTail: { ...state.liveTail, currentToolCall: null },
      };

    case "RUN_FAILED":
      return {
        ...state,
        spinner: null,
        runState: "failed",
        runEndMs: Date.now(),
        liveTail: { ...state.liveTail, currentToolCall: null },
      };

    case "USER_PROMPT":
      return {
        ...state,
        todos: [],
        transcript: [...state.transcript, { kind: "user_prompt", text: action.text }],
      };

    case "ASSISTANT_FINAL":
      return {
        ...state,
        transcript: [...state.transcript, { kind: "assistant_final", text: action.text }],
      };

    case "POST_EXECUTE_DIFFS":
      return { ...state, transcript: [...state.transcript, { kind: "post_execute_diffs", files: action.files }] };

    case "TRANSCRIPT_CLEAR":
      return { ...state, transcript: [], todos: [] };

    case "TRANSCRIPT_REMOUNT":
      return { ...state, transcriptGeneration: state.transcriptGeneration + 1 };

    case "PENDING_APPROVAL_SET":
      return { ...state, pendingApproval: { approvalId: action.approvalId, runId: action.runId, command: action.command, kind: action.kind } };

    case "PENDING_APPROVAL_RESOLVED":
      return { ...state, pendingApproval: null };

    case "SESSION_TRUST_PREFIX":
      return { ...state, sessionTrustedPrefixes: [...state.sessionTrustedPrefixes, action.prefix] };

    case "PERMISSIONS_OPEN":
      return { ...state, modalView: "permissions", permissionsList: action.list, permissionsSelectedIndex: 0 };

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
      return { ...state, modalView: "keys", keysList: action.list, keysSelectedIndex: 0, keysEditMode: "view", keysEditInput: "", keysEditProvider: null };

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
      return { ...state, keysEditMode: "select-provider", keysEditInput: "", keysEditProvider: null };

    case "KEYS_START_EDIT":
      return { ...state, keysEditMode: "input", keysEditProvider: action.provider, keysEditInput: "" };

    case "KEYS_PROVIDER_SELECTED":
      return { ...state, keysEditMode: "input", keysEditProvider: action.provider, keysEditInput: "" };

    case "KEYS_INPUT_CHAR":
      return { ...state, keysEditInput: state.keysEditInput + action.ch };

    case "KEYS_INPUT_BACKSPACE":
      return { ...state, keysEditInput: state.keysEditInput.slice(0, -1) };

    case "KEYS_INPUT_CANCEL":
      return { ...state, keysEditMode: "view", keysEditInput: "", keysEditProvider: null };

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
      return { ...state, modalView: "sessions", sessionsList: deduped, sessionsSelectedIndex: 0 };
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
        liveTail: { currentToolCall: null, narrationBuffer: "" },
        spinner: null,
        runState: "idle",
        runStartMs: undefined,
        runEndMs: undefined,
        modalView: "none",
        planReadyProposal: null,
        statusBar: { ...state.statusBar, costUsd: 0, iter: 0 },
        transcriptGeneration: state.transcriptGeneration + 1,
        todos: [],
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

    case "PLAN_READY_PROPOSED":
      return {
        ...state,
        modalView: "plan_ready",
        planReadyProposal: {
          planId: action.planId,
          runId: action.runId,
          objective: action.objective,
          steps: action.steps,
          ...(action.scopeNotes ? { scopeNotes: action.scopeNotes } : {}),
        },
      };

    case "PLAN_READY_RESOLVED":
      // Plan mode is sticky (Claude-Code-like): keep state.mode so follow-up
      // tasks stay in plan mode until the user toggles out via Shift+Tab.
      return { ...state, modalView: "none", planReadyProposal: null };

    case "STAGED_DIFFS_PROPOSED":
      return {
        ...state,
        modalView: "staged_diffs",
        stagedDiffProposal: {
          approvalId: action.approvalId,
          runId: action.runId,
          files: action.files,
          verificationSummary: action.verificationSummary,
          trigger: action.trigger,
        },
      };

    case "STAGED_DIFFS_RESOLVED":
      return { ...state, modalView: "none", stagedDiffProposal: null };

    case "TRANSCRIPT_APPEND_NARRATION":
      if (!action.text) return state;
      return { ...state, liveTail: { ...state.liveTail, narrationBuffer: state.liveTail.narrationBuffer + action.text } };

    case "TRANSCRIPT_ADD_THINKING":
      if (!action.text) return state;
      return { ...state, transcript: [...state.transcript, { kind: "thinking" as const, text: action.text }] };

    case "NARRATION_COMMIT": {
      const { narrationBuffer } = state.liveTail;
      if (!narrationBuffer) return state;
      const last = state.transcript[state.transcript.length - 1];
      const narEntry: TranscriptEntry = { kind: "narration", text: narrationBuffer };
      const newTranscript = last?.kind === "narration"
        ? [...state.transcript.slice(0, -1), { kind: "narration" as const, text: last.text + narrationBuffer }]
        : [...state.transcript, narEntry];
      return { ...state, transcript: newTranscript, liveTail: { ...state.liveTail, narrationBuffer: "" } };
    }

    case "MODEL_MODAL_OPEN":
      return { ...state, modalView: "model" };

    case "MODEL_MODAL_CLOSE":
      return { ...state, modalView: "none" };

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
      };
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
        ...state,
        sessionId: action.newSessionId,
        modalView: "none",
        transcript: [
          ...state.transcript,
          { kind: "user_prompt" as const, text: "Session memory cleared — starting fresh." },
        ],
      };

    case "COMMIT_MODAL_OPEN":
      return { ...state, modalView: "commit", commitData: { filePaths: action.filePaths, message: action.message, repoPath: action.repoPath } };

    case "COMMIT_MODAL_CLOSE":
      return { ...state, modalView: "none" };

    case "FEEDBACK_MODAL_OPEN":
      return { ...state, modalView: "feedback", feedbackData: { runId: action.runId, logs: action.logs } };

    case "FEEDBACK_MODAL_CLOSE":
      return { ...state, modalView: "none" };

    case "UNDO_MODAL_OPEN":
      return { ...state, modalView: "undo", undoModalData: { manifest: action.manifest, driftedPaths: action.driftedPaths } };

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

    case "TODOS_SET":
      return { ...state, todos: action.todos };

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

    default:
      return state;
  }
}

const StoreContext = createContext<{ state: StoreState; dispatch: Dispatch<StoreAction> } | null>(null);

export function useStore(): { state: StoreState; dispatch: Dispatch<StoreAction> } {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside StoreProvider");
  return ctx;
}

export function StoreProvider({
  children,
  initialValues,
}: {
  children: React.ReactNode;
  initialValues?: {
    model: string;
    capUsd: number;
    dailyUsedUsd?: number;
    trustedPrefixes?: string[];
    resumedTranscript?: TranscriptEntry[];
    resumedSessionId?: string;
    resumedStartedAt?: string;
    modelSettings?: DiskModelSettings | null;
    userCommands?: UserCommand[];
    mode?: TuiMode;
    armedUserHooks?: UserHooksConfig | null;
    pendingHookTrust?: { config: UserHooksConfig; hash: string; projectPath: string } | null;
    armedMcpManager?: import("../../mcp/mcpClientManager.js").McpClientManager | null;
    pendingMcpTrust?: { config: import("../../api/diskMcp.js").McpConfig; hash: string; projectPath: string } | null;
  };
}): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    buildInitialState(initialValues)
  );
  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      {children}
    </StoreContext.Provider>
  );
}
