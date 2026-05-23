import { Text } from "ink";
import InkSpinner from "ink-spinner";
import { useStore } from "../store.js";

export function Spinner(): React.ReactElement | null {
  const { state } = useStore();
  const spinnerState = state.spinner;

  if (!spinnerState?.active) return null;

  return (
    <Text>
      <Text bold color="cyan">Z</Text>
      <InkSpinner type="dots" />
    </Text>
  );
}
