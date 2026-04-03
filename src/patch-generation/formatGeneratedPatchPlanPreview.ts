import type { GeneratedPatchPlan } from "./generatedPatchPlanTypes.js";

export function formatGeneratedPatchPlanPreview(plan: GeneratedPatchPlan) {
  const operationCount = plan.operations.length;

  return {
    stage: "generated_patch_preview",
    status: "info",
    summary:
      operationCount === 1
        ? "Generated patch preview contains 1 operation."
        : `Generated patch preview contains ${operationCount} operations.`,
    details:
      operationCount > 0
        ? plan.operations
            .map((operation, index) => {
              const filePath =
                "filePath" in operation && typeof operation.filePath === "string"
                  ? operation.filePath
                  : "unknown";

              return `${index + 1}. ${operation.type} -> ${filePath}`;
            })
            .join("\n")
        : "No operations were generated.",
    operationCount
  } as const;
}