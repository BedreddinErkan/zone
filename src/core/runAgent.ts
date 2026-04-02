import { computeRiskScore } from "./computeRiskScore.js";
import { computeConfidenceScore } from "./scoring/computeConfidenceScore.js";

type RunAgentInput = {
  task: string;
};

type RunAgentMode = "blocked" | "preview_only" | "safe_to_apply";

type RunAgentResult = {
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
    };
  };
  confidence: {
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

function mapScoreToMode(score: number, signals: string[]): RunAgentMode {
  if (score >= 71) {
    return "blocked";
  }

  if (
    score >= 31 ||
    signals.includes("schema") ||
    signals.includes("critical_domain")
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
  lowRiskBonus: number;
};

export function buildConfidenceImpactLine(
  breakdown: ConfidenceBreakdownSnapshot
): string | null {
  const parts: string[] = [];

  if (breakdown.destructivePenalty !== 0) {
    parts.push(`destructive penalty: ${breakdown.destructivePenalty}`);
  }
  if (breakdown.schemaPenalty !== 0) {
    parts.push(`schema penalty: ${breakdown.schemaPenalty}`);
  }
  if (breakdown.criticalPenalty !== 0) {
    parts.push(`critical penalty: ${breakdown.criticalPenalty}`);
  }
  if (breakdown.lowRiskBonus !== 0) {
    parts.push(`low-risk bonus: +${breakdown.lowRiskBonus}`);
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
  const risks: Array<{
    title: string;
    severity: "low" | "medium" | "high";
    reason: string;
  }> = [];

  if (signals.includes("destructive")) {
    risks.push({
      title: "Potentially destructive change",
      severity: "high",
      reason: "Task contains destructive keywords that may cause irreversible data loss."
    });
  }

  if (signals.includes("schema")) {
    risks.push({
      title: "Schema-sensitive change",
      severity: "medium",
      reason: "Schema modifications can break existing data contracts or migrations."
    });
  }

  if (signals.includes("critical_domain")) {
    risks.push({
      title: "Critical domain surface",
      severity: "medium",
      reason: "Touches auth, billing, or production — elevated impact if change is incorrect."
    });
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
      breakdown
    },
    confidence,
    explanation: buildExplanation(mode, score, signals, confidence.breakdown),
    recommendation: buildRecommendation(mode),
    topRisks: buildTopRisks(score, signals)
  };
}