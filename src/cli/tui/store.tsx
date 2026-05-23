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
  | { kind: "tool_call"; toolName: string; args: string; results: { ok: boolean; detail: string }[] }
  | { kind: "error"; text: string }
  | { kind: "phase_marker"; phase: string }
  | { kind: "run_summary"; text: string };

export type StatusBar = {
  iter: number;
  costUsd: number;
  model: string;
  tokenBudgetRatio: number;
};

export type StoreState = {
  transcript: TranscriptEntry[];
  liveTail: LiveTailState;
  spinner: { active: boolean; label: string } | null;
  statusBar: StatusBar;
  toastQueue: ToastEntry[];
  modalStack: ModalEntry[];
};

const initialState: StoreState = {
  transcript: [],
  liveTail: { narrationBuffer: "", currentToolCall: null },
  spinner: null,
  statusBar: { iter: 0, costUsd: 0, model: "", tokenBudgetRatio: 0 },
  toastQueue: [],
  modalStack: [],
};

export type StoreAction =
  | { type: "SPINNER_START"; label: string }
  | { type: "SPINNER_UPDATE"; label: string }
  | { type: "SPINNER_STOP" }
  | { type: "NARRATION_APPEND"; text: string }
  | { type: "FLUSH_NARRATION" }
  | { type: "TOOL_CALL_OPEN"; toolName: string; args: string }
  | { type: "TOOL_RESULT_PUSH"; ok: boolean; detail: string }
  | { type: "TOOL_CALL_CLOSE" }
  | { type: "STATUS_UPDATE"; iter?: number; costUsd?: number; tokenBudgetRatio?: number }
  | { type: "TOAST_PUSH"; entry: ToastEntry }
  | { type: "TOAST_POP" }
  | { type: "PHASE_MARKER"; phase: string }
  | { type: "RUN_SUMMARY"; text: string }
  | { type: "ERROR_LINE"; text: string };

function reducer(state: StoreState, action: StoreAction): StoreState {
  switch (action.type) {
    case "SPINNER_START":
      return { ...state, spinner: { active: true, label: action.label } };
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
      const existing = [...state.transcript].reverse().find(
        (e): e is Extract<TranscriptEntry, { kind: "tool_call" }> =>
          e.kind === "tool_call" && e.toolName === tc.toolName && e.args === tc.args
      );
      if (existing) {
        const updated = state.transcript.map((e: TranscriptEntry) =>
          e === existing
            ? { ...existing, results: [...existing.results, { ok: action.ok, detail: action.detail }] }
            : e
        );
        return { ...state, transcript: updated };
      }
      const entry: TranscriptEntry = {
        kind: "tool_call",
        toolName: tc.toolName,
        args: tc.args,
        results: [{ ok: action.ok, detail: action.detail }],
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

    case "RUN_SUMMARY":
      return {
        ...state,
        transcript: [...state.transcript, { kind: "run_summary", text: action.text }],
      };

    case "ERROR_LINE":
      return {
        ...state,
        transcript: [...state.transcript, { kind: "error", text: action.text }],
      };

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

export function StoreProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      {children}
    </StoreContext.Provider>
  );
}
