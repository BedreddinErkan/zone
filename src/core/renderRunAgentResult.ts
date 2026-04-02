type RunAgentMode = "blocked" | "preview_only" | "safe_to_apply";

type RenderRunAgentResultInput = {
  task: string;
  decision: {
    mode: RunAgentMode;
    confidenceScore: number;
  };
  risk?: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      critical: number;
      lowRisk: number;
    };
  };
  confidence?: {
    score: number;
    breakdown: {
      base: number;
      destructivePenalty: number;
      schemaPenalty: number;
      criticalPenalty: number;
      lowRiskBonus: number;
    };
  };
  explanation: string;
  recommendation: string;
  topRisks: Array<{
    title: string;
    severity: "low" | "medium" | "high";
    reason: string;
  }>;
};

export function renderRunAgentResult(
  input: RenderRunAgentResultInput
): string {
  const lines: string[] = [];

  lines.push("=== SMILE AGENT ===");
  lines.push(`Task: ${input.task}`);
  lines.push(`Decision: ${input.decision.mode}`);
  lines.push(`Confidence: ${input.decision.confidenceScore}`);
  lines.push(`Explanation: ${input.explanation}`);
  lines.push(`Recommendation: ${input.recommendation}`);

  if (input.risk) {
    lines.push("=== RISK ===");
    lines.push(`${input.risk.score}/100`);

    lines.push("=== RISK BREAKDOWN ===");
    lines.push(`- destructive: ${input.risk.breakdown.destructive}`);
    lines.push(`- schema: ${input.risk.breakdown.schema}`);
    lines.push(`- critical: ${input.risk.breakdown.critical}`);
    lines.push(`- low-risk: ${input.risk.breakdown.lowRisk}`);
  }

  if (input.confidence) {
    lines.push("=== CONFIDENCE BREAKDOWN ===");
    lines.push(`- base: ${input.confidence.breakdown.base}`);
    lines.push(
      `- destructive penalty: ${input.confidence.breakdown.destructivePenalty}`
    );
    lines.push(`- schema penalty: ${input.confidence.breakdown.schemaPenalty}`);
    lines.push(
      `- critical penalty: ${input.confidence.breakdown.criticalPenalty}`
    );
    lines.push(`- low-risk bonus: ${input.confidence.breakdown.lowRiskBonus}`);
  }

  lines.push("Top Risks:");

  if (input.topRisks.length === 0) {
    lines.push("- none");
  } else {
    for (const risk of input.topRisks) {
      lines.push(`- [${risk.severity}] ${risk.title}: ${risk.reason}`);
    }
  }

  return lines.join("\n");
}