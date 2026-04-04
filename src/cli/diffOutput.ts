import { c, colorize } from "./colors.js";

export function renderColoredDiff(
  originalContent: string,
  newContent: string,
  filePath: string
): string {
  const originalLines = originalContent.split("\n");
  const newLines = newContent.split("\n");

  const lines: string[] = [];
  lines.push(colorize(`--- ${filePath}`, c.bold, c.white));
  lines.push("");

  const maxLen = Math.max(originalLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const origLine = originalLines[i];
    const nextLine = newLines[i];

    if (origLine === nextLine) {
      if (nextLine !== undefined) {
        lines.push(colorize(`  ${nextLine}`, c.dim, c.gray));
      }
      continue;
    }

    if (origLine !== undefined) {
      lines.push(colorize(`- ${origLine}`, c.red));
    }
    if (nextLine !== undefined) {
      lines.push(colorize(`+ ${nextLine}`, c.green));
    }
  }

  return lines.join("\n");
}

export function renderDiffSummary(
  applied: Array<{ filePath: string; original: string; updated: string }>
): void {
  for (const entry of applied) {
    console.log(
      renderColoredDiff(entry.original, entry.updated, entry.filePath)
    );
    console.log("");
  }
}
