import { useEffect } from "react";
import { Box, Text } from "ink";
import { useStore } from "../store.js";
import type { ToastEntry } from "../store.js";
import { role } from "../theme.js";

const LEVEL_COLOR: Record<ToastEntry["level"], string> = {
  info: role.accent,
  warning: role.caution,
  error: role.danger,
};

export function Toast({ toast }: { toast: ToastEntry }): React.ReactElement {
  const { dispatch } = useStore();

  useEffect(() => {
    const timer = setTimeout(() => {
      dispatch({ type: "TOAST_POP" });
    }, 2000);
    return () => clearTimeout(timer);
  }, [toast.id, dispatch]);

  return (
    <Box>
      <Text color={LEVEL_COLOR[toast.level]}>{toast.message}</Text>
    </Box>
  );
}
