import { Box, Text, useInput, useApp } from "ink";
import { useEffect, useRef } from "react";
import { StoreProvider, useStore } from "./store.js";
import { useAgentEvents } from "./hooks/useAgentEvents.js";
import { Transcript } from "./components/Transcript.js";
import { Spinner } from "./components/Spinner.js";
import { StatusBar } from "./components/StatusBar.js";
import { Toast } from "./components/Toast.js";
import { Composer } from "./components/Composer.js";
import { ApprovalModal } from "./components/ApprovalModal.js";
import { PermissionsView } from "./components/PermissionsView.js";
import { ApiKeysView } from "./components/ApiKeysView.js";
import { SessionsModal } from "./components/SessionsModal.js";
import { PlanModal } from "./components/PlanModal.js";
import { PlanReadyModal } from "./components/PlanReadyModal.js";
import { ModelModal } from "./components/ModelModal.js";
import { EffortModal } from "./components/EffortModal.js";
import { MetricsModal } from "./components/MetricsModal.js";
import { LimitsModal } from "./components/LimitsModal.js";
import { resolveCommandApproval } from "../../api/commandApprovals.js";
import { resolvePlanApproval } from "../../llm/planApprovals.js";
import type { EventBus } from "../eventBus.js";
import type { DiskSession } from "../../api/diskSessions.js";
import type { DiskModelSettings } from "../../api/diskModel.js";
import type { EffortLevel } from "../../llm/modelRegistry.js";
import type { StoreState, TuiMode } from "./store.js";

interface AppProps {
  initialPrompt?: string;
  bus?: EventBus;
  initialModel?: string;
  capUsd?: number;
  onSubmit?: (prompt: string, ac: AbortController, mode: TuiMode) => void;
  initialTrustedPrefixes?: string[];
  resumedSession?: DiskSession;
  onStateChange?: (state: StoreState) => void;
  initialModelSettings?: DiskModelSettings | null;
  onModelApply?: (model: string, provider: "anthropic" | "openai" | "gemini", effort?: EffortLevel) => void;
}

interface AppInnerProps {
  bus: EventBus | undefined;
  initialPrompt: string | undefined;
  onSubmit: ((prompt: string, ac: AbortController, mode: TuiMode) => void) | undefined;
  onStateChange: ((state: StoreState) => void) | undefined;
  onModelApply: ((model: string, provider: "anthropic" | "openai" | "gemini", effort?: EffortLevel) => void) | undefined;
}

function AppInner({ bus, initialPrompt, onSubmit, onStateChange, onModelApply }: AppInnerProps): React.ReactElement {
  const { exit } = useApp();
  const { state, dispatch } = useStore();
  const runAcRef = useRef<AbortController | null>(null);
  const sessionTrustedPrefixesRef = useRef<string[]>(state.sessionTrustedPrefixes);
  useEffect(() => {
    sessionTrustedPrefixesRef.current = state.sessionTrustedPrefixes;
  }, [state.sessionTrustedPrefixes]);
  const modeRef = useRef<TuiMode>(state.mode);
  useEffect(() => { modeRef.current = state.mode; }, [state.mode]);
  useEffect(() => {
    onStateChange?.(state);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Propagate model/effort selection back to the live config so next run uses the selected model.
  useEffect(() => {
    if (state.modelSettings) {
      onModelApply?.(state.modelSettings.model, state.modelSettings.provider, state.modelSettings.effort);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.modelSettings]);

  // Start the initial run exactly once on mount if a prompt was provided at launch.
  useEffect(() => {
    if (initialPrompt !== undefined && onSubmit) {
      const ac = new AbortController();
      runAcRef.current = ac;
      dispatch({ type: "USER_PROMPT", text: initialPrompt });
      onSubmit(initialPrompt, ac, "normal");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // autoAccept: resolve pending command approvals automatically
  useEffect(() => {
    if (state.mode !== "autoAccept" || state.pendingApproval === null) return;
    const { approvalId, runId } = state.pendingApproval;
    resolveCommandApproval({ approvalId, runId, approved: true });
    dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
  }, [state.pendingApproval, state.mode]);

  // autoAccept: resolve plan-ready approval as "accept_all" automatically
  useEffect(() => {
    if (state.mode !== "autoAccept" || state.planReadyProposal === null) return;
    const { planId, runId } = state.planReadyProposal;
    resolvePlanApproval({ planId, runId, decision: "accept_all" });
    dispatch({ type: "PLAN_READY_RESOLVED" });
  }, [state.planReadyProposal, state.mode]);

  // Anchor stdin so Ink doesn't auto-unmount via beforeExit when the event loop empties.
  useInput((input, key) => {
    // Ctrl+C — always exit. In TTY raw mode, SIGINT never fires; \x03 arrives here instead.
    if (input === "\x03") {
      runAcRef.current?.abort();
      exit();
      return;
    }
    // Shift+Tab — cycle mode (normal → autoAccept → plan → normal)
    if (key.shift && key.tab) {
      dispatch({ type: "MODE_CYCLE" });
      return;
    }
    // Esc — abort running task only; never exit TUI. Skip when approval modal is active.
    if (key.escape && state.runState === "running" && state.pendingApproval === null && state.modalView === "none") {
      runAcRef.current?.abort();
      dispatch({ type: "NARRATION_COMMIT" });
      dispatch({ type: "RUN_ABORTED" });
    }
  });

  useAgentEvents(bus, dispatch, sessionTrustedPrefixesRef, modeRef);

  const handleComposerSubmit = (text: string, ac: AbortController): void => {
    runAcRef.current = ac;
    onSubmit?.(text, ac, state.mode);
  };

  const modals = (
    <>
      {state.toastQueue.length > 0 && <Toast toast={state.toastQueue[0]} />}
      {state.pendingApproval !== null && (
        <ApprovalModal
          approvalId={state.pendingApproval.approvalId}
          runId={state.pendingApproval.runId}
          command={state.pendingApproval.command}
          dispatch={dispatch}
        />
      )}
      {state.modalView === "permissions" && <PermissionsView />}
      {state.modalView === "keys" && <ApiKeysView />}
      {state.modalView === "sessions" && <SessionsModal />}
      {state.modalView === "model" && <ModelModal dispatch={dispatch} />}
      {state.modalView === "effort" && <EffortModal dispatch={dispatch} />}
      {state.modalView === "metrics" && <MetricsModal />}
      {state.modalView === "limits" && <LimitsModal />}
      {state.planProposal !== null && (
        <PlanModal proposal={state.planProposal} dispatch={dispatch} />
      )}
      {state.planReadyProposal !== null && (
        <PlanReadyModal proposal={state.planReadyProposal} dispatch={dispatch} />
      )}
    </>
  );

  return (
    <Box flexDirection="column">
      <Box paddingX={2}>
        <Transcript />
      </Box>
      <Spinner />
      {modals}
      <Composer onSubmit={handleComposerSubmit} onExit={exit} />
      <StatusBar />
    </Box>
  );
}

export function App({ initialPrompt, bus, initialModel, capUsd, onSubmit, initialTrustedPrefixes, resumedSession, onStateChange, initialModelSettings, onModelApply }: AppProps): React.ReactElement {
  return (
    <StoreProvider initialValues={{
      model: initialModel ?? "",
      capUsd: capUsd ?? 10,
      trustedPrefixes: initialTrustedPrefixes ?? [],
      resumedTranscript: resumedSession?.transcript,
      resumedSessionId: resumedSession?.sessionId,
      resumedStartedAt: resumedSession?.startedAt,
      modelSettings: initialModelSettings,
    }}>
      <AppInner bus={bus} initialPrompt={initialPrompt} onSubmit={onSubmit} onStateChange={onStateChange} onModelApply={onModelApply} />
    </StoreProvider>
  );
}
