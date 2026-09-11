import { Box, useInput, useApp, useStdout } from "ink";
import { useEffect, useRef, type Dispatch } from "react";
import { StoreProvider, useStore } from "./store.js";
import { spacing } from "./theme.js";
import type { ApiKeyProvider } from "../../api/diskKeys.js";
import { useAgentEvents } from "./hooks/useAgentEvents.js";
import { Transcript } from "./components/Transcript.js";
import { Spinner } from "./components/Spinner.js";
import { StatusBar } from "./components/StatusBar.js";
import { Toast } from "./components/Toast.js";
import { Composer } from "./components/Composer.js";
import { ApprovalModal } from "./components/ApprovalModal.js";
import { PlanModal } from "./components/PlanModal.js";
import { PlanActionPrompt } from "./components/PlanActionPrompt.js";
import { StagedDiffModal } from "./components/StagedDiffModal.js";
import { PlanCursor } from "./components/PlanCursor.js";
import { QuestionPanel } from "./components/QuestionPanel.js";
import { OverlayLayer } from "./components/OverlayLayer.js";
import { EmptyStateHero } from "./components/EmptyStateHero.js";
import { selectIsBlockingModalOpen, selectEscTarget } from "./store-core.js";
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
  /** Providers with a resolved key, from the already-collapsed CliConfig — see StoreState. */
  initialProvidersWithKey?: string[];
  gatewayIds?: string[];
  activeProfile?: import("../../llm/providerProfile.js").ProviderProfile | null;
  onModelApply?: (model: string, provider: ApiKeyProvider, effort?: EffortLevel, summaryFormat?: "compact" | "detailed", memoryEnabled?: boolean, commitOnSuccess?: boolean) => void;
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
  /** Phase 6a — initial config snapshot from CliConfig. */
  initialConfig?: import("./store-core.js").RunConfigShape;
  /** Phase 7a — boot-time identity/context. */
  initialBoot?: import("./store-core.js").BootData | null;
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
  onModelApply: ((model: string, provider: ApiKeyProvider, effort?: EffortLevel, summaryFormat?: "compact" | "detailed", memoryEnabled?: boolean, commitOnSuccess?: boolean) => void) | undefined;
  getCommitData: (() => { filePaths: string[]; message: string; repoPath: string } | null) | undefined;
  getFeedbackData: (() => { runId: string; sessionId: string; logs: string; version: string; repoPath: string } | null) | undefined;
  onDispatchCapture: ((dispatch: Dispatch<StoreAction>) => void) | undefined;
  onSessionClear: ((oldSessionId: string) => void) | undefined;
}

function AppInner({ bus, initialPrompt, initialMode, onSubmit, onUndoRequest, onRemoteControlCommand, onEnvelopeResume, onCarriedAnswer, onCarriedDiscard, onStateChange, onModelApply, getCommitData, getFeedbackData, onDispatchCapture, onSessionClear: _onSessionClear }: AppInnerProps): React.ReactElement {
  const { exit } = useApp();
  const { state, dispatch } = useStore();
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 24;
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
    // Phase 3b — central Esc handler. Precedence is defined in selectEscTarget:
    // submode (content component owns Esc) > overlay (pop stack) > question (dismiss) > run (abort).
    // "submode" is a no-op here — the content component's own useInput fires when
    // overlaySubModeOpen is true, so the central handler must not double-fire.
    if (key.escape) {
      const target = selectEscTarget(state);
      if (target === "overlay") {
        dispatch({ type: "OVERLAY_POP" });
      } else if (target === "question" && state.modalView === "none") {
        const pending = state.pendingQuestion!;
        if (pending.kind === "live") {
          declineUserQuestion({ questionId: pending.questionId, runId: pending.runId });
          dispatch({ type: "USER_QUESTION_RESOLVED" });
        } else {
          onCarriedDiscard?.(pending.runId, pending.iter);
          dispatch({ type: "USER_QUESTION_DISMISSED" });
        }
      } else if (target === "run" && state.pendingApproval === null && state.modalView === "none") {
        runAcRef.current?.abort();
        dispatch({ type: "NARRATION_COMMIT" });
        dispatch({ type: "RUN_ABORTED" });
      }
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
          subagentId={state.pendingApproval.subagentId}
          dispatch={dispatch}
        />
      )}
      {/* Phase 2c+2d — all 16 modals (model, keys, metrics, effort, summary, planMode, session,
          sessions, permissions, limits, commit, feedback, undo, trust, hookTrust, mcpTrust)
          render through the OverlayLayer stack. The overlay stack is populated by:
          - OVERLAY_PUSH from Composer (simple settings modals)
          - Reducer side-effects on data-seeding actions (commit, feedback, permissions, sessions, undo)
          - Reducer side-effect on PENDING_APPROVAL_SET with kind: "trust"
          - buildInitialState for startup-time trust decisions */}
      <OverlayLayer />
      {state.planProposal !== null && (
        <PlanModal proposal={state.planProposal} dispatch={dispatch} />
      )}
      {state.stagedDiffProposal !== null && (
        <StagedDiffModal proposal={state.stagedDiffProposal} dispatch={dispatch} />
      )}
    </>
  );

  // Phase 7.5a — empty-state hero: shown only when transcript is empty, no run active,
  // and no live buffers are rendering. Disappears the moment the first entry lands.
  const showHero = state.transcript.length === 0
    && state.runState === "idle"
    && !state.liveTail.narrationBuffer
    && !state.liveTail.streamingAnswer
    && !state.liveTail.currentToolCall;

  return (
    <Box flexDirection="column">
      <Box paddingX={spacing.md}>
        <Transcript />
      </Box>
      {/* Phase 7.5a — viewport-high live region. height={rows} pins the bottom chrome
          (composer + status bar) to the terminal's last row; the hero area above fills
          the remaining space with flexGrow. Static transcript scrolls above this box
          into native scrollback. */}
      <Box flexDirection="column" height={rows}>
        {showHero && <EmptyStateHero />}
        {!showHero && <Box flexGrow={1} />}
        <Spinner />
        {modals}
        {state.planReadyProposal !== null && (
          <PlanActionPrompt proposal={state.planReadyProposal} dispatch={dispatch} />
        )}
        {/* Phase 2c — Composer is hidden while a blocking modal is open (approval, trust,
            plan-ready, staged-diffs, or anything on the overlayStack). The user talks to the
            modal, not the agent, while it's up; leaving the Composer visible would invite a
            submission that the run-loop cannot accept. QuestionPanel is NOT gated — a pending
            question IS the conversation, so the Composer must stay live to receive the answer. */}
        {!selectIsBlockingModalOpen(state) && (
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
        )}
        {state.pendingQuestion !== null && (
          <QuestionPanel
            question={state.pendingQuestion.question}
            carriedOver={state.pendingQuestion.kind === "carried"}
            conversationLost={
              state.pendingQuestion.kind === "carried" && state.pendingQuestion.conversationLost
            }
          />
        )}
        {/* Phase 6c — PlanCursor: one-line live cursor; full checklist in <Static> via plan_snapshot */}
        <PlanCursor />
        <StatusBar />
      </Box>
    </Box>
  );
}

export function App({ initialPrompt, initialMode, bus, initialModel, capUsd, initialDailyUsedUsd, onSubmit, onUndoRequest, onRemoteControlCommand, onEnvelopeResume, onCarriedAnswer, onCarriedDiscard, initialTrustedPrefixes, resumedSession, initialSessionId, onStateChange, initialModelSettings, initialProvidersWithKey, gatewayIds, activeProfile, onModelApply, getCommitData, getFeedbackData, onDispatchCapture, onSessionClear, initialUserCommands, initialArmedUserHooks, initialPendingHookTrust, initialArmedMcpManager, initialPendingMcpTrust, initialCarriedQuestion, initialConfig, initialBoot }: AppProps): React.ReactElement {
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
      providersWithKey: initialProvidersWithKey ?? [],
      gatewayIds: gatewayIds ?? [],
      activeProfile: activeProfile ?? null,
      userCommands: initialUserCommands ?? [],
      mode: initialMode,
      armedUserHooks: initialArmedUserHooks,
      pendingHookTrust: initialPendingHookTrust,
      armedMcpManager: initialArmedMcpManager,
      pendingMcpTrust: initialPendingMcpTrust,
      carriedQuestion: initialCarriedQuestion,
      initialConfig,
      initialBoot,
    }}>
      <AppInner bus={bus} initialPrompt={initialPrompt} initialMode={initialMode} onSubmit={onSubmit} onUndoRequest={onUndoRequest} onRemoteControlCommand={onRemoteControlCommand} onEnvelopeResume={onEnvelopeResume} onCarriedAnswer={onCarriedAnswer} onCarriedDiscard={onCarriedDiscard} onStateChange={onStateChange} onModelApply={onModelApply} getCommitData={getCommitData} getFeedbackData={getFeedbackData} onDispatchCapture={onDispatchCapture} onSessionClear={onSessionClear} />
    </StoreProvider>
  );
}
