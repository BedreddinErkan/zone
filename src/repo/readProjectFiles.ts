import fs from "node:fs/promises";

function truncateContent(content: string, maxLength = 6000): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength)}\n\n/* ...truncated... */`;
}

export async function readProjectFiles(
  paths: string[]
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  const maxContextFilesRaw = (process.env.MAX_CONTEXT_FILES ?? "").trim();
  const maxContextFiles =
    maxContextFilesRaw && Number.isFinite(Number(maxContextFilesRaw))
      ? Math.max(1, Math.floor(Number(maxContextFilesRaw)))
      : 5;

  for (const filePath of paths.slice(0, maxContextFiles)) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      result[filePath] = truncateContent(content);
    } catch {
      result[filePath] = "";
    }
  }

  return result;
}