import type { RunAgentResult } from "./runAgent.js";
import { renderRunAgentResult } from "./renderRunAgentResult.js";
import { buildDecisionAuditSnapshot } from "./buildDecisionAuditSnapshot.js";
import {
  buildDecisionReasonDetails,
  type DecisionReasonCode
} from "./decision/decisionReasonCodeMeta.js";

export type OutputFormat = "text" | "json";

export type FormatOutputOptions = {
  showTrace?: boolean;
  verbose?: boolean;
};

export function formatOutput(
  result: RunAgentResult,
  format: OutputFormat,
  options: FormatOutputOptions = {}
): string {
  const { showTrace = false, verbose = false } = options;

  const includeTrace = showTrace || verbose;
  const typedReasonCodes = (result.reasonCodes ?? []) as DecisionReasonCode[];

  const reasonDetails =
    verbose && typedReasonCodes.length > 0
      ? buildDecisionReasonDetails(typedReasonCodes)
      : undefined;

  const auditSnapshot = verbose
    ? buildDecisionAuditSnapshot({
        decision: result.decision,
        risk: result.risk,
        topRisks: result.topRisks,
        reasonCodes: typedReasonCodes,
        trace: result.trace
      })
    : undefined;

  if (format === "json") {
    const baseResult = includeTrace
      ? result
      : (() => {
          const { trace: _trace, ...resultWithoutTrace } = result;
          return resultWithoutTrace;
        })();

    const output = {
      ...baseResult,
      ...(reasonDetails ? { reasonDetails } : {}),
      ...(auditSnapshot ? { auditSnapshot } : {})
    };

    return JSON.stringify(output, null, 2);
  }

  const base = renderRunAgentResult(
    {
      ...result,
      reasonCodes: typedReasonCodes,
      ...(auditSnapshot ? { auditSnapshot } : {})
    },
    { verbose }
  );

  if (!includeTrace || !result.trace) {
    return base;
  }

  const lines: string[] = [base, "", "--- Decision Trace ---", "Path:"];

  for (const step of result.trace.decisionPath) {
    lines.push(`→ ${step}`);
  }

  lines.push(`Formula: ${result.trace.confidenceFormula}`);
  lines.push(
    `Triggered by: ${result.trace.decisionFactors.triggeredBy.join(", ") || "none"}`
  );

  return lines.join("\n");
}