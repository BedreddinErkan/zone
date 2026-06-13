import { Box, Text, useInput, useApp } from "ink";
import { useEffect, useRef, type Dispatch } from "react";
import { StoreProvider, useStore } from "./store.js";
import { useAgentEvents } from "./hooks/useAgentEvents.js";
import { Transcript } from "./components/Transcript.js";
import { Spinner } from "./components/Spinner.js";
import { StatusBar } from "./components/StatusBar.js";
import { Toast } from "./components/Toast.js";
import { Composer } from "./components/Composer.js";
import { ApprovalModal } from "./components/ApprovalModal.js";
import { TrustModal } from "./components/TrustModal.js";
import { PermissionsView } from "./components/PermissionsView.js";
import { ApiKeysView } from "./components/ApiKeysView.js";
import { SessionsModal } from "./components/SessionsModal.js";
import { PlanModal } from "./components/PlanModal.js";
import { PlanReadyModal } from "./components/PlanReadyModal.js";
import { StagedDiffModal } from "./components/StagedDiffModal.js";
import { ModelModal } from "./components/ModelModal.js";
import { EffortModal } from "./components/EffortModal.js";
import { SummaryModal } from "./components/SummaryModal.js";
import { PlanModeModal } from "./components/PlanModeModal.js";
import { SessionMemoryModal } from "./components/SessionMemoryModal.js";
import { MetricsModal } from "./components/MetricsModal.js";
import { LimitsModal } from "./components/LimitsModal.js";
import { CommitModal } from "./components/CommitModal.js";
import { UndoModal } from "./components/UndoModal.js";
import { PlanPanel } from "./components/PlanPanel.js";
import { resolveCommandApproval } from "../../api/commandApprovals.js";
import { resolveEditApproval } from "../../api/editApprovals.js";
import { resolvePlanApproval } from "../../llm/planApprovals.js";
import { resolveStagedApproval } from "../../api/stagedApprovals.js";
import type { EventBus } from "../eventBus.js";
import type { DiskSession } from "../../api/diskSessions.js";
import type { DiskModelSettings } from "../../api/diskModel.js";
import type { EffortLevel } from "../../llm/modelRegistry.js";
import type { StoreState, StoreAction, TuiMode } from "./store.js";
import type { UserCommand } from "./userCommands.js";

interface AppProps {
  initialPrompt?: string;
  initialMode?: TuiMode;
  bus?: EventBus;
  initialModel?: string;
  capUsd?: number;
  initialDailyUsedUsd?: number;
  onSubmit?: (prompt: string, ac: AbortController, mode: TuiMode, images?: import("../../api/imageUpload.js").ImageAttachment[]) => void;
  onUndoRequest?: () => void;
  initialTrustedPrefixes?: string[];
  resumedSession?: DiskSession;
  onStateChange?: (state: StoreState) => void;
  initialModelSettings?: DiskModelSettings | null;
  onModelApply?: (model: string, provider: "anthropic" | "openai", effort?: EffortLevel, summaryFormat?: "compact" | "detailed", memoryEnabled?: boolean, commitOnSuccess?: boolean) => void;
  getCommitData?: () => { filePaths: string[]; message: string; repoPath: string } | null;
  onDispatchCapture?: (dispatch: Dispatch<StoreAction>) => void;
  onSessionClear?: (oldSessionId: string) => void;
  initialUserCommands?: UserCommand[];
}

interface AppInnerProps {
  bus: EventBus | undefined;
  initialPrompt: string | undefined;
  initialMode: TuiMode | undefined;
  onSubmit: ((prompt: string, ac: AbortController, mode: TuiMode, images?: import("../../api/imageUpload.js").ImageAttachment[]) => void) | undefined;
  onUndoRequest: (() => void) | undefined;
  onStateChange: ((state: StoreState) => void) | undefined;
  onModelApply: ((model: string, provider: "anthropic" | "openai", effort?: EffortLevel, summaryFormat?: "compact" | "detailed", memoryEnabled?: boolean, commitOnSuccess?: boolean) => void) | undefined;
  getCommitData: (() => { filePaths: string[]; message: string; repoPath: string } | null) | undefined;
  onDispatchCapture: ((dispatch: Dispatch<StoreAction>) => void) | undefined;
  onSessionClear: ((oldSessionId: string) => void) | undefined;
}

