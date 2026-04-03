import type { RunAgentMode } from "../runAgent.js";

export type SupportedDecisionReasonSignalType =
  | "destructive"
  | "schema"
  | "critical"
  | "lowRisk"
  | "massScope";

type MinimalSignal = {
  type: SupportedDecisionReasonSignalType;
};

export type BuildDecisionReasonCodesInput = {
  mode: RunAgentMode;
  riskScore: number;
  confidenceScore: number;
  normalizedSignals: MinimalSignal[];
};

const REASON_CODE_PRIORITY: string[] = [
  "BLOCKED_DESTRUCTIVE_OPERATION",
  "BLOCKED_SCHEMA_RISK",
  "BLOCKED_CRITICAL_RISK",
  "BLOCKED_HIGH_RISK_SCORE",
  "PREVIEW_DESTRUCTIVE_SIGNAL",
  "PREVIEW_SCHEMA_UNCERTAINTY",
  "PREVIEW_CRITICAL_SIGNAL",
  "PREVIEW_MASS_SCOPE_CHANGE",
  "PREVIEW_LOW_CONFIDENCE",
  "SAFE_LOW_RISK_LOCALIZED",
  "SAFE_HIGH_CONFIDENCE"
];

function getReasonCodePriority(code: string): number {
  const index = REASON_CODE_PRIORITY.indexOf(code);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function buildDecisionReasonCodes(
  input: BuildDecisionReasonCodesInput
): string[] {
  const codes = new Set<string>();
  const signalTypes = new Set(
    input.normalizedSignals.map((signal) => signal.type)
  );

  if (input.mode === "blocked") {
    if (signalTypes.has("destructive")) {
      codes.add("BLOCKED_DESTRUCTIVE_OPERATION");
    }

    if (signalTypes.has("schema")) {
      codes.add("BLOCKED_SCHEMA_RISK");
    }

    if (signalTypes.has("critical")) {
      codes.add("BLOCKED_CRITICAL_RISK");
    }

    if (input.riskScore >= 70) {
      codes.add("BLOCKED_HIGH_RISK_SCORE");
    }
  }

  if (input.mode === "preview_only") {
    if (signalTypes.has("destructive")) {
      codes.add("PREVIEW_DESTRUCTIVE_SIGNAL");
    }

    if (signalTypes.has("schema")) {
      codes.add("PREVIEW_SCHEMA_UNCERTAINTY");
    }

    if (signalTypes.has("critical")) {
      codes.add("PREVIEW_CRITICAL_SIGNAL");
    }

    if (signalTypes.has("massScope")) {
      codes.add("PREVIEW_MASS_SCOPE_CHANGE");
    }

    if (input.confidenceScore < 70) {
      codes.add("PREVIEW_LOW_CONFIDENCE");
    }
  }

  if (input.mode === "safe_to_apply") {
    if (signalTypes.has("lowRisk")) {
      codes.add("SAFE_LOW_RISK_LOCALIZED");
    }

    if (input.confidenceScore >= 80) {
      codes.add("SAFE_HIGH_CONFIDENCE");
    }
  }

  return [...codes].sort(
    (left, right) =>
      getReasonCodePriority(left) - getReasonCodePriority(right)
  );
}