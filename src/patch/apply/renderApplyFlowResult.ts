import type { ApplyFlowResult } from "../applyFlowTypes.js";
export function renderApplyFlowResult(result: ApplyFlowResult): string {
  return [
    "=== APPLY RESULT ===",
    `Status: ${result.status}`,
    `Operations attempted: ${result.operationsAttempted}`,
    `Operations applied: ${result.operationsApplied}`,
    `Files touched: ${result.filesTouched.join(", ") || "none"}`,
    `Backup created: ${result.backupCreated ? "yes" : "no"}`,
    `Message: ${result.message}`
  ].join("\n");
}