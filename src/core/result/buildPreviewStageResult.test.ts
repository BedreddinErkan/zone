import { describe, expect, it } from "vitest";
import { buildPreviewStageResult } from "./buildPreviewStageResult.js";
import type { GeneratedPatchPlan } from "../../patch-generation/generatedPatchPlanTypes.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makePlan(overrides: Partial<GeneratedPatchPlan> = {}): GeneratedPatchPlan {
  return {
    version: 1,
    intent: "safe_replace",
    operations: [],
    summary: "Test plan",
    warnings: [],
    ...overrides,
  };
}

const safeReplaceOp: GeneratedPatchPlan["operations"][number] = {
  type: "safe_replace",
  filePath: "src/index.ts",
  find: "foo",
  replaceWith: "bar",
  matchMode: "exact",
};

const renameOp: GeneratedPatchPlan["operations"][number] = {
  type: "rename_symbol",
  filePath: "src/utils.ts",
  from: "oldName",
  to: "newName",
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe("buildPreviewStageResult", () => {
  it("stage is always 'generated_patch_preview'", () => {
    const result = buildPreviewStageResult(makePlan());
    expect(result.stage).toBe("generated_patch_preview");
  });

  it("meta is always stamped correctly", () => {
    const result = buildPreviewStageResult(makePlan({ operations: [safeReplaceOp] }));
    expect(result.meta.stage).toBe("generated_patch_preview");
    expect(result.meta.engine).toBe("zone");
    expect(result.meta.version).toBe("2.0");
  });

  // ── zero operations ──────────────────────────────────────────────────────

  it("zero operations → status: info, severity: warning, code: ZONE_SKIPPED", () => {
    const result = buildPreviewStageResult(makePlan({ operations: [] }));
    expect(result.status).toBe("info");
    expect(result.severity).toBe("warning");
    expect(result.code).toBe("ZONE_SKIPPED");
  });

  it("zero operations → summary mentions no operations", () => {
    const result = buildPreviewStageResult(makePlan({ operations: [] }));
    expect(result.summary).toBe("Generated patch preview contains no operations.");
  });

  it("zero operations → details is undefined", () => {
    const result = buildPreviewStageResult(makePlan({ operations: [] }));
    expect(result.details).toBeUndefined();
  });

  // ── one operation ────────────────────────────────────────────────────────

  it("one operation → status: success, severity: ok, code: ZONE_OK", () => {
    const result = buildPreviewStageResult(makePlan({ operations: [safeReplaceOp] }));
    expect(result.status).toBe("success");
    expect(result.severity).toBe("ok");
    expect(result.code).toBe("ZONE_OK");
  });

  it("one operation → summary uses singular form", () => {
    const result = buildPreviewStageResult(makePlan({ operations: [safeReplaceOp] }));
    expect(result.summary).toBe("Generated patch preview contains 1 operation.");
  });

  it("one operation → details lists the operation with filePath", () => {
    const result = buildPreviewStageResult(makePlan({ operations: [safeReplaceOp] }));
    expect(result.details).toBe("1. safe_replace -> src/index.ts");
  });

  // ── multiple operations ──────────────────────────────────────────────────

  it("multiple operations → status: success, severity: ok, code: ZONE_OK", () => {
    const result = buildPreviewStageResult(
      makePlan({ operations: [safeReplaceOp, renameOp] })
    );
    expect(result.status).toBe("success");
    expect(result.severity).toBe("ok");
    expect(result.code).toBe("ZONE_OK");
  });

  it("multiple operations → summary uses plural form with count", () => {
    const result = buildPreviewStageResult(
      makePlan({ operations: [safeReplaceOp, renameOp] })
    );
    expect(result.summary).toBe("Generated patch preview contains 2 operations.");
  });

  it("multiple operations → details lists all operations in order", () => {
    const result = buildPreviewStageResult(
      makePlan({ operations: [safeReplaceOp, renameOp] })
    );
    expect(result.details).toBe(
      "1. safe_replace -> src/index.ts\n2. rename_symbol -> src/utils.ts"
    );
  });

  // ── timestamps not set ───────────────────────────────────────────────────

  it("timestamps is never set by this builder", () => {
    const withOps = buildPreviewStageResult(makePlan({ operations: [safeReplaceOp] }));
    const withoutOps = buildPreviewStageResult(makePlan({ operations: [] }));
    expect(withOps.timestamps).toBeUndefined();
    expect(withoutOps.timestamps).toBeUndefined();
  });
});
