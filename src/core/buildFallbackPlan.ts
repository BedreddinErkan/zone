import type { LlmFeaturePlan, PlannedFileChange } from "../types/agent.js";
import type { RepoFile } from "../types/project.js";

export function buildFallbackPlan(task: string, relevantFiles: RepoFile[]): LlmFeaturePlan {
  const suggestedFiles: PlannedFileChange[] = relevantFiles.slice(0, 6).map((file) => ({
    path: file.path,
    reason: "Selected as one of the most relevant files for the requested task",
    action: "inspect"
  }));

  return {
    implementationSummary: `Fallback plan generated for: ${task}`,
    steps: [
      "Inspect the most relevant frontend and backend files",
      "Identify the current data flow and related services",
      "Plan minimal changes around the existing architecture",
      "Implement the feature in the most related page/service/route/controller files"
    ],
    suggestedFiles,
    risks: [
      "This plan was generated without a live LLM response",
      "Some suggested files may need manual confirmation"
    ]
  };
}