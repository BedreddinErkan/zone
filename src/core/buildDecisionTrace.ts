import { normalizeSignals } from "./normalizeSignals.js";
import type { RunAgentMode, RunAgentTrace } from "./runAgent.js";

type ConfidenceBreakdownSnapshot = {
  base: number;
  destructivePenalty: number;
  schemaPenalty: number;
  criticalPenalty: number;
  massScopePenalty: number;
  lowRiskBonus: number;
};

type BuildDecisionTraceReasonMapping = {
  code: string;
  severity: "info" | "warning" | "critical";
  category: string;
  message: string;
};

type BuildDecisionTraceInput = {
  signals: string[];
  riskScore: number;
  confidenceScore: number;
  confidenceBreakdown: ConfidenceBreakdownSnapshot;
  mode: RunAgentMode;
  reasonDetails?: BuildDecisionTraceReasonMapping[];
};

function buildAppliedPenalties(
  breakdown: ConfidenceBreakdownSnapshot
): RunAgentTrace["appliedPenalties"] {
  const penalties: RunAgentTrace["appliedPenalties"] = [];

  if (breakdown.destructivePenalty !== 0) {
    penalties.push({ type: "destructive", impact: breakdown.destructivePenalty });
  }

  if (breakdown.schemaPenalty !== 0) {
    penalties.push({ type: "schema", impact: breakdown.schemaPenalty });
  }

  if (breakdown.criticalPenalty !== 0) {
    penalties.push({ type: "critical_domain", impact: breakdown.criticalPenalty });
  }

  if (breakdown.massScopePenalty !== 0) {
    penalties.push({ type: "mass_scope", impact: breakdown.massScopePenalty });
  }

  return penalties;
}

function buildDecisionPath(input: {
  signals: string[];
  appliedPenalties: RunAgentTrace["appliedPenalties"];
  riskScore: number;
  mode: RunAgentMode;
}): string[] {
  const path: string[] = [];

  for (const signal of input.signals) {
    path.push(`Detected ${signal} signal`);
  }

  for (const penalty of input.appliedPenalties) {
    path.push(`Applied ${penalty.type} penalty: ${penalty.impact}`);
  }

  path.push(`Total risk score: ${input.riskScore}`);

  const modeLabel: Record<RunAgentMode, string> = {
    blocked: "BLOCKED",
    preview_only: "PREVIEW_ONLY",
    safe_to_apply: "SAFE_TO_APPLY"
  };

  path.push(`Mapped to ${modeLabel[input.mode]} mode`);

  return path;
}

function buildConfidenceFormula(breakdown: ConfidenceBreakdownSnapshot): string {
  const parts: string[] = ["100"];

  const penalties: Array<{ value: number; label: string }> = [
    { value: breakdown.destructivePenalty, label: "destructive" },
    { value: breakdown.schemaPenalty, label: "schema" },
    { value: breakdown.criticalPenalty, label: "critical" },
    { value: breakdown.massScopePenalty, label: "mass-scope" }
  ];

  for (const { value, label } of penalties) {
    if (value !== 0) {
      parts.push(`- ${Math.abs(value)} (${label})`);
    }
  }

  if (breakdown.lowRiskBonus !== 0) {
    parts.push(`+ ${breakdown.lowRiskBonus} (low-risk bonus)`);
  }

  const result =
    100 +
    breakdown.destructivePenalty +
    breakdown.schemaPenalty +
    breakdown.criticalPenalty +
    breakdown.massScopePenalty +
    breakdown.lowRiskBonus;

  parts.push(`= ${result}`);

  return parts.join(" ");
}

function buildDecisionFactors(input: {
  mode: RunAgentMode;
  riskScore: number;
  signals: string[];
}): RunAgentTrace["decisionFactors"] {
  const thresholdMap: Record<RunAgentMode, number> = {
    blocked: 71,
    preview_only: 31,
    safe_to_apply: 0
  };

  let triggeredBy: string[];

  if (input.riskScore >= 71) {
    triggeredBy = ["riskScore"];
  } else if (input.mode === "preview_only") {
    triggeredBy = input.signals.filter((signal) =>
      ["schema", "critical_domain", "mass_scope"].includes(signal)
    );
  } else {
    triggeredBy = [];
  }

  return {
    riskThreshold: thresholdMap[input.mode],
    triggeredBy
  };
}

export function buildDecisionTrace(
  input: BuildDecisionTraceInput
): RunAgentTrace {
  const normalizedSignals = normalizeSignals(input.signals);
  const appliedPenalties = buildAppliedPenalties(input.confidenceBreakdown);

  return {
    signals: input.signals,
    normalizedSignals: normalizedSignals.map((signal) => ({
      type: signal.type,
      severity: signal.severity,
      confidenceImpact: signal.confidenceImpact,
      label: signal.label
    })),
    riskScore: input.riskScore,
    confidenceScore: input.confidenceScore,
    appliedPenalties,
    decisionPath: buildDecisionPath({
      signals: input.signals,
      appliedPenalties,
      riskScore: input.riskScore,
      mode: input.mode
    }),
    decisionFactors: buildDecisionFactors({
      mode: input.mode,
      riskScore: input.riskScore,
      signals: input.signals
    }),
    confidenceFormula: buildConfidenceFormula(input.confidenceBreakdown),
    reasonMapping: input.reasonDetails ?? []
  };
}