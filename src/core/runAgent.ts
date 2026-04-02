import { computeRiskScore } from "./computeRiskScore.js";
import { normalizeSignals } from "./normalizeSignals.js";
import { computeConfidenceScore } from "./scoring/computeConfidenceScore.js";

type RunAgentInput = {
  task: string;
};

export type RunAgentMode = "blocked" | "preview_only" | "safe_to_apply";

export type RunAgentResult = {
  task: string;
  decision: {
    mode: RunAgentMode;
    confidenceScore: number;
  };
  risk: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      critical: number;
      lowRisk: number;
      massScope: number;
    };
  };
  confidence: {
    score: number;
    breakdown: {
      base: number;
      destructivePenalty: number;
      schemaPenalty: number;
      criticalPenalty: number;
      massScopePenalty: number;
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

function mapScoreToMode(score: number, signals: string[]): RunAgentMode {
  if (score >= 71) {
    return "blocked";
  }

  if (
    score >= 31 ||
    signals.includes("schema") ||
    signals.includes("critical_domain") ||
    signals.includes("mass_scope")
  ) {
    return "preview_only";
  }

  return "safe_to_apply";
}

function formatSignal(signal: string): string {
  switch (signal) {
    case "schema":
      return "schema";
    case "critical_domain":
      return "critical";
    case "low_risk":
      return "low-risk";
    case "destructive":
      return "destructive";
    case "mass_scope":
      return "mass-scope";
    default:
      return signal;
  }
}

// ---------------------------------------------------------------------------
// buildPrimaryCause — exported for unit testing
// ---------------------------------------------------------------------------

export function buildPrimaryCause(signals: string[]): string {
  if (signals.includes("destructive")) return "destructive operation";
  if (signals.includes("schema")) return "schema-sensitive change";
  if (signals.includes("critical_domain")) return "critical domain access";
  if (signals.includes("mass_scope")) return "mass-scope operation";
  return "general task";
}
// ---------------------------------------------------------------------------
// buildConfidenceImpactLine — exported for unit testing
// ---------------------------------------------------------------------------

type ConfidenceBreakdownSnapshot = {
  base: number;
  destructivePenalty: number;
  schemaPenalty: number;
  criticalPenalty: number;
  massScopePenalty?: number;
  lowRiskBonus: number;
};
export function buildConfidenceImpactLine(
  breakdown: ConfidenceBreakdownSnapshot
): string | null {
  const destructivePenalty = breakdown.destructivePenalty ?? 0;
  const schemaPenalty = breakdown.schemaPenalty ?? 0;
  const criticalPenalty = breakdown.criticalPenalty ?? 0;
  const massScopePenalty = breakdown.massScopePenalty ?? 0;
  const lowRiskBonus = breakdown.lowRiskBonus ?? 0;

  const parts: string[] = [];

  if (destructivePenalty !== 0) {
    parts.push(`destructive penalty: ${destructivePenalty}`);
  }
  if (schemaPenalty !== 0) {
    parts.push(`schema penalty: ${schemaPenalty}`);
  }
  if (criticalPenalty !== 0) {
    parts.push(`critical penalty: ${criticalPenalty}`);
  }
  if (massScopePenalty !== 0) {
    parts.push(`mass-scope penalty: ${massScopePenalty}`);
  }
  if (lowRiskBonus !== 0) {
    parts.push(`low-risk bonus: +${lowRiskBonus}`);
  }

  if (parts.length === 0) return null;
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// buildExplanation v2 — multi-line
// ---------------------------------------------------------------------------

function buildExplanation(
  mode: RunAgentMode,
  score: number,
  signals: string[],
  confidenceBreakdown: ConfidenceBreakdownSnapshot
): string {
  const visibleSignals = signals.filter((signal) => signal !== "low_risk");
  const signalSuffix =
    visibleSignals.length > 0
      ? ` (${visibleSignals.map(formatSignal).join(" + ")} signals detected)`
      : "";

  let line1: string;
  switch (mode) {
    case "blocked":
      line1 = `BLOCKED: Risk score ${score}/100${signalSuffix}`;
      break;
    case "preview_only":
      line1 = `PREVIEW ONLY: Risk score ${score}/100${signalSuffix}`;
      break;
    case "safe_to_apply":
    default:
      line1 = `SAFE TO APPLY: Risk score ${score}/100${signalSuffix}`;
  }

  const line2 = `Primary cause: ${buildPrimaryCause(signals)}`;
  const impactLine = buildConfidenceImpactLine(confidenceBreakdown);

  const lines = [line1, line2];
  if (impactLine !== null) {
    lines.push(`Confidence impact: ${impactLine}`);
  }

  return lines.join("\n");
}

function buildRecommendation(mode: RunAgentMode): string {
  switch (mode) {
    case "blocked":
      return "Do not auto-apply. Manual review is required before making changes.";
    case "preview_only":
      return "Preview the patch and verify the affected scope before any apply step.";
    case "safe_to_apply":
    default:
      return "Patch can be applied automatically under current safeguards.";
  }
}

export function buildTopRisks(
  _score: number,
  signals: string[]
): Array<{
  title: string;
  severity: "low" | "medium" | "high";
  reason: string;
}> {
  const normalized = normalizeSignals(signals);

  const risks: Array<{
    title: string;
    severity: "low" | "medium" | "high";
    reason: string;
  }> = [];

  for (const signal of normalized) {
    if (signal.type === "destructive") {
      risks.push({
        title: signal.label,
        severity: signal.severity,
        reason:
          "Task contains destructive keywords that may cause irreversible data loss."
      });
    }

    if (signal.type === "schema") {
      risks.push({
        title: signal.label,
        severity: signal.severity,
        reason:
          "Schema modifications can break existing data contracts or migrations."
      });
    }

    if (signal.type === "critical_domain") {
      risks.push({
        title: signal.label,
        severity: signal.severity,
        reason:
          "Touches auth, billing, or production — elevated impact if change is incorrect."
      });
    }

    if (signal.type === "mass_scope") {
      risks.push({
        title: signal.label,
        severity: signal.severity,
        reason:
          "Task targets all records or the entire dataset — bulk operations are irreversible."
      });
    }
  }

  return risks;
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const normalizedTask = input.task.trim();
  const { score, signals, breakdown } = computeRiskScore(normalizedTask);
  const mode = mapScoreToMode(score, signals);
  const confidence = computeConfidenceScore({ breakdown });

  return {
    task: normalizedTask,
    decision: {
      mode,
      confidenceScore: confidence.score
    },
    risk: {
      score,
      breakdown: {
        destructive: breakdown.destructive,
        schema: breakdown.schema,
        critical: breakdown.critical,
        lowRisk: breakdown.lowRisk,
        massScope: breakdown.massScope
      }
    },
    confidence,
    explanation: buildExplanation(mode, score, signals, confidence.breakdown),
    recommendation: buildRecommendation(mode),
    topRisks: buildTopRisks(score, signals)
  };
}