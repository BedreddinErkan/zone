import { Box, Text, useInput } from "ink";
import { StoreProvider, useStore } from "./store.js";
import { useAgentEvents } from "./hooks/useAgentEvents.js";
import { Header } from "./components/Header.js";
import { Transcript } from "./components/Transcript.js";
import { Spinner } from "./components/Spinner.js";
import { StatusBar } from "./components/StatusBar.js";
import { Toast } from "./components/Toast.js";
import type { EventBus } from "../eventBus.js";

interface AppProps {
  initialPrompt?: string;
  bus?: EventBus;
  initialModel?: string;
  capUsd?: number;
  externalAc?: AbortController;
}

interface AppInnerProps {
  bus: EventBus | undefined;
  initialPrompt: string | undefined;
  externalAc: AbortController | undefined;
}

function Welcome(): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>Welcome to Zone.</Text>
      <Box marginTop={1}>
        <Text dimColor>Run zone "task" for one-shot mode.</Text>
      </Box>
      <Text dimColor>REPL composer arrives in TUI.4.</Text>
    </Box>
  );
}

function AppInner({ bus, initialPrompt, externalAc }: AppInnerProps): React.ReactElement {
  const { state, dispatch } = useStore();
  // Anchor stdin so Ink doesn't auto-unmount via beforeExit when the event loop empties.
  // Esc aborts a running task; Ctrl+C (SIGINT in index.tsx) is the only exit path.
  useInput((_input, key) => {
    if (key.escape && state.runState === "running") {
      externalAc?.abort();
      dispatch({ type: "RUN_ABORTED" });
    }
  });
  useAgentEvents(bus, dispatch);

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 24}>
      <Header />
      <Box flexDirection="column" flexGrow={1} paddingX={2}>
        {initialPrompt === undefined ? (
          <Welcome />
        ) : (
          <>
            <Box>
              <Text color="cyan">▸ </Text>
              <Text>Task: {initialPrompt}</Text>
            </Box>
            <Transcript />
            <Spinner />
          </>
        )}
      </Box>
      {state.toastQueue.length > 0 && <Toast toast={state.toastQueue[0]} />}
      <StatusBar />
    </Box>
  );
}

export function App({ initialPrompt, bus, initialModel, capUsd, externalAc }: AppProps): React.ReactElement {
  return (
    <StoreProvider initialValues={initialModel != null ? { model: initialModel, capUsd: capUsd ?? 10 } : undefined}>
      <AppInner bus={bus} initialPrompt={initialPrompt} externalAc={externalAc} />
    </StoreProvider>
  );
}
