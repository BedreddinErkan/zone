import { classifyPatchIntent } from "../patch-generation/classifyPatchIntent.js";
import { isIntentAllowed } from "../patch-generation/isIntentAllowed.js";
import { buildPatchOperations } from "../patch-generation/buildPatchOperations.js";

type BuildGeneratedPatchPlanPreviewInput = {
  task: string;
  decision: {
    mode: "blocked" | "preview_only" | "safe_to_apply";
    confidenceScore: number;
  };
  reasonCodes?: readonly string[];
};

type GenerationStrategy = "safe" | "blocked";

function resolveStrategy(
  mode: BuildGeneratedPatchPlanPreviewInput["decision"]["mode"]
): GenerationStrategy {
  return mode === "blocked" ? "blocked" : "safe";
}

function resolveAllowedLabel(allowed: boolean): "yes" | "no" {
  return allowed ? "yes" : "no";
}

function renderOperations(intent: string): string[] {
  if (intent === "unknown") {
    return ["- none"];
  }

  const operations = buildPatchOperations(intent as never);

  if (!operations.length) {
    return ["- none"];
  }

  return operations.map((operation) => {
    const scope =
      "scope" in operation && typeof operation.scope === "string"
        ? operation.scope
        : "single_file";

    return `- ${operation.type} (scope: ${scope})`;
  });
}

function resolveReason(intent: string, allowed: boolean): string {
  if (!allowed && intent === "unknown") {
    return "Patch generation blocked because task intent is unknown.";
  }

  if (!allowed) {
    return `Patch generation blocked because intent '${intent}' is not allowed for this strategy.`;
  }

  return "Patch generation allowed.";
}

export function buildGeneratedPatchPlanPreview(
  input: BuildGeneratedPatchPlanPreviewInput
): string {
  const reasonCodes = input.reasonCodes ?? [];
  const strategy = resolveStrategy(input.decision.mode);
  const rawIntent = classifyPatchIntent(input.task);
  const intent = rawIntent === "unknown" ? "unknown" : rawIntent;
  const allowed =
    rawIntent === "unknown" ? false : isIntentAllowed(rawIntent, strategy);

  const lines: string[] = [];

  lines.push("=== GENERATED PATCH PLAN ===");
  lines.push(`Allowed: ${resolveAllowedLabel(allowed)}`);
  lines.push(`Strategy: ${strategy}`);
  lines.push(`Intent: ${intent}`);
  lines.push(`Confidence: ${input.decision.confidenceScore}`);
  lines.push(`Reason: ${resolveReason(intent, allowed)}`);
  lines.push("");

  lines.push("Operations:");
  lines.push(...renderOperations(intent));
  lines.push("");

  lines.push("Derived From:");
  if (reasonCodes.length === 0) {
    lines.push("- none");
  } else {
    for (const code of reasonCodes) {
      lines.push(`- ${code}`);
    }
  }

  return lines.join("\n");
}