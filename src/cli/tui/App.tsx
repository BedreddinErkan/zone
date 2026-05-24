import { Box, Text, useInput, useApp } from "ink";
import { useEffect, useRef } from "react";
import { StoreProvider, useStore } from "./store.js";
import { useAgentEvents } from "./hooks/useAgentEvents.js";
import { Header } from "./components/Header.js";
import { Transcript } from "./components/Transcript.js";
import { Spinner } from "./components/Spinner.js";
import { StatusBar } from "./components/StatusBar.js";
import { Toast } from "./components/Toast.js";
import { Composer } from "./components/Composer.js";
import { ApprovalModal } from "./components/ApprovalModal.js";
import { PermissionsView } from "./components/PermissionsView.js";
import { ApiKeysView } from "./components/ApiKeysView.js";
import type { EventBus } from "../eventBus.js";

interface AppProps {
  initialPrompt?: string;
  bus?: EventBus;
  initialModel?: string;
  capUsd?: number;
  onSubmit?: (prompt: string, ac: AbortController) => void;
  initialTrustedPrefixes?: string[];
}

interface AppInnerProps {
  bus: EventBus | undefined;
  initialPrompt: string | undefined;
  onSubmit: ((prompt: string, ac: AbortController) => void) | undefined;
}

function AppInner({ bus, initialPrompt, onSubmit }: AppInnerProps): React.ReactElement {
  const { exit } = useApp();
  const { state, dispatch } = useStore();
  const runAcRef = useRef<AbortController | null>(null);
  const sessionTrustedPrefixesRef = useRef<string[]>(state.sessionTrustedPrefixes);
  useEffect(() => {
    sessionTrustedPrefixesRef.current = state.sessionTrustedPrefixes;
  }, [state.sessionTrustedPrefixes]);

  // Start the initial run exactly once on mount if a prompt was provided at launch.
  useEffect(() => {
    if (initialPrompt !== undefined && onSubmit) {
      const ac = new AbortController();
      runAcRef.current = ac;
      dispatch({ type: "USER_PROMPT", text: initialPrompt });
      onSubmit(initialPrompt, ac);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Anchor stdin so Ink doesn't auto-unmount via beforeExit when the event loop empties.
  useInput((input, key) => {
    // Ctrl+C — always exit. In TTY raw mode, SIGINT never fires; \x03 arrives here instead.
    if (input === "\x03") {
      runAcRef.current?.abort();
      exit();
      return;
    }
    // Esc — abort running task only; never exit TUI. Skip when approval modal is active.
    if (key.escape && state.runState === "running" && state.pendingApproval === null && state.modalView === "none") {
      runAcRef.current?.abort();
      dispatch({ type: "RUN_ABORTED" });
    }
  });

  useAgentEvents(bus, dispatch, sessionTrustedPrefixesRef);

  const handleComposerSubmit = (text: string, ac: AbortController): void => {
    runAcRef.current = ac;
    onSubmit?.(text, ac);
  };

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 24}>
      <Header />
      <Box flexDirection="column" flexGrow={1} paddingX={2}>
        <Transcript />
        <Spinner />
      </Box>
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
      <Composer onSubmit={handleComposerSubmit} onExit={exit} />
      <StatusBar />
    </Box>
  );
}

export function App({ initialPrompt, bus, initialModel, capUsd, onSubmit, initialTrustedPrefixes }: AppProps): React.ReactElement {
  return (
    <StoreProvider initialValues={{ model: initialModel ?? "", capUsd: capUsd ?? 10, trustedPrefixes: initialTrustedPrefixes ?? [] }}>
      <AppInner bus={bus} initialPrompt={initialPrompt} onSubmit={onSubmit} />
    </StoreProvider>
  );
}
