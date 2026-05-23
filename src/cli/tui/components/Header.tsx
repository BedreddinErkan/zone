import { execFileSync } from "node:child_process";
import { Box, Text } from "ink";
import { useStore } from "../store.js";

function getGitBranch(): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const branch = getGitBranch();
const cwd = process.cwd();

export function Header(): React.ReactElement {
  const { state } = useStore();
  const model = state.statusBar.model || "default";

  return (
    <Box borderStyle="round" paddingX={1} flexDirection="row">
      <Text>Zone </Text>
      <Text dimColor>· {model} · {cwd}{branch ? ` (${branch})` : ""}</Text>
    </Box>
  );
}
