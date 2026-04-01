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

  for (const filePath of paths) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      result[filePath] = truncateContent(content);
    } catch {
      result[filePath] = "";
    }
  }

  return result;
}