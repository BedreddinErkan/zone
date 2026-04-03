import { describe, expect, it } from "vitest";
import { buildConversionStageResult } from "./buildConversionStageResult.js";
import type { GeneratedPlanConversionCheck } from "../../patch/conversion/generatedPlanConversionTypes.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const success: GeneratedPlanConversionCheck = { canConvert: true };

function failure(
  code: Exclude<GeneratedPlanConversionCheck, { canConvert: true }>["code"],
  reason = "some specific reason"
): GeneratedPlanConversionCheck {
  return { canConvert: false, code, reason };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("buildConversionStageResult", () => {
  // 1. success path
  it("canConvert: true → success path", () => {
    const result = buildConversionStageResult(success);

    expect(result.status).toBe("success");
    expect(result.severity).toBe("ok");
    expect(result.code).toBe("ZONE_OK");
    expect(result.stage).toBe("generated_patch_conversion");
    expect(result.meta.engine).toBe("zone");
    expect(result.meta.version).toBe("2.0");
    expect(result.details).toBeUndefined();
    expect(result.summary).toBe("Generated patch plan conversion succeeded.");
  });

  // 2. PLACEHOLDER_FILE_PATH
  it("PLACEHOLDER_FILE_PATH → ZONE_CONVERSION_FAILED_PLACEHOLDER", () => {
    const result = buildConversionStageResult(failure("PLACEHOLDER_FILE_PATH", "path has {{placeholder}}"));

    expect(result.status).toBe("blocked");
    expect(result.severity).toBe("fatal");
    expect(result.code).toBe("ZONE_CONVERSION_FAILED_PLACEHOLDER");
    expect(result.details).toBe("path has {{placeholder}}");
  });

  // 3. PLACEHOLDER_TEXT
  it("PLACEHOLDER_TEXT → ZONE_CONVERSION_FAILED_PLACEHOLDER", () => {
    const result = buildConversionStageResult(failure("PLACEHOLDER_TEXT", "find contains {{placeholder}}"));

    expect(result.code).toBe("ZONE_CONVERSION_FAILED_PLACEHOLDER");
    expect(result.status).toBe("blocked");
    expect(result.severity).toBe("fatal");
  });

  // 4. UNSUPPORTED_INTENT
  it("UNSUPPORTED_INTENT → ZONE_CONVERSION_FAILED_UNSUPPORTED", () => {
    const result = buildConversionStageResult(failure("UNSUPPORTED_INTENT"));

    expect(result.code).toBe("ZONE_CONVERSION_FAILED_UNSUPPORTED");
    expect(result.status).toBe("blocked");
    expect(result.severity).toBe("fatal");
  });

  // 5. UNSUPPORTED_OPERATION
  it("UNSUPPORTED_OPERATION → ZONE_CONVERSION_FAILED_UNSUPPORTED", () => {
    const result = buildConversionStageResult(failure("UNSUPPORTED_OPERATION"));

    expect(result.code).toBe("ZONE_CONVERSION_FAILED_UNSUPPORTED");
  });

  // 6. EMPTY_OPERATIONS
  it("EMPTY_OPERATIONS → ZONE_CONVERSION_FAILED with exact summary", () => {
    const result = buildConversionStageResult(failure("EMPTY_OPERATIONS"));

    expect(result.code).toBe("ZONE_CONVERSION_FAILED");
    expect(result.summary).toBe("Conversion blocked: generated plan contains no operations.");
  });

  // 7. NON_EXACT_MATCH
  it("NON_EXACT_MATCH → ZONE_CONVERSION_FAILED", () => {
    const result = buildConversionStageResult(failure("NON_EXACT_MATCH"));

    expect(result.code).toBe("ZONE_CONVERSION_FAILED");
  });

  // 8. NO_OP_REPLACEMENT
  it("NO_OP_REPLACEMENT → ZONE_CONVERSION_FAILED", () => {
    const result = buildConversionStageResult(failure("NO_OP_REPLACEMENT"));

    expect(result.code).toBe("ZONE_CONVERSION_FAILED");
  });

  // 9. details always carries failure reason
  it("details always carries the failure reason string", () => {
    const result = buildConversionStageResult(
      failure("MISSING_REQUIRED_FIELDS", "some specific reason")
    );

    expect(result.details).toBe("some specific reason");
  });

  // 10. meta invariant across both paths
  it("meta is stamped correctly for canConvert: true", () => {
    const result = buildConversionStageResult(success);

    expect(result.meta.stage).toBe("generated_patch_conversion");
    expect(result.meta.engine).toBe("zone");
    expect(result.meta.version).toBe("2.0");
  });

  it("meta is stamped correctly for canConvert: false", () => {
    const result = buildConversionStageResult(failure("MULTI_OPERATION_NOT_SUPPORTED"));

    expect(result.meta.stage).toBe("generated_patch_conversion");
    expect(result.meta.engine).toBe("zone");
    expect(result.meta.version).toBe("2.0");
  });
});
