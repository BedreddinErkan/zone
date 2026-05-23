import { Box } from "ink";
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
}

function AppInner({ bus }: { bus: EventBus | undefined }): React.ReactElement {
  const { state, dispatch } = useStore();
  useAgentEvents(bus, dispatch);

  return (
    <Box flexDirection="column">
      <Header />
      <Transcript />
      <Spinner />
      <StatusBar />
      {state.toastQueue.length > 0 && <Toast toast={state.toastQueue[0]} />}
    </Box>
  );
}

export function App(props: AppProps): React.ReactElement {
  return (
    <StoreProvider>
      <AppInner bus={props.bus} />
    </StoreProvider>
  );
}
