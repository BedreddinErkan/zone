import { buildPatchOperations, type PatchOperation } from "./buildPatchOperations.js";
import {
  classifyPatchIntent,
  type PatchIntent
} from "./classifyPatchIntent.js";
import {
  isIntentAllowed,
  type PatchGenerationStrategy
} from "./isIntentAllowed.js";

export type DecisionMode = "blocked" | "preview_only" | "safe_to_apply";

export type GeneratePatchPlanInput = {
  task: string;
  decision: {
    mode: DecisionMode;
    confidenceScore: number;
  };
  reasonCodes?: string[];
};

export type GeneratedPatchPlan = {
  allowed: boolean;
  strategy: PatchGenerationStrategy;
  intent: PatchIntent;
  operations: PatchOperation[];
  metadata: {
    reason: string;
    derivedFrom: string[];
    confidenceScore: number;
  };
};

function mapDecisionModeToStrategy(mode: DecisionMode): PatchGenerationStrategy {
  switch (mode) {
    case "blocked":
      return "blocked";
    case "preview_only":
      return "restricted";
    case "safe_to_apply":
      return "safe";
    default:
      return "blocked";
  }
}

export function generatePatchPlan(
  input: GeneratePatchPlanInput
): GeneratedPatchPlan {
  const strategy = mapDecisionModeToStrategy(input.decision.mode);
  const intent = classifyPatchIntent(input.task);
  const derivedFrom = input.reasonCodes ?? [];

  if (strategy === "blocked") {
    return {
      allowed: false,
      strategy,
      intent,
      operations: [],
      metadata: {
        reason: "Patch generation blocked by decision mode.",
        derivedFrom,
        confidenceScore: input.decision.confidenceScore
      }
    };
  }

  if (intent === "unknown") {
    return {
      allowed: false,
      strategy,
      intent,
      operations: [],
      metadata: {
        reason: "Patch generation blocked because task intent is unknown.",
        derivedFrom,
        confidenceScore: input.decision.confidenceScore
      }
    };
  }

  if (!isIntentAllowed(intent, strategy)) {
    return {
      allowed: false,
      strategy,
      intent,
      operations: [],
      metadata: {
        reason: `Patch intent is not allowed for strategy: ${strategy}.`,
        derivedFrom,
        confidenceScore: input.decision.confidenceScore
      }
    };
  }

  return {
    allowed: true,
    strategy,
    intent,
    operations: buildPatchOperations(intent),
    metadata: {
      reason: "Patch plan generated successfully from deterministic intent classification.",
      derivedFrom,
      confidenceScore: input.decision.confidenceScore
    }
  };
}