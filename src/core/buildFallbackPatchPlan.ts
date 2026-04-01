import type { LlmPatchPlan, ValidatedSuggestedFile } from "../types/agent.js";

export function buildFallbackPatchPlan(
  task: string,
  suggestedFiles: ValidatedSuggestedFile[]
): LlmPatchPlan {
  return {
    summary: `Fallback patch preview generated for: ${task}`,
    patches: suggestedFiles
      .filter(
        (file): file is ValidatedSuggestedFile & { resolvedPath: string } =>
          typeof file.resolvedPath === "string" && file.resolvedPath.length > 0
      )
      .slice(0, 5)
      .map((file) => ({
        path: file.resolvedPath,
        operation: file.action === "create" ? "create" : "modify",
        summary: "Inspect and update this file with the minimal required change",
        targetHint: "Around the most relevant existing feature logic",
        contentPreview: `// Preview placeholder for task: ${task}`
      })),
    warnings: [
      "This patch preview was generated without a detailed LLM patch response",
      "Review target locations manually before applying changes"
    ]
  };
}