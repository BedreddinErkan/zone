import fs from "node:fs/promises";

function truncateContent(content: string, maxLength = 6000): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n\n/* ...truncated... */`;
}

/**
 * Smart truncation for the primary file when it EXCEEDS the budget.
 * Files at or under the budget are returned verbatim (no marker).
 * For oversized files: head + explicit ZONE_CONTEXT_TRUNCATED marker + tail.
 */
function smartTruncatePrimary(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;   // ← full content, no marker

  const HEAD_LINES = 200;
  const TAIL_LINES = 100;
  const lines = content.split("\n");

  if (lines.length <= HEAD_LINES + TAIL_LINES) {
    // Too few lines to split — hard-slice by chars with explicit marker
    return (
      content.slice(0, maxChars) +
      "\n\n// ============= ZONE_CONTEXT_TRUNCATED: remainder of file omitted, " +
      "use read_file to see the rest =============\n"
    );
  }

  const headEnd = HEAD_LINES;
  const tailStart = lines.length - TAIL_LINES;
  const head = lines.slice(0, headEnd).join("\n");
  const tail = lines.slice(tailStart).join("\n");
  const omitted = tailStart - headEnd;

  return (
    head +
    `\n\n// ============= ZONE_CONTEXT_TRUNCATED: lines ${headEnd + 1}–${tailStart} ` +
    `(${omitted} lines) omitted — use read_file to see this section =============\n\n` +
    tail
  );
}

export type ReadProjectFilesOptions = {
  /** Max files to read from this call (defaults to env MAX_CONTEXT_FILES or 5). */
  maxFiles?: number;
  /** Per-file character cap for secondary files (default 6000). */
  maxCharsPerFile?: number;
  /** Absolute path of the primary file — receives a larger budget. */
  primaryFile?: string;
  /** Character budget for the primary file (default 50 000). */
  primaryMaxChars?: number;
};

export async function readProjectFiles(
  paths: string[],
  options?: ReadProjectFilesOptions
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  const maxContextFilesRaw = (process.env.MAX_CONTEXT_FILES ?? "").trim();
  const envDefault =
    maxContextFilesRaw && Number.isFinite(Number(maxContextFilesRaw))
      ? Math.max(1, Math.floor(Number(maxContextFilesRaw)))
      : 5;
  const maxFiles = Math.max(1, options?.maxFiles ?? envDefault);
  const maxChars =
    typeof options?.maxCharsPerFile === "number" ? options.maxCharsPerFile : 6000;
  const primaryFile = options?.primaryFile ?? null;
  const primaryMaxChars = options?.primaryMaxChars ?? 50_000;

  for (const filePath of paths.slice(0, maxFiles)) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      if (primaryFile && filePath === primaryFile) {
        result[filePath] = smartTruncatePrimary(content, primaryMaxChars);
      } else {
        result[filePath] = truncateContent(content, maxChars);
      }
    } catch {
      result[filePath] = "";
    }
  }

  return result;
}
