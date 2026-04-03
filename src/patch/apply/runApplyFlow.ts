import { backupFile } from "../backupFile";
import type { PatchPlan } from "../conversion/generatedPlanConversionTypes";
import type {
  ApplyFlowResult,
  ApplyOperationResult
} from "../applyFlowTypes";

export function runApplyFlow(
  patchPlan: PatchPlan,
  backupRoot: string
): ApplyFlowResult {
  const operationsAttempted = patchPlan.operations.length;
  let operationsApplied = 0;
  const filesTouched: string[] = [];
  let backupCreated = false;
  const operationResults: ApplyOperationResult[] = [];

  try {
    if (operationsAttempted === 0) {
      return {
        status: "skipped",
        operationsAttempted: 0,
        operationsApplied: 0,
        filesTouched: [],
        backupCreated: false,
        message: "Apply was skipped because the patch plan contains no operations.",
        operationResults: []
      };
    }

    for (const [index, operation] of patchPlan.operations.entries()) {
      const filePath = operation.filePath;

      try {
        if (!backupCreated) {
          backupFile(filePath, backupRoot);
          backupCreated = true;
        }

        // burada mevcut gerçek apply mantığın kalmalı

        operationsApplied += 1;

        if (!filesTouched.includes(filePath)) {
          filesTouched.push(filePath);
        }

        operationResults.push({
          index,
          type: operation.type,
          filePath,
          status: "applied",
          message: "Operation applied successfully."
        });
      } catch (error) {
        operationResults.push({
          index,
          type: operation.type,
          filePath,
          status: "failed",
          message:
            error instanceof Error
              ? error.message
              : "Operation failed due to an unknown error."
        });

        return {
          status: "failed",
          operationsAttempted,
          operationsApplied,
          filesTouched,
          backupCreated,
          message: "Apply failed during operation execution.",
          operationResults
        };
      }
    }

    return {
      status: "applied",
      operationsAttempted,
      operationsApplied,
      filesTouched,
      backupCreated,
      message: "Patch applied successfully.",
      operationResults
    };
  } catch (error) {
    return {
      status: "failed",
      operationsAttempted,
      operationsApplied,
      filesTouched,
      backupCreated,
      message:
        error instanceof Error
          ? `Apply failed: ${error.message}`
          : "Apply failed due to an unknown error.",
      operationResults
    };
  }
}