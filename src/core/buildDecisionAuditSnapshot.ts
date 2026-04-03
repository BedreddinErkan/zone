import {
  buildDecisionReasonDetails,
  type DecisionReasonCode
} from "./decision/decisionReasonCodeMeta.js";
import type { RunAgentResult } from "./runAgent.js";

type BuildDecisionAuditSnapshotInput = {
  decision: RunAgentResult["decision"];
  risk: RunAgentResult["risk"];
  topRisks: RunAgentResult["topRisks"];
  reasonCodes?: readonly DecisionReasonCode[];
  trace?: RunAgentResult["trace"];
};

export type DecisionAuditSnapshot = {
  mode: RunAgentResult["decision"]["mode"];
  confidenceScore: number;
  riskScore: number;
  reasonCodes: readonly DecisionReasonCode[];
  reasonDetails: ReturnType<typeof buildDecisionReasonDetails>;
  triggeredBy: string[];
  confidenceFormula: string;
  topRiskSummaries: string[];
};

export function buildDecisionAuditSnapshot(
  result: BuildDecisionAuditSnapshotInput
): DecisionAuditSnapshot {
  const reasonCodes = result.reasonCodes ?? [];

  return {
    mode: result.decision.mode,
    confidenceScore: result.decision.confidenceScore,
    riskScore: result.risk.score,
    reasonCodes,
    reasonDetails: buildDecisionReasonDetails([...reasonCodes]),
    triggeredBy: result.trace?.decisionFactors.triggeredBy ?? [],
    confidenceFormula: result.trace?.confidenceFormula ?? "",
    topRiskSummaries: result.topRisks.map(
      (risk) => `[${risk.severity}] ${risk.title}`
    )
  };
}