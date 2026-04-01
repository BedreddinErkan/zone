export type CiStatus = "pass" | "warn" | "fail";

export type CiPenaltyLike = {
  label?: string;
};

export type CiIssueSummaryLike = {
  errors?: number;
  warnings?: number;
  total?: number;
};

export type CiResultLike = {
  decision?: {
    mode?: "blocked" | "preview_only" | "safe_to_apply" | "preview" | "apply" | string;
    confidenceScore?: number;
    confidence?: number;
    reason?: string;
    recommendation?: string;
  };
  confidence?: {
    finalScore?: number;
  };
  confidenceBreakdown?: {
    finalScore?: number;
    level?: string;
  };
  confidenceDetails?: {
    penalties?: CiPenaltyLike[];
  };
  issues?: {
    summary?: CiIssueSummaryLike;
  };
  statusLine?: string;
};

export interface CiEvaluation {
  decisionMode:
    | "blocked"
    | "preview_only"
    | "safe_to_apply"
    | "preview"
    | "apply"
    | "unknown";
  ciStatus: CiStatus;
  shouldFail: boolean;
  confidenceScore: number | null;
  statusLine: string;
  summaryLine: string;
  penaltyReasons: string[];
}

function normalizeDecisionMode(
  result: CiResultLike
): CiEvaluation["decisionMode"] {
  const mode = result?.decision?.mode;

  if (
    mode === "blocked" ||
    mode === "preview_only" ||
    mode === "safe_to_apply" ||
    mode === "preview" ||
    mode === "apply"
  ) {
    return mode;
  }

  return "unknown";
}

function normalizeConfidenceScore(result: CiResultLike): number | null {
  if (typeof result?.decision?.confidenceScore === "number") {
    return result.decision.confidenceScore;
  }

  if (typeof result?.decision?.confidence === "number") {
    return result.decision.confidence;
  }

  if (typeof result?.confidence?.finalScore === "number") {
    return result.confidence.finalScore;
  }

  if (typeof result?.confidenceBreakdown?.finalScore === "number") {
    return result.confidenceBreakdown.finalScore;
  }

  return null;
}

function normalizePenaltyReasons(result: CiResultLike): string[] {
  const penalties = result?.confidenceDetails?.penalties ?? [];

  const reasons = penalties
    .map((item) => item.label?.trim())
    .filter((value): value is string => Boolean(value));

  return [...new Set(reasons)];
}

function buildStatusLine(
  decisionMode: CiEvaluation["decisionMode"]
): string {
  switch (decisionMode) {
    case "blocked":
      return "STATUS: BLOCKED";
    case "preview_only":
    case "preview":
      return "STATUS: PREVIEW ONLY";
    case "safe_to_apply":
    case "apply":
      return "STATUS: SAFE TO APPLY";
    default:
      return "STATUS: UNKNOWN";
  }
}

function buildSummaryLine(input: {
  result: CiResultLike;
  decisionMode: CiEvaluation["decisionMode"];
  confidenceScore: number | null;
  penaltyReasons: string[];
}): string {
  const parts: string[] = [];

  parts.push(`decision=${input.decisionMode}`);

  if (typeof input.confidenceScore === "number") {
    parts.push(`confidence=${input.confidenceScore}`);
  }

  if (input.result?.decision?.reason) {
    parts.push(`reason=${input.result.decision.reason}`);
  }

  const errorCount = input.result?.issues?.summary?.errors;
  const warningCount = input.result?.issues?.summary?.warnings;

  if (typeof errorCount === "number") {
    parts.push(`errors=${errorCount}`);
  }

  if (typeof warningCount === "number") {
    parts.push(`warnings=${warningCount}`);
  }

  if (input.penaltyReasons.length > 0) {
    parts.push(`penalties=${input.penaltyReasons.slice(0, 4).join(" | ")}`);
  } else {
    parts.push("penalties=none");
  }

  return parts.join(" ; ");
}

export function evaluateCiResult(result: CiResultLike): CiEvaluation {
  const decisionMode = normalizeDecisionMode(result);
  const confidenceScore = normalizeConfidenceScore(result);
  const penaltyReasons = normalizePenaltyReasons(result);

  const errorCount = result?.issues?.summary?.errors ?? 0;

  let ciStatus: CiStatus = "warn";
  let shouldFail = false;

  if (decisionMode === "blocked") {
    ciStatus = "fail";
    shouldFail = true;
  } else if (errorCount > 0) {
    ciStatus = "fail";
    shouldFail = true;
  } else if (decisionMode === "preview_only" || decisionMode === "preview") {
    ciStatus = "warn";
  } else if (decisionMode === "safe_to_apply" || decisionMode === "apply") {
    ciStatus = "pass";
  }

  return {
    decisionMode,
    ciStatus,
    shouldFail,
    confidenceScore,
    statusLine: result.statusLine || buildStatusLine(decisionMode),
    summaryLine: buildSummaryLine({
      result,
      decisionMode,
      confidenceScore,
      penaltyReasons
    }),
    penaltyReasons
  };
}