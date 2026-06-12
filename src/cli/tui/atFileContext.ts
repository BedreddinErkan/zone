import { readFile } from "node:fs/promises";

export const AT_FILE_CONTENT_CAP = 10_000;

export function looksLikeBinary(text: string): boolean {
  return text.slice(0, 512).includes("\x00");
}

export async function readAtFileContext(fp: string): Promise<string | null> {
  try {
    let content = await readFile(fp, "utf-8");
    if (looksLikeBinary(content)) return null;
    const truncated = content.length > AT_FILE_CONTENT_CAP;
    if (truncated) content = content.slice(0, AT_FILE_CONTENT_CAP);
    const marker = truncated ? `\n[... file truncated at ${AT_FILE_CONTENT_CAP} chars]` : "";
    return `=== ${fp} ===\n${content}${marker}`;
  } catch {
    return null;
  }
}
