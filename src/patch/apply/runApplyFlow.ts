import fs from "node:fs";
import path from "node:path";

import type { PatchPlan } from "../conversion/generatedPlanConversionTypes.js";
import type {
  ApplyFlowResult,
  ApplyOperationResult
} from "../applyFlowTypes.js";

export function runApplyFlow(
  patchPlan: PatchPlan,
  backupRoot: string
): ApplyFlowResult {
  const operationsAttempted = patchPlan.operations.length;
  const backupPaths = Array.from(
    new Set(patchPlan.operations.map((operation) => operation.filePath))
  );
  let operationsApplied = 0;
  const filesTouched: string[] = [];
  let backupCreated = false;
  const operationResults: ApplyOperationResult[] = [];
  const backupEntries: Array<{ originalPath: string; backupPath: string }> = [];

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

    const backupTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(backupRoot, backupTimestamp);

    const rollbackApplied = () => {
      for (const entry of backupEntries) {
        fs.mkdirSync(path.dirname(entry.originalPath), { recursive: true });
        fs.copyFileSync(entry.backupPath, entry.originalPath);
      }
    };

    for (const [index, filePath] of backupPaths.entries()) {
      if (!fs.existsSync(filePath)) {
        continue;
      }

      if (!backupCreated) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const backupPath = path.join(
        backupDir,
        `${index}-${path.basename(filePath)}`
      );
      fs.copyFileSync(filePath, backupPath);
      backupEntries.push({ originalPath: filePath, backupPath });
      backupCreated = true;
    }

    for (const [index, operation] of patchPlan.operations.entries()) {
      const filePath = operation.filePath;

      try {
        // Existing apply logic stays here.

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

        rollbackApplied();

        return {
          status: "failed",
          operationsAttempted,
          operationsApplied,
          filesTouched,
          backupCreated,
          rolledBack: true,
          message: "Apply failed and all changes were rolled back.",
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
