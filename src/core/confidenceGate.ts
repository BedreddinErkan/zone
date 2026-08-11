export type ConfidenceGateResult =
  | { pass: true }
  | {
      pass: false;
      reason: string;
      risks: string[];
      recommendation: string;
      effectiveThreshold: number;
    };

export interface ConfidenceGateInput {
  confidenceScore: number;
  warnings?: string[];
}

const DEFAULT_THRESHOLD = 60;

const RISK_DESCRIPTIONS: string[] = [
  "Low confidence may indicate unclear task scope",
  "Existing code patterns may not be well understood",
  "Generated code may not follow project conventions",
];

export function computeEffectiveThreshold(input: ConfidenceGateInput): number {
  let base = DEFAULT_THRESHOLD;

  const warningCount = (input.warnings ?? []).length;
  if (warningCount >= 3) base += 10;
  else if (warningCount >= 1) base += 5;

  return Math.min(base, 90);
}

function getRisks(warnings?: string[]): string[] {
  const warningRisks = (warnings ?? [])
    .filter(Boolean)
    .map(w => `Warning: ${w}`);

  return [...RISK_DESCRIPTIONS, ...warningRisks];
}

function getRecommendation(
  confidenceScore: number,
  threshold: number
): string {
  const gap = threshold - confidenceScore;

  if (gap > 30) {
    return "Confidence is too low to proceed safely. " +
      "Provide more context in your task description, " +
      "or manually specify the target files.";
  }

  return "Review the patch preview carefully before applying. " +
    "Consider using --format detailed to see full output.";
}

export function checkConfidenceGate(
  input: ConfidenceGateInput
): ConfidenceGateResult {
  const threshold = computeEffectiveThreshold(input);

  if (input.confidenceScore >= threshold) {
    return { pass: true };
  }

  return {
    pass: false,
    reason: `Confidence score ${input.confidenceScore} is below the default threshold of ${threshold}.`,
    risks: getRisks(input.warnings),
    recommendation: getRecommendation(
      input.confidenceScore,
      threshold
    ),
    effectiveThreshold: threshold,
  };
}

export function renderConfidenceGateBlock(
  result: Extract<ConfidenceGateResult, { pass: false }>
): string {
  const lines: string[] = [];

  lines.push("=== CONFIDENCE GATE ===");
  lines.push(`Status: BLOCKED`);
  lines.push(`Reason: ${result.reason}`);
  lines.push("");
  lines.push("Risks:");
  result.risks.forEach(r => lines.push(`- ${r}`));
  lines.push("");
  lines.push(`Recommendation: ${result.recommendation}`);

  return lines.join("\n");
}
