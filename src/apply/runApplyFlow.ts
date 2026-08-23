import type { RunAgentResult } from "../core/runAgent.js";
import { canApplyDecision } from "./canApplyDecision.js";
import { applyPatchPlan } from "./applyPatchPlan.js";
import type { PatchPlan } from "./patchPlan.js";
import type { ApplyRequest, ApplyResult } from "./types.js";

export type RunApplyFlowInput = {
  result: RunAgentResult;
  plan: PatchPlan;
  request: ApplyRequest;
  repoPath: string;
};

function validateBasicPatchPlan(plan: PatchPlan): void {
  if (!Array.isArray(plan.patches) || plan.patches.length === 0) {
    throw new Error("Patch plan must include at least one patch.");
  }

  const seen = new Set<string>();

  for (const patch of plan.patches) {
    if (!patch.filePath || patch.filePath.trim().length === 0) {
      throw new Error("Patch filePath is required.");
    }

    if (seen.has(patch.filePath)) {
      throw new Error(`Duplicate patch filePath detected: ${patch.filePath}`);
    }

    seen.add(patch.filePath);
  }
}

export async function runApplyFlow({
  result,
  plan,
  request,
  repoPath
}: RunApplyFlowInput): Promise<ApplyResult> {
  const eligibility = canApplyDecision(result);

  if (!eligibility.allowed) {
    return {
      applied: false,
      filesChanged: [],
      summary: eligibility.message
    };
  }

  if (!request.confirm) {
    return {
      applied: false,
      filesChanged: [],
      summary: "Apply confirmation is required."
    };
  }

  validateBasicPatchPlan(plan);

  return applyPatchPlan(plan, repoPath);
}