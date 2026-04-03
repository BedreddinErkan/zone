import type { ApplyFlowResult } from "./applyFlowTypes.js";

export function renderApplyFlowResult(result: ApplyFlowResult): string {
  const operationLines =
    result.operationResults.length > 0
      ? result.operationResults.map((operation) =>
          [
            `  - #${operation.index + 1}`,
            `    Type: ${operation.type}`,
            `    File: ${operation.filePath}`,
            `    Status: ${operation.status}`,
            `    Message: ${operation.message}`
          ].join("\n")
        )
      : ["  none"];

  return [
    "=== APPLY RESULT ===",
    `Status: ${result.status}`,
    `Operations attempted: ${result.operationsAttempted}`,
    `Operations applied: ${result.operationsApplied}`,
    `Files touched: ${
      result.filesTouched.length > 0 ? result.filesTouched.join(", ") : "none"
    }`,
    `Backup created: ${result.backupCreated ? "yes" : "no"}`,
    `Message: ${result.message}`,
    "Operation results:",
    ...operationLines
  ].join("\n");
}