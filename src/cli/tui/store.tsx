import { createContext, useContext, useReducer, type Dispatch } from "react";
import { randomUUID } from "node:crypto";
import type { DiskTrustEntry } from "../../api/diskTrust.js";
import type { DiskApiKey, ApiKeyProvider } from "../../api/diskKeys.js";
import type { DiskSession, SessionMeta } from "../../api/diskSessions.js";
import type { TuiMode } from "../dispatch.js";
import type { DiskModelSettings } from "../../api/diskModel.js";
import { supportsEffort } from "../../llm/modelRegistry.js";
import type { EffortLevel } from "../../llm/modelRegistry.js";

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
  currentToolCall: { toolName: string; args: string } | null;
  narrationBuffer: string;
};

export type TranscriptEntry =
  | { kind: "narration"; text: string }
  | { kind: "tool_call"; toolName: string; args: string; results: { ok: boolean; detail: string; blocked?: true }[] }
  | { kind: "error"; text: string }
  | { kind: "phase_marker"; phase: string }
  | { kind: "user_prompt"; text: string }
  | { kind: "assistant_final"; text: string };

export type StatusBarState = {
  iter: number;
  costUsd: number;
  capUsd: number;
  model: string;
  tokenBudgetRatio: number;
  cumulativeTokens: number;
};

export type RunState = "idle" | "running" | "done" | "aborted";

export type StoreState = {
  transcript: TranscriptEntry[];
  sessionId: string;
  sessionStartedAt: string;
  isResumed: boolean;
  liveTail: LiveTailState;
  spinner: { active: boolean; label: string } | null;
  statusBar: StatusBarState;
  runState: RunState;
  runStartMs?: number;
  toastQueue: ToastEntry[];
  modalStack: ModalEntry[];
  pendingApproval: { approvalId: string; runId: string; command: string } | null;
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
  modalView: "none" | "permissions" | "keys" | "sessions" | "plan" | "model" | "effort" | "metrics" | "limits";
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
};

export function buildInitialState(initialValues?: {
  model: string;
  capUsd: number;
  trustedPrefixes?: string[];
  resumedTranscript?: TranscriptEntry[];
  resumedSessionId?: string;
  resumedStartedAt?: string;
  modelSettings?: DiskModelSettings | null;
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
      capUsd: initialValues?.capUsd ?? 10,
      model: initialValues?.modelSettings?.model ?? initialValues?.model ?? "",
      tokenBudgetRatio: 0,
      cumulativeTokens: 0,
    },
    runState: "idle",
    runStartMs: undefined,
    toastQueue: [],
    modalStack: [],
    pendingApproval: null,
    sessionTrustedPrefixes: initialValues?.trustedPrefixes ?? [],
    mode: "normal",
    planProposal: null,
    modalView: "none",
    modelSettings: initialValues?.modelSettings ?? null,
    modelSelectedIndex: 0,
    effortSelectedIndex: 1,
    permissionsList: [],
    permissionsSelectedIndex: 0,
    keysList: [],
    keysSelectedIndex: 0,
    keysEditMode: "view",
    keysEditInput: "",
    keysEditProvider: null,
    sessionsList: [],
    sessionsSelectedIndex: 0,
  };
}

export type StoreAction =
  | { type: "SPINNER_START"; label: string }
  | { type: "SPINNER_UPDATE"; label: string }
  | { type: "SPINNER_STOP" }
  | { type: "TRANSCRIPT_APPEND_NARRATION"; text: string }
  | { type: "TOOL_CALL_OPEN"; toolName: string; args: string }
  | { type: "TOOL_RESULT_PUSH"; ok: boolean; detail: string; blocked?: true }
  | { type: "TOOL_CALL_CLOSE" }
  | { type: "STATUS_UPDATE"; iter?: number; costUsd?: number; tokenBudgetRatio?: number; tokens?: number }
  | { type: "TOAST_PUSH"; entry: ToastEntry }
  | { type: "TOAST_POP" }
  | { type: "PHASE_MARKER"; phase: string }
  | { type: "ERROR_LINE"; text: string }
  | { type: "RUN_DONE" }
  | { type: "RUN_ABORTED" }
  | { type: "USER_PROMPT"; text: string }
  | { type: "ASSISTANT_FINAL"; text: string }
  | { type: "TRANSCRIPT_CLEAR" }
  | { type: "PENDING_APPROVAL_SET"; approvalId: string; runId: string; command: string }
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
  | { type: "NARRATION_COMMIT" };

export function reducer(state: StoreState, action: StoreAction): StoreState {
  switch (action.type) {
    case "SPINNER_START":
      return {
        ...state,
        spinner: { active: true, label: action.label },
        runState: "running",
        runStartMs: state.runStartMs ?? Date.now(),
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
          currentToolCall: { toolName: action.toolName, args: action.args },
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
        liveTail: { ...state.liveTail, currentToolCall: null },
      };

    case "RUN_ABORTED":
      return {
        ...state,
        spinner: null,
        runState: "aborted",
        liveTail: { ...state.liveTail, currentToolCall: null },
      };

    case "USER_PROMPT":
      return {
        ...state,
        transcript: [...state.transcript, { kind: "user_prompt", text: action.text }],
      };

    case "ASSISTANT_FINAL":
      return {
        ...state,
        transcript: [...state.transcript, { kind: "assistant_final", text: action.text }],
      };

    case "TRANSCRIPT_CLEAR":
      return { ...state, transcript: [] };

    case "PENDING_APPROVAL_SET":
      return { ...state, pendingApproval: { approvalId: action.approvalId, runId: action.runId, command: action.command } };

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

    case "SESSIONS_OPEN":
      return { ...state, modalView: "sessions", sessionsList: action.list, sessionsSelectedIndex: 0 };

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
        modalView: "none",
        statusBar: { ...state.statusBar, costUsd: 0, iter: 0 },
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

    case "TRANSCRIPT_APPEND_NARRATION":
      if (!action.text) return state;
      return { ...state, liveTail: { ...state.liveTail, narrationBuffer: state.liveTail.narrationBuffer + action.text } };

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
      return {
        ...state,
        modelSettings: settings,
        statusBar: { ...state.statusBar, model: settings.model },
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

    case "EFFORT_APPLY": {
      const updated: DiskModelSettings = state.modelSettings
        ? { ...state.modelSettings, effort: action.effort, updatedAt: new Date().toISOString() }
        : { version: 2, model: "claude-sonnet-4-6", provider: "anthropic", effort: action.effort, updatedAt: new Date().toISOString() };
      return { ...state, modelSettings: updated, modalView: "none" };
    }

    case "EFFORT_NAV": {
      const EFFORT_COUNT = 3;
      const next = action.direction === "up"
        ? Math.max(0, state.effortSelectedIndex - 1)
        : Math.min(EFFORT_COUNT - 1, state.effortSelectedIndex + 1);
      return { ...state, effortSelectedIndex: next };
    }

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
    trustedPrefixes?: string[];
    resumedTranscript?: TranscriptEntry[];
    resumedSessionId?: string;
    resumedStartedAt?: string;
    modelSettings?: DiskModelSettings | null;
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
