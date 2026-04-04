import { buildDeveloperPrompt } from "./developerPrompt.js";

interface FullPatchPromptInput {
  task: string;
  filePath: string;
  fileContent: string;
  repoSummary: string;
  relatedContext: string;
}

export function buildFullPatchPrompt(input: FullPatchPromptInput): string {
  return buildDeveloperPrompt({
    task: input.task,
    repoPath: "(current workspace)",
    relevantFiles: [],
    taskIntent: "general",
    existingTargetFiles: [input.filePath],
    targetFilePath: input.filePath,
    targetFileContent: input.fileContent,
    repoSummary: input.repoSummary,
    relatedContext: input.relatedContext,
  });
}
