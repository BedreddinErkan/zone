import type { ApplyFlowResult } from "../applyFlowTypes.js";

export function formatApplyFlowResult(result: ApplyFlowResult) {
  return {
    stage: "apply",
    status:
      result.status === "applied"
        ? "success"
        : result.status === "failed"
          ? "failed"
          : "skipped",
    summary: result.message,
    details:
      result.filesTouched.length > 0
        ? `Files touched: ${result.filesTouched.join(", ")}`
        : undefined,
    operationsAttempted: result.operationsAttempted,
    operationsApplied: result.operationsApplied,
    filesTouched: result.filesTouched,
    backupCreated: result.backupCreated,
    operationResults: result.operationResults
  } as const;
}