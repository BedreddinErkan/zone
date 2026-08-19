import { useApp, Box, Text } from "ink";
import { useEffect } from "react";
import { role } from "../theme.js";

const DURATION_MS = 850;

export function Splash(): React.ReactElement {
  const { exit } = useApp();
  useEffect(() => {
    const id = setTimeout(() => exit(), DURATION_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Box paddingX={1}>
      <Text bold color={role.brand}>{"[╱] ZONE"}</Text>
    </Box>
  );
}
