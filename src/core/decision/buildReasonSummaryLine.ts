import {
  buildDecisionReasonDetails,
  type DecisionReasonCode
} from "./decisionReasonCodeMeta.js";

export function buildReasonSummaryLine(
  reasonCodes: readonly DecisionReasonCode[]
): string {
  const uniqueCodes = [...new Set(reasonCodes)];

  if (uniqueCodes.length === 0) {
    return "Why: no explicit decision reasons.";
  }

 const details = buildDecisionReasonDetails([...uniqueCodes]).filter(
  (detail): detail is { summary: string } & typeof detail => Boolean(detail)
);

if (details.length === 0) {
  return "Why: no explicit decision reasons.";
}

const summaries = details.map((detail) => normalizeSummary(detail.summary));
  return `Why: ${summaries.join("; ")}.`;
}

function normalizeSummary(summary: string): string {
  const trimmed = summary.trim();

  if (trimmed.length === 0) {
    return "unspecified reason";
  }

  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}