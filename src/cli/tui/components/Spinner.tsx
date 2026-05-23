import { useEffect, useState } from "react";
import { Text } from "ink";
import InkSpinner from "ink-spinner";
import { useStore } from "../store.js";

export function Spinner(): React.ReactElement | null {
  const { state } = useStore();
  const spinnerState = state.spinner;

  const [displayLabel, setDisplayLabel] = useState(spinnerState?.label ?? "");

  useEffect(() => {
    if (!spinnerState) return;
    const timer = setTimeout(() => {
      setDisplayLabel(spinnerState.label);
    }, 500);
    return () => clearTimeout(timer);
  }, [spinnerState?.label]);

  if (!spinnerState?.active) return null;

  return (
    <Text>
      <InkSpinner type="dots" /> {displayLabel}
    </Text>
  );
}
