import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { Box, Text } from "ink";
import { useStore } from "../store.js";

const _require = createRequire(import.meta.url);
const { version } = _require("../../../../package.json") as { version: string };

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
  const { model, costUsd, capUsd } = state.statusBar;

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text>Zone v{version}</Text>
      <Text dimColor>{cwd}{branch ? ` · ${branch}` : ""}</Text>
      <Text>
        <Text bold>{model || "default"}</Text>
        <Text dimColor>
          {" · cap $"}{capUsd.toFixed(2)}
          {costUsd > 0 ? ` · used $${costUsd.toFixed(2)}` : ""}
        </Text>
      </Text>
    </Box>
  );
}
