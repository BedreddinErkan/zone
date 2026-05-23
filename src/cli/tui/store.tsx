import { createContext, useContext, useReducer, type Dispatch } from "react";

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
  narrationBuffer: string;
  currentToolCall: { toolName: string; args: string } | null;
};

export type TranscriptEntry =
  | { kind: "assistant"; text: string }
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
  transcriptGeneration: number;  // incremented on TRANSCRIPT_CLEAR to force remount
  liveTail: LiveTailState;
  spinner: { active: boolean; label: string } | null;
  statusBar: StatusBarState;
  runState: RunState;
  runStartMs?: number;
  toastQueue: ToastEntry[];
  modalStack: ModalEntry[];
  pendingApproval: { approvalId: string; runId: string; command: string } | null;
  sessionTrustedPrefixes: string[];
};

function buildInitialState(initialValues?: { model: string; capUsd: number; trustedPrefixes?: string[] }): StoreState {
  return {
    transcript: [],
    transcriptGeneration: 0,
    liveTail: { narrationBuffer: "", currentToolCall: null },
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
  };
}

export type StoreAction =
  | { type: "SPINNER_START"; label: string }
  | { type: "SPINNER_UPDATE"; label: string }
  | { type: "SPINNER_STOP" }
  | { type: "NARRATION_APPEND"; text: string }
  | { type: "FLUSH_NARRATION" }
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
  | { type: "SESSION_TRUST_PREFIX"; prefix: string };

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

    case "NARRATION_APPEND":
      return {
        ...state,
        liveTail: {
          ...state.liveTail,
          narrationBuffer: state.liveTail.narrationBuffer + action.text,
        },
      };

    case "FLUSH_NARRATION": {
      if (!state.liveTail.narrationBuffer) return state;
      const entry: TranscriptEntry = { kind: "assistant", text: state.liveTail.narrationBuffer };
      return {
        ...state,
        transcript: [...state.transcript, entry],
        liveTail: { ...state.liveTail, narrationBuffer: "" },
      };
    }

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
      return { ...state, transcript: [], transcriptGeneration: state.transcriptGeneration + 1 };

    case "PENDING_APPROVAL_SET":
      return { ...state, pendingApproval: { approvalId: action.approvalId, runId: action.runId, command: action.command } };

    case "PENDING_APPROVAL_RESOLVED":
      return { ...state, pendingApproval: null };

    case "SESSION_TRUST_PREFIX":
      return { ...state, sessionTrustedPrefixes: [...state.sessionTrustedPrefixes, action.prefix] };

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
  initialValues?: { model: string; capUsd: number; trustedPrefixes?: string[] };
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
