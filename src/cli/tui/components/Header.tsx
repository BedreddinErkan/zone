import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { Box, Text } from "ink";
import { useStore } from "../store.js";
import { supportsEffort } from "../../../llm/modelRegistry.js";

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

  const cols = process.stdout.columns ?? 80;
  const innerWidth = Math.max(10, cols - 4);
  const narrow = cols < 60;

  const cwdFull = cwd + (branch ? ` · ${branch}` : "");
  const cwdLabel = cwdFull.length <= innerWidth
    ? cwdFull
    : `…${cwdFull.slice(-(innerWidth - 1))}`;

  const modelLabel = model || "default";
  const effort = state.modelSettings?.effort;
  const effortGlyph = !narrow && effort && supportsEffort(modelLabel)
    ? effort === "low" ? " · ↓" : effort === "medium" ? " · ↕" : " · ↑"
    : "";
  const budgetSuffix = `${capUsd.toFixed(2)}${costUsd > 0 ? ` · used $${costUsd.toFixed(2)}` : ""}`;

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text><Text bold color="cyan">[Z]</Text>{" Zone v"}{version}{state.isResumed ? <Text dimColor> (resumed)</Text> : null}</Text>
      <Text dimColor>{cwdLabel}</Text>
      {narrow ? (
        <>
          <Text bold>{modelLabel.length > innerWidth ? modelLabel.slice(0, innerWidth - 1) + "…" : modelLabel}</Text>
          <Text dimColor>{"cap $"}{budgetSuffix}</Text>
        </>
      ) : (
        <Text>
          <Text bold>{modelLabel}</Text>
          {effortGlyph ? <Text dimColor>{effortGlyph}</Text> : null}
          <Text dimColor>{" · cap $"}{budgetSuffix}</Text>
        </Text>
      )}
    </Box>
  );
}
