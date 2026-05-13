import path from "node:path";
import { readFile } from "node:fs/promises";
import { scanRepo } from "../repo/scanRepo.js";
import { detectProjectStructure } from "../repo/detectProjectStructure.js";
import { rankRelevantFiles } from "../repo/rankRelevantFiles.js";
import type { LLMProvider } from "../llm/types.js";

export type PlanContext = {
  projectSummary: string;
  relevantFilePaths: string[];
};

export async function preparePlanContext(input: {
  task: string;
  repoPath: string;
  repoSummaryOverride?: string;
  userApiKey?: string;
  provider?: LLMProvider;
  maxFiles?: number;
}): Promise<PlanContext> {
  const maxFiles = input.maxFiles ?? 8;

  let allFiles = await scanRepo(input.repoPath).catch(() => []);

  const structure = detectProjectStructure(allFiles);
  const projectSummary =
    input.repoSummaryOverride ||
    structure.notes.join(" ") ||
    "No project summary available.";

  let relevantFilePaths: string[] = [];
  if (allFiles.length > 0) {
    try {
      const ranked = await rankRelevantFiles({
        task: input.task,
        files: allFiles,
        readContent: async (relPath: string): Promise<string | null> => {
          try {
            return await readFile(path.join(input.repoPath, relPath), "utf-8");
          } catch {
            return null;
          }
        },
      });
      relevantFilePaths = ranked.slice(0, maxFiles).map((f) => f.path);
    } catch {
      // best-effort
    }
  }

  return { projectSummary, relevantFilePaths };
}
