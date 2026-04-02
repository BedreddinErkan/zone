import type { ApplyResult } from "./types.js";

export function renderApplyResult(result: ApplyResult): string {
  const lines: string[] = [
    "=== APPLY RESULT ===",
    `Applied: ${result.applied ? "yes" : "no"}`,
    `Summary: ${result.summary}`
  ];

  if (result.filesChanged.length > 0) {
    lines.push("Changed files:");

    for (const filePath of result.filesChanged) {
      lines.push(`- ${filePath}`);
    }
  }

  return lines.join("\n");
}