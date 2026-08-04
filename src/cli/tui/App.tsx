import { Box, useInput, useApp } from "ink";
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
import { PlanActionPrompt } from "./components/PlanActionPrompt.js";
import { StagedDiffModal } from "./components/StagedDiffModal.js";
import { ModelModal } from "./components/ModelModal.js";
import { EffortModal } from "./components/EffortModal.js";
import { SummaryModal } from "./components/SummaryModal.js";
import { PlanModeModal } from "./components/PlanModeModal.js";
import { SessionMemoryModal } from "./components/SessionMemoryModal.js";
import { MetricsModal } from "./components/MetricsModal.js";
import { LimitsModal } from "./components/LimitsModal.js";
import { CommitModal } from "./components/CommitModal.js";
import { FeedbackModal } from "./components/FeedbackModal.js";
import { UndoModal } from "./components/UndoModal.js";
import { HookTrustModal } from "./components/HookTrustModal.js";
import { McpTrustModal } from "./components/McpTrustModal.js";
import { PlanPanel } from "./components/PlanPanel.js";
import { QuestionPanel } from "./components/QuestionPanel.js";
import { resolveCommandApproval } from "../../api/commandApprovals.js";
import { resolveEditApproval } from "../../api/editApprovals.js";
import { declineUserQuestion } from "../../api/questionApprovals.js";
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
  onRemoteControlCommand?: (argsText: string) => void;
  onEnvelopeResume?: (envelopeKey?: string) => void;
  /** Answer a question carried over from a previous process — starts the resumed run. */
  onCarriedAnswer?: (answer: string, ac: AbortController) => void;
  /** Set the suspended run aside without starting it. Never deletes it. */
  onCarriedDiscard?: (envelopeKey: string, iter: number) => void;
  initialTrustedPrefixes?: string[];
  resumedSession?: DiskSession;
  initialSessionId?: string;
  onStateChange?: (state: StoreState) => void;
  initialModelSettings?: DiskModelSettings | null;
  onModelApply?: (model: string, provider: "anthropic" | "openai", effort?: EffortLevel, summaryFormat?: "compact" | "detailed", memoryEnabled?: boolean, commitOnSuccess?: boolean) => void;
  getCommitData?: () => { filePaths: string[]; message: string; repoPath: string } | null;
  getFeedbackData?: () => { runId: string; sessionId: string; logs: string; version: string; repoPath: string } | null;
  onDispatchCapture?: (dispatch: Dispatch<StoreAction>) => void;
  onSessionClear?: (oldSessionId: string) => void;
  initialUserCommands?: UserCommand[];
  initialArmedUserHooks?: import("../../api/diskHooks.js").UserHooksConfig | null;
  initialPendingHookTrust?: { config: import("../../api/diskHooks.js").UserHooksConfig; hash: string; projectPath: string } | null;
  initialArmedMcpManager?: import("../../mcp/mcpClientManager.js").McpClientManager | null;
  initialPendingMcpTrust?: { config: import("../../api/diskMcp.js").McpConfig; hash: string; projectPath: string } | null;
  /** --resume landing on an envelope that stopped mid-question. */
  initialCarriedQuestion?: Extract<import("./store-core.js").PendingQuestion, { kind: "carried" }> | null;
}

interface AppInnerProps {
  bus: EventBus | undefined;
  initialPrompt: string | undefined;
  initialMode: TuiMode | undefined;
  onSubmit: ((prompt: string, ac: AbortController, mode: TuiMode, images?: import("../../api/imageUpload.js").ImageAttachment[]) => void) | undefined;
  onUndoRequest: (() => void) | undefined;
  onRemoteControlCommand: ((argsText: string) => void) | undefined;
  onEnvelopeResume: ((envelopeKey?: string) => void) | undefined;
  onCarriedAnswer: ((answer: string, ac: AbortController) => void) | undefined;
  onCarriedDiscard: ((envelopeKey: string, iter: number) => void) | undefined;
  onStateChange: ((state: StoreState) => void) | undefined;
  onModelApply: ((model: string, provider: "anthropic" | "openai", effort?: EffortLevel, summaryFormat?: "compact" | "detailed", memoryEnabled?: boolean, commitOnSuccess?: boolean) => void) | undefined;
  getCommitData: (() => { filePaths: string[]; message: string; repoPath: string } | null) | undefined;
  getFeedbackData: (() => { runId: string; sessionId: string; logs: string; version: string; repoPath: string } | null) | undefined;
  onDispatchCapture: ((dispatch: Dispatch<StoreAction>) => void) | undefined;
  onSessionClear: ((oldSessionId: string) => void) | undefined;
}

function AppInner({ bus, initialPrompt, initialMode, onSubmit, onUndoRequest, onRemoteControlCommand, onEnvelopeResume, onCarriedAnswer, onCarriedDiscard, onStateChange, onModelApply, getCommitData, getFeedbackData, onDispatchCapture, onSessionClear }: AppInnerProps): React.ReactElement {
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
    // Esc with a question pending — discard the question, leave the run alive.
    // Checked first: while parked the run state is awaiting_input rather than
    // running, so the abort branch below cannot fire, but the ordering makes the
    // precedence legible instead of incidental.
    if (key.escape && state.pendingQuestion !== null && state.modalView === "none") {
      const pending = state.pendingQuestion;
      if (pending.kind === "live") {
        // The loop is parked awaiting a tool_result, so the decline must return one.
        declineUserQuestion({ questionId: pending.questionId, runId: pending.runId });
        dispatch({ type: "USER_QUESTION_RESOLVED" });
      } else {
        // No loop to reply to — the suspended run is set aside instead. Not
        // deleted: it can hold the only copy of staged work.
        onCarriedDiscard?.(pending.runId, pending.iter);
        dispatch({ type: "USER_QUESTION_DISMISSED" });
      }
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
      {state.modalView === "feedback" && <FeedbackModal dispatch={dispatch} />}
      {state.modalView === "undo" && state.undoModalData !== null && <UndoModal data={state.undoModalData} dispatch={dispatch} />}
      {state.pendingHookTrust !== null && (
        <HookTrustModal
          config={state.pendingHookTrust.config}
          projectPath={state.pendingHookTrust.projectPath}
          onApprove={() => {
            import("../../api/diskTrustedHooks.js").then(({ recordHooksTrust }) => {
              if (state.pendingHookTrust) {
                recordHooksTrust(state.pendingHookTrust.projectPath, state.pendingHookTrust.hash);
              }
              dispatch({ type: "HOOKS_TRUST_APPROVED", hash: state.pendingHookTrust!.hash, projectPath: state.pendingHookTrust!.projectPath });
            }).catch(() => {
              dispatch({ type: "HOOKS_TRUST_DENIED" });
            });
          }}
          onDeny={() => dispatch({ type: "HOOKS_TRUST_DENIED" })}
        />
      )}
      {state.pendingMcpTrust !== null && (
        <McpTrustModal
          config={state.pendingMcpTrust.config}
          projectPath={state.pendingMcpTrust.projectPath}
          onApprove={async () => {
            if (!state.pendingMcpTrust) return;
            const { config, hash, projectPath } = state.pendingMcpTrust;
            try {
              const [{ recordMcpTrust }, { McpClientManager }] = await Promise.all([
                import("../../api/diskTrustedMcp.js"),
                import("../../mcp/mcpClientManager.js"),
              ]);
              recordMcpTrust(projectPath, hash);
              const manager = await McpClientManager.connect(config.mcpServers, projectPath);
              dispatch({ type: "MCP_TRUST_APPROVED", manager });
            } catch {
              dispatch({ type: "MCP_TRUST_DENIED" });
            }
          }}
          onDeny={() => dispatch({ type: "MCP_TRUST_DENIED" })}
        />
      )}
      {state.planProposal !== null && (
        <PlanModal proposal={state.planProposal} dispatch={dispatch} />
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
      <PlanActionPrompt proposal={state.planReadyProposal} dispatch={dispatch} />
      <Composer
        onSubmit={handleComposerSubmit}
        onExit={() => { runAcRef.current?.abort(); exit(); }}
        onInitStart={(ac) => { runAcRef.current = ac; }}
        onUndoRequest={onUndoRequest}
        onRemoteControlCommand={onRemoteControlCommand}
        onEnvelopeResume={onEnvelopeResume}
        onCarriedAnswer={onCarriedAnswer}
        getCommitData={getCommitData}
        getFeedbackData={getFeedbackData}
      />
      {state.pendingQuestion !== null && (
        <QuestionPanel
          question={state.pendingQuestion.question}
          carriedOver={state.pendingQuestion.kind === "carried"}
          conversationLost={
            state.pendingQuestion.kind === "carried" && state.pendingQuestion.conversationLost
          }
        />
      )}
      {state.runState === "running" && state.todos.length > 0 && (
        <PlanPanel todos={state.todos} />
      )}
      <StatusBar />
    </Box>
  );
}

export function App({ initialPrompt, initialMode, bus, initialModel, capUsd, initialDailyUsedUsd, onSubmit, onUndoRequest, onRemoteControlCommand, onEnvelopeResume, onCarriedAnswer, onCarriedDiscard, initialTrustedPrefixes, resumedSession, initialSessionId, onStateChange, initialModelSettings, onModelApply, getCommitData, getFeedbackData, onDispatchCapture, onSessionClear, initialUserCommands, initialArmedUserHooks, initialPendingHookTrust, initialArmedMcpManager, initialPendingMcpTrust, initialCarriedQuestion }: AppProps): React.ReactElement {
  return (
    <StoreProvider initialValues={{
      model: initialModel ?? "",
      capUsd: capUsd ?? 10,
      dailyUsedUsd: initialDailyUsedUsd ?? 0,
      trustedPrefixes: initialTrustedPrefixes ?? [],
      resumedTranscript: resumedSession?.transcript,
      resumedSessionId: initialSessionId,
      resumedStartedAt: resumedSession?.startedAt,
      modelSettings: initialModelSettings,
      userCommands: initialUserCommands ?? [],
      mode: initialMode,
      armedUserHooks: initialArmedUserHooks,
      pendingHookTrust: initialPendingHookTrust,
      armedMcpManager: initialArmedMcpManager,
      pendingMcpTrust: initialPendingMcpTrust,
      carriedQuestion: initialCarriedQuestion,
    }}>
      <AppInner bus={bus} initialPrompt={initialPrompt} initialMode={initialMode} onSubmit={onSubmit} onUndoRequest={onUndoRequest} onRemoteControlCommand={onRemoteControlCommand} onEnvelopeResume={onEnvelopeResume} onCarriedAnswer={onCarriedAnswer} onCarriedDiscard={onCarriedDiscard} onStateChange={onStateChange} onModelApply={onModelApply} getCommitData={getCommitData} getFeedbackData={getFeedbackData} onDispatchCapture={onDispatchCapture} onSessionClear={onSessionClear} />
    </StoreProvider>
  );
}
