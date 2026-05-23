import type { TaskIntent } from "./taskIntentParser.js";

export interface ArchitectureValidation {
  warnings: string[];
}

export function validateSuggestedArchitecture(
  intent: TaskIntent,
  suggestedFiles: string[]
): ArchitectureValidation {
  const warnings: string[] = [];
  const lowerFiles = suggestedFiles.map((f) => f.toLowerCase());

  const hasRoute = lowerFiles.some((f) => f.includes("route"));
  const hasController = lowerFiles.some((f) => f.includes("controller"));
  const hasService = lowerFiles.some((f) => f.includes("service"));
  const hasUi = lowerFiles.some(
    (f) =>
      f.includes("page") ||
      f.includes("component") ||
      f.includes("view")
  );

  if (intent.action === "update" || intent.action === "delete") {
    if (!hasRoute) warnings.push("Mutation task suggested files are missing route layer.");
    if (!hasController) warnings.push("Mutation task suggested files are missing controller layer.");
  }

  if (intent.resourceKind === "nested_resource" && !hasService && !hasUi) {
    warnings.push("Nested resource change may also require service/UI updates depending on stack.");
  }

  return { warnings };
}