import path from "node:path";
import type { SavedAgentResult } from "../types/agent.js";
import { fileExists, readTextFile } from "../utils/files.js";

export async function loadSavedAgentResult(
  targetPath: string
): Promise<SavedAgentResult | null> {
  const resultPath = path.join(targetPath, ".agent-cache", "last-result.json");

  const exists = await fileExists(resultPath);
  if (!exists) {
    return null;
  }

  const raw = await readTextFile(resultPath);
  return JSON.parse(raw) as SavedAgentResult;
}