import { Box, Text, useInput, useApp } from "ink";
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
}

interface AppInnerProps {
  bus: EventBus | undefined;
  initialPrompt: string | undefined;
}

function AppInner({ bus, initialPrompt }: AppInnerProps): React.ReactElement {
  const { exit } = useApp();
  const { state, dispatch } = useStore();
  // Anchor stdin so Ink doesn't auto-unmount via beforeExit when the event loop empties.
  useInput((_input, key) => {
    if (key.escape && state.runState !== "running") {
      exit();
    }
  });
  useAgentEvents(bus, dispatch);

  return (
    <Box flexDirection="column">
      <Header />
      <Box flexDirection="column" paddingX={2}>
        {initialPrompt && (
          <Box>
            <Text color="cyan">▸ </Text>
            <Text>Task: {initialPrompt}</Text>
          </Box>
        )}
        <Transcript />
        <Spinner />
      </Box>
      <StatusBar />
      {state.toastQueue.length > 0 && <Toast toast={state.toastQueue[0]} />}
    </Box>
  );
}

export function App({ initialPrompt, bus, initialModel, capUsd }: AppProps): React.ReactElement {
  return (
    <StoreProvider initialValues={initialModel != null ? { model: initialModel, capUsd: capUsd ?? 10 } : undefined}>
      <AppInner bus={bus} initialPrompt={initialPrompt} />
    </StoreProvider>
  );
}
