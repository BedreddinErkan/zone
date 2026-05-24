import { createContext, useContext, useReducer, type Dispatch } from "react";
import { randomUUID } from "node:crypto";
import type { DiskTrustEntry } from "../../api/diskTrust.js";
import type { DiskApiKey, ApiKeyProvider } from "../../api/diskKeys.js";

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
  modalView: "none" | "permissions" | "keys";
  permissionsList: DiskTrustEntry[];
  permissionsSelectedIndex: number;
  keysList: DiskApiKey[];
  keysSelectedIndex: number;
  keysEditMode: "view" | "select-provider" | "input" | "confirm-delete";
  keysEditInput: string;
  keysEditProvider: ApiKeyProvider | null;
};

function buildInitialState(initialValues?: {
  model: string;
  capUsd: number;
  trustedPrefixes?: string[];
  resumedTranscript?: TranscriptEntry[];
  resumedSessionId?: string;
  resumedStartedAt?: string;
}): StoreState {
  return {
    transcript: initialValues?.resumedTranscript ?? [],
    sessionId: initialValues?.resumedSessionId ?? randomUUID(),
    sessionStartedAt: initialValues?.resumedStartedAt ?? new Date().toISOString(),
    isResumed: !!initialValues?.resumedTranscript,
    liveTail: { currentToolCall: null },
    spinner: null,
    statusBar: {
      iter: 0,
      costUsd: 0,
      capUsd: initialValues?.capUsd ?? 10,
      model: initialValues?.model ?? "",
      tokenBudgetRatio: 0,
      cumulativeTokens: 0,
    },
    runState: "idle",
    runStartMs: undefined,
    toastQueue: [],
    modalStack: [],
    pendingApproval: null,
    sessionTrustedPrefixes: initialValues?.trustedPrefixes ?? [],
    modalView: "none",
    permissionsList: [],
    permissionsSelectedIndex: 0,
    keysList: [],
    keysSelectedIndex: 0,
    keysEditMode: "view",
    keysEditInput: "",
    keysEditProvider: null,
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
  | { type: "KEYS_DELETE_CANCELED" };

function reducer(state: StoreState, action: StoreAction): StoreState {
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

    case "TRANSCRIPT_APPEND_NARRATION": {
      if (!action.text) return state;
      const last = state.transcript[state.transcript.length - 1];
      if (last?.kind === "narration") {
        const updated: TranscriptEntry = { kind: "narration", text: last.text + action.text };
        return { ...state, transcript: [...state.transcript.slice(0, -1), updated] };
      }
      return { ...state, transcript: [...state.transcript, { kind: "narration", text: action.text }] };
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