function AppInner({ bus, initialPrompt, initialMode, onSubmit, onUndoRequest, onStateChange, onModelApply, getCommitData, onDispatchCapture, onSessionClear }: AppInnerProps): React.ReactElement {
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

  // Capture dispatch once for use in imperative code outside React (e.g. auto-commit toasts).
  useEffect(() => { onDispatchCapture?.(dispatch); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Propagate model/effort selection back to the live config so next run uses the selected model.
  useEffect(() => {
    if (state.modelSettings) {
      onModelApply?.(state.modelSettings.model, state.modelSettings.provider, state.modelSettings.effort, state.modelSettings.summaryFormat, state.modelSettings.memoryEnabled, state.modelSettings.commitOnSuccess);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.modelSettings]);

  // Start the initial run exactly once on mount if a prompt was provided at launch.
  useEffect(() => {
    if (initialPrompt !== undefined && onSubmit) {
      const ac = new AbortController();
      runAcRef.current = ac;
      dispatch({ type: "USER_PROMPT", text: initialPrompt });
      onSubmit(initialPrompt, ac, initialMode ?? "normal");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // autoAccept: resolve pending approvals automatically (kind-aware)
  useEffect(() => {
    if (state.mode !== "autoAccept" || state.pendingApproval === null) return;
    const { approvalId, runId, kind } = state.pendingApproval;
    if (kind === "edit") {
      resolveEditApproval({ approvalId, runId, approved: true });
    } else {
      resolveCommandApproval({ approvalId, runId, approved: true });
    }
    dispatch({ type: "PENDING_APPROVAL_RESOLVED" });
  }, [state.pendingApproval, state.mode]);

  // autoAccept: resolve plan-ready approval as "accept_all" automatically
  useEffect(() => {
    if (state.mode !== "autoAccept" || state.planReadyProposal === null) return;
    const { planId, runId } = state.planReadyProposal;
    resolvePlanApproval({ planId, runId, decision: "accept_all" });
    dispatch({ type: "PLAN_READY_RESOLVED" });
  }, [state.planReadyProposal, state.mode]);

  // autoAccept: resolve staged-diff checkpoint as "approve_all" automatically
  useEffect(() => {
    if (state.mode !== "autoAccept" || state.stagedDiffProposal === null) return;
    const { approvalId, runId } = state.stagedDiffProposal;
    resolveStagedApproval({ approvalId, runId, decision: "approve_all" });
    dispatch({ type: "STAGED_DIFFS_RESOLVED" });
  }, [state.stagedDiffProposal, state.mode]);

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

  const handleComposerSubmit = (text: string, ac: AbortController, images?: import("../../api/imageUpload.js").ImageAttachment[]): void => {
    runAcRef.current = ac;
    onSubmit?.(text, ac, state.mode, images);
  };

  const modals = (
    <>
      {state.toastQueue.length > 0 && <Toast toast={state.toastQueue[0]} />}
      {state.pendingApproval !== null && state.pendingApproval.kind !== "trust" && (
        <ApprovalModal
          approvalId={state.pendingApproval.approvalId}
          runId={state.pendingApproval.runId}
          command={state.pendingApproval.command}
          kind={state.pendingApproval.kind}
          dispatch={dispatch}
        />
      )}
      {state.pendingApproval?.kind === "trust" && (
        <TrustModal
          runId={state.pendingApproval.runId}
          projectPath={state.pendingApproval.command}
          dispatch={dispatch}
        />
      )}
      {state.modalView === "permissions" && <PermissionsView />}
      {state.modalView === "keys" && <ApiKeysView />}
      {state.modalView === "sessions" && <SessionsModal />}
      {state.modalView === "model" && <ModelModal dispatch={dispatch} />}
      {state.modalView === "effort" && <EffortModal dispatch={dispatch} />}
      {state.modalView === "summary" && <SummaryModal dispatch={dispatch} />}
      {state.modalView === "planMode" && <PlanModeModal dispatch={dispatch} />}
      {state.modalView === "session" && <SessionMemoryModal dispatch={dispatch} onSessionClear={onSessionClear} />}
      {state.modalView === "metrics" && <MetricsModal />}
      {state.modalView === "limits" && <LimitsModal />}
      {state.modalView === "commit" && <CommitModal dispatch={dispatch} />}
      {state.modalView === "undo" && state.undoModalData !== null && <UndoModal data={state.undoModalData} dispatch={dispatch} />}
      {state.planProposal !== null && (
        <PlanModal proposal={state.planProposal} dispatch={dispatch} />
      )}
      {state.planReadyProposal !== null && (
        <PlanReadyModal proposal={state.planReadyProposal} dispatch={dispatch} />
      )}
      {state.stagedDiffProposal !== null && (
        <StagedDiffModal proposal={state.stagedDiffProposal} dispatch={dispatch} />
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
      <Composer
        onSubmit={handleComposerSubmit}
        onExit={() => { runAcRef.current?.abort(); exit(); }}
        onInitStart={(ac) => { runAcRef.current = ac; }}
        onUndoRequest={onUndoRequest}
        getCommitData={getCommitData}
      />
      {state.runState === "running" && state.todos.length > 0 && (
        <PlanPanel todos={state.todos} />
      )}
      <StatusBar />
    </Box>
  );
}

export function App({ initialPrompt, initialMode, bus, initialModel, capUsd, initialDailyUsedUsd, onSubmit, onUndoRequest, initialTrustedPrefixes, resumedSession, onStateChange, initialModelSettings, onModelApply, getCommitData, onDispatchCapture, onSessionClear, initialUserCommands }: AppProps): React.ReactElement {
  return (
    <StoreProvider initialValues={{
      model: initialModel ?? "",
      capUsd: capUsd ?? 10,
      dailyUsedUsd: initialDailyUsedUsd ?? 0,
      trustedPrefixes: initialTrustedPrefixes ?? [],
      resumedTranscript: resumedSession?.transcript,
      resumedSessionId: resumedSession?.sessionId,
      resumedStartedAt: resumedSession?.startedAt,
      modelSettings: initialModelSettings,
      userCommands: initialUserCommands ?? [],
      mode: initialMode,
    }}>
      <AppInner bus={bus} initialPrompt={initialPrompt} initialMode={initialMode} onSubmit={onSubmit} onUndoRequest={onUndoRequest} onStateChange={onStateChange} onModelApply={onModelApply} getCommitData={getCommitData} onDispatchCapture={onDispatchCapture} onSessionClear={onSessionClear} />
    </StoreProvider>
  );
}
