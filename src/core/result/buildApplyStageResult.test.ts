import { describe, expect, it } from "vitest";
import { buildApplyStageResult } from "./buildApplyStageResult.js";
import type { ApplyFlowResult } from "../../patch/applyFlowTypes.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function buildFlowResult(overrides: Partial<ApplyFlowResult>): ApplyFlowResult {
  return {
    status: "applied",
    operationsAttempted: 1,
    operationsApplied: 1,
    filesTouched: ["src/index.ts"],
    backupCreated: true,
    message: "Patch applied successfully.",
    operationResults: [],
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("buildApplyStageResult", () => {
  // 1. applied → success path
  it("applied → success path", () => {
    const result = buildApplyStageResult(buildFlowResult({}));

    expect(result.status).toBe("success");
    expect(result.severity).toBe("ok");
    expect(result.code).toBe("ZONE_APPLY_SUCCESS");
    expect(result.stage).toBe("apply");
    expect(result.meta.engine).toBe("zone");
    expect(result.meta.version).toBe("2.0");
    expect(result.summary).toBe("Apply succeeded: all operations applied successfully.");
    expect(result.details).toBe("Files touched: src/index.ts");
  });

  // 2. failed with partial success → ZONE_APPLY_PARTIAL
  it("failed with partial success → ZONE_APPLY_PARTIAL", () => {
    const result = buildApplyStageResult(
      buildFlowResult({ status: "failed", operationsApplied: 1, operationsAttempted: 2 })
    );

    expect(result.severity).toBe("error");
    expect(result.code).toBe("ZONE_APPLY_PARTIAL");
    expect(result.status).toBe("failed");
    expect(result.summary).toBe("Apply partially failed: some operations were not applied.");
  });

  // 3. failed with zero applied → ZONE_APPLY_FAILED
  it("failed with zero applied → ZONE_APPLY_FAILED", () => {
    const result = buildApplyStageResult(
      buildFlowResult({ status: "failed", operationsApplied: 0, operationsAttempted: 1 })
    );

    expect(result.severity).toBe("fatal");
    expect(result.code).toBe("ZONE_APPLY_FAILED");
    expect(result.status).toBe("failed");
    expect(result.summary).toBe("Apply failed: no operations were applied.");
  });

  // 4. skipped → ZONE_SKIPPED
  it("skipped → ZONE_SKIPPED", () => {
    const result = buildApplyStageResult(
      buildFlowResult({ status: "skipped", operationsAttempted: 0, operationsApplied: 0, filesTouched: [] })
    );

    expect(result.status).toBe("skipped");
    expect(result.severity).toBe("warning");
    expect(result.code).toBe("ZONE_SKIPPED");
    expect(result.summary).toBe("Apply skipped: no operations were executed.");
  });

  // 5. details present when filesTouched non-empty
  it("details is set when filesTouched has entries", () => {
    const result = buildApplyStageResult(
      buildFlowResult({ filesTouched: ["src/a.ts", "src/b.ts"] })
    );

    expect(result.details).toBe("Files touched: src/a.ts, src/b.ts");
  });

  // 6. details absent when filesTouched is empty
  it("details is absent when filesTouched is empty", () => {
    const result = buildApplyStageResult(
      buildFlowResult({ filesTouched: [] })
    );

    expect(result.details).toBeUndefined();
  });

  // 7. meta invariant — applied path
  it("meta is stamped correctly for applied", () => {
    const result = buildApplyStageResult(buildFlowResult({}));

    expect(result.meta.stage).toBe("apply");
    expect(result.meta.engine).toBe("zone");
    expect(result.meta.version).toBe("2.0");
  });

  // 8. meta invariant — failed path
  it("meta is stamped correctly for failed", () => {
    const result = buildApplyStageResult(
      buildFlowResult({ status: "failed", operationsApplied: 0 })
    );

    expect(result.meta.stage).toBe("apply");
    expect(result.meta.engine).toBe("zone");
    expect(result.meta.version).toBe("2.0");
  });

  // 9. meta invariant — skipped path
  it("meta is stamped correctly for skipped", () => {
    const result = buildApplyStageResult(
      buildFlowResult({ status: "skipped", operationsAttempted: 0, operationsApplied: 0, filesTouched: [] })
    );

    expect(result.meta.stage).toBe("apply");
    expect(result.meta.engine).toBe("zone");
    expect(result.meta.version).toBe("2.0");
  });
});
