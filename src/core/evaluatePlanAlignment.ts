import type { ExecutionPlan } from "../llm/executionPlan.js";

export type PlanAlignmentResult = {
  score: number;
  outOfPlanFiles: string[];
  inPlanFiles: string[];
  scopeMismatch: boolean;
  warning?: string;
};

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}

function isLikelyTargetedScope(scopeSummary: string): boolean {
  const summary = scopeSummary.toLowerCase();
  return /\b(targeted|localized|specific|single[- ]file|minimal|small|narrow|only)\b/.test(
    summary
  );
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

export function evaluatePlanAlignment(input: {
  plan: ExecutionPlan;
  changedFiles: string[];
  massScopeScore?: number;
}): PlanAlignmentResult {
  const plannedFiles = new Set(
    input.plan.steps
      .flatMap((step) => step.filesLikely)
      .map(normalizePath)
      .filter(Boolean)
  );
  const changedFiles = [
    ...new Set(input.changedFiles.map((filePath) => filePath.trim()).filter(Boolean)),
  ];
  const outOfPlanFiles: string[] = [];
  const inPlanFiles: string[] = [];
  let score = 100;

  for (const filePath of changedFiles) {
    if (plannedFiles.has(normalizePath(filePath))) {
      inPlanFiles.push(filePath);
    } else {
      outOfPlanFiles.push(filePath);
      score -= 20;
    }
  }

  const scopeMismatch =
    isLikelyTargetedScope(input.plan.scopeSummary ?? "") &&
    (changedFiles.length > 2 || (input.massScopeScore ?? 0) >= 40);

  if (scopeMismatch) {
    score -= 20;
  }

  const clampedScore = clampScore(score);
  return {
    score: clampedScore,
    outOfPlanFiles,
    inPlanFiles,
    scopeMismatch,
    ...(clampedScore < 70
      ? { warning: "Generated patch drifted beyond the execution plan." }
      : {}),
  };
}
