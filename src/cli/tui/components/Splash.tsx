import { useApp, Box } from "ink";
import Gradient from "ink-gradient";
import BigText from "ink-big-text";
import { useEffect } from "react";

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
      <Gradient name="pastel">
        <BigText text="ZONE" font="tiny" />
      </Gradient>
    </Box>
  );
}
