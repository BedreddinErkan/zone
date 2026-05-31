import React from "react";
import { Box, Text } from "ink";

const FIND_MARKER = "--- FIND ---";
const REPLACE_MARKER = "--- REPLACE ---";
const MAX_DIFF_LINES = 20;

interface DiffBlock {
  findLines: string[];
  replaceLines: string[];
}

function parseBlocks(patch: string): DiffBlock[] {
  return patch.split(FIND_MARKER).slice(1).flatMap((part) => {
    const ri = part.indexOf(REPLACE_MARKER);
    if (ri === -1) return [];
    const trim = (s: string) => s.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    const findTrimmed = trim(part.slice(0, ri));
    const replaceTrimmed = trim(part.slice(ri + REPLACE_MARKER.length));
    // Empty section → [] (not [""] — avoids phantom blank line for add-only/delete-only patches)
    return [{
      findLines: findTrimmed ? findTrimmed.split("\n") : [],
      replaceLines: replaceTrimmed ? replaceTrimmed.split("\n") : [],
    }];
  });
}

type DiffLine = { kind: "remove" | "add"; text: string } | { kind: "sep" };

export function DiffView({ patch }: { patch: string }): React.ReactElement | null {
  const blocks = parseBlocks(patch);
  if (blocks.length === 0) return null;

  const allLines: DiffLine[] = [];
  blocks.forEach((b, bi) => {
    if (bi > 0) allLines.push({ kind: "sep" });
    b.findLines.forEach((l) => allLines.push({ kind: "remove", text: l }));
    b.replaceLines.forEach((l) => allLines.push({ kind: "add", text: l }));
  });

  // Separators don't count towards the cap
  let contentCount = 0;
  let cutIdx = allLines.length;
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].kind !== "sep" && ++contentCount > MAX_DIFF_LINES) {
      cutIdx = i;
      break;
    }
  }
  const shown = allLines.slice(0, cutIdx);
  const remaining = allLines.slice(cutIdx).filter((l) => l.kind !== "sep").length;

  return (
    <Box flexDirection="column">
      {shown.map((l, i) =>
        l.kind === "sep" ? (
          <Text key={i} dimColor>{"···"}</Text>
        ) : (
          <Box key={i}>
            <Text color={l.kind === "remove" ? "red" : "green"}>{l.kind === "remove" ? "- " : "+ "}</Text>
            <Box flexGrow={1}>
              <Text color={l.kind === "remove" ? "red" : "green"}>{l.text}</Text>
            </Box>
          </Box>
        )
      )}
      {remaining > 0 && (
        <Text dimColor>{`… +${remaining} more line${remaining === 1 ? "" : "s"}`}</Text>
      )}
    </Box>
  );
}
