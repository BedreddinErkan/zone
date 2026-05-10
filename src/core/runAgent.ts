import { computeRiskScore } from "./computeRiskScore.js";
import { normalizeSignals } from "./normalizeSignals.js";
import { computeConfidenceScore } from "./scoring/computeConfidenceScore.js";
import { buildDecisionTrace } from "./buildDecisionTrace.js";
import { buildDecisionReasonCodes } from "./decision/buildDecisionReasonCodes.js";
import { buildDecisionExplanation } from "./decision/buildDecisionExplanation.js";
import {
  buildDecisionReasonDetails,
  type DecisionReasonCode
} from "./decision/decisionReasonCodeMeta.js";
import type {
  DecisionReason,
  DecisionReasonCode as ExecutionDecisionReasonCode
} from "./decision/decideExecutionMode.js";

type RunAgentInput = {
  task: string;
  role?: string;
};

// Phase J.4: narrowed from "blocked" | "preview_only" | "safe_to_apply".
// J.1 collapsed preview_only into safe_to_apply; mapScoreToMode never
// returns preview_only. Kept the type literal in saved/historical run
// fixtures via a separate persistence type — runAgent itself only emits
// the two live values.
export type RunAgentMode = "blocked" | "safe_to_apply";

type RunAgentTraceNormalizedSignal = {
  type: string;
  severity: string;
  confidenceImpact: number;
  label: string;
};

type RunAgentTracePenalty = {
  type: string;
  impact: number;
};
type RunAgentTraceReasonMapping = {
  code: string;
  severity: "info" | "warning" | "critical";
  category: string;
  message: string;
};

export type RunAgentTrace = {
  signals: string[];
  normalizedSignals: RunAgentTraceNormalizedSignal[];
  riskScore: number;
  confidenceScore: number;
  appliedPenalties: RunAgentTracePenalty[];
  decisionPath: string[];
  decisionFactors: {
    riskThreshold: number;
    triggeredBy: string[];
  };
  confidenceFormula: string;
  reasonMapping: RunAgentTraceReasonMapping[];
};

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
  trace: RunAgentTrace;
  reasonCodes: string[];
};

function mapScoreToMode(score: number, _signals: string[]): RunAgentMode {
  // Phase J.1: confidence/signal heuristics no longer gate apply. Only the
  // hard high-risk threshold (matches safetyLevelResolver step 2) blocks;
  // schema / critical_domain / mass_scope signals were previously routed to
  // preview_only — they now produce safe_to_apply (verification + security
  // validators handle real failures separately).
  if (score >= 71) {
    return "blocked";
  }
  return "safe_to_apply";
}

function toRiskSeverity(value: string): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  return "medium";
}

function buildRecommendation(mode: RunAgentMode): string {
  // Phase J.4: dropped the preview_only case after the union narrowed.
  if (mode === "blocked") {
    return "Do not auto-apply. Manual review is required before making changes.";
  }
  return "Patch can be applied automatically under current safeguards.";
}

function mapNormalizedSignalTypeForReasonCodes(
  type: string
): "destructive" | "schema" | "critical" | "lowRisk" | "massScope" | null {
  switch (type) {
    case "destructive":
      return "destructive";
    case "schema":
      return "schema";
    case "critical_domain":
      return "critical";
    case "low_risk":
      return "lowRisk";
    case "mass_scope":
      return "massScope";
    default:
      return null;
  }
}

function mapReasonSeverityForExplanation(
  severity: "low" | "medium" | "high"
): "info" | "warning" | "critical" {
  switch (severity) {
    case "high":
      return "critical";
    case "medium":
      return "warning";
    case "low":
    default:
      return "info";
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
        severity: toRiskSeverity(signal.severity),
        reason:
          "Task contains destructive keywords that may cause irreversible data loss."
      });
    }

    if (signal.type === "schema") {
      risks.push({
        title: signal.label,
        severity: toRiskSeverity(signal.severity),
        reason:
          "Schema modifications can break existing data contracts or migrations."
      });
    }

    if (signal.type === "critical_domain") {
      risks.push({
        title: signal.label,
        severity: toRiskSeverity(signal.severity),
        reason:
          "Touches auth, billing, or production — elevated impact if change is incorrect."
      });
    }

    if (signal.type === "mass_scope") {
      risks.push({
        title: signal.label,
        severity: toRiskSeverity(signal.severity),
        reason:
          "Task targets all records or the entire dataset — bulk operations are irreversible."
      });
    }
  }

  return risks;
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const normalizedTask = input.task.trim();
const { score, signals, breakdown } = computeRiskScore({
  task: normalizedTask,
  role: input.role,
});  const mode = mapScoreToMode(score, signals);
  const confidence = computeConfidenceScore({ breakdown });


  const reasonCodes = buildDecisionReasonCodes({
    mode,
    riskScore: score,
    confidenceScore: confidence.score,
    normalizedSignals: normalizeSignals(signals)
      .map((signal) => mapNormalizedSignalTypeForReasonCodes(signal.type))
      .filter(
        (
          type
        ): type is "destructive" | "schema" | "critical" | "lowRisk" | "massScope" =>
          type !== null
      )
      .map((type) => ({ type }))
  }) as DecisionReasonCode[];

  const reasonDetails = buildDecisionReasonDetails(reasonCodes);
const trace = buildDecisionTrace({
  signals,
  riskScore: score,
  confidenceScore: confidence.score,
  confidenceBreakdown: confidence.breakdown,
  mode,
  reasonDetails: reasonDetails.map((reason) => ({
    code: reason.code,
    severity: mapReasonSeverityForExplanation(reason.severity),
    category: reason.category,
    message: reason.summary
  }))
});
  const explanationReasons: DecisionReason[] = reasonDetails.map((reason) => ({
    code: reason.code as ExecutionDecisionReasonCode,
    severity: mapReasonSeverityForExplanation(reason.severity),
    category: reason.category,
    message: reason.summary
  }));

  const result = {
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
    recommendation: buildRecommendation(mode),
    topRisks: buildTopRisks(score, signals),
    trace,
    reasonCodes
  };

  return {
    ...result,
    explanation: buildDecisionExplanation(
      {
        mode,
        confidenceScore: confidence.score,
        reasons: explanationReasons
      },
      { reasonCodes: reasonCodes as never }
    )
  };
}
type ConfidenceBreakdownSnapshot = {
  base: number;
  destructivePenalty: number;
  schemaPenalty: number;
  criticalPenalty: number;
  massScopePenalty: number;
  lowRiskBonus: number;
};

export function buildPrimaryCause(signals: string[]): string {
  if (signals.includes("destructive")) return "destructive operation";
  if (signals.includes("schema")) return "schema-sensitive change";
  if (signals.includes("critical_domain")) return "critical domain access";
  if (signals.includes("mass_scope")) return "mass-scope operation";
  return "general task";
}

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