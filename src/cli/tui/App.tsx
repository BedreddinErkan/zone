import { Box, Text } from "ink";
import { StoreProvider } from "./store.js";

interface AppProps {
  initialPrompt?: string;
}

function AppInner(_props: AppProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>Zone (TUI)</Text>
    </Box>
  );
}

export function App(props: AppProps): React.ReactElement {
  return (
    <StoreProvider>
      <AppInner initialPrompt={props.initialPrompt} />
    </StoreProvider>
  );
}
