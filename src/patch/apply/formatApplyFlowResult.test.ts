import { describe, expect, it } from "vitest";
import { formatApplyFlowResult } from "./formatApplyFlowResult.js";

describe("formatApplyFlowResult", () => {
  it("returns a stable structured result", () => {
    expect(
      formatApplyFlowResult({
        status: "applied",
        operationsAttempted: 1,
        operationsApplied: 1,
        filesTouched: ["src/index.ts"],
        backupCreated: true,
        message: "Patch applied successfully.",
        operationResults: [
          {
            index: 0,
            type: "safe_replace",
            filePath: "src/index.ts",
            status: "applied",
            message: "Operation applied successfully."
          }
        ]
      })
    ).toEqual({
      stage: "apply",
      status: "success",
      summary: "Patch applied successfully.",
      details: "Files touched: src/index.ts",
      operationsAttempted: 1,
      operationsApplied: 1,
      filesTouched: ["src/index.ts"],
      backupCreated: true,
      operationResults: [
        {
          index: 0,
          type: "safe_replace",
          filePath: "src/index.ts",
          status: "applied",
          message: "Operation applied successfully."
        }
      ]
    });
  });
});