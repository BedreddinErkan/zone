import { describe, expect, it } from "vitest";
import { decideExecutionMode } from "../runFeatureAgent";
import type { ConfidenceBreakdown, ValidationIssue, ValidatedSuggestedFile } from "../../types/agent";

function makeConfidence(finalScore: number): ConfidenceBreakdown {
  return {
    intentClarity: 80,
    schemaCertainty: 80,
    storageCertainty: 80,
    patchValidationHealth: 80,
    finalScore
  };
}

function makeIssue(severity: "info" | "warning" | "error"): ValidationIssue {
  return {
    code: `TEST_${severity.toUpperCase()}`,
    message: `test ${severity}`,
    severity
  };
}

function makeValidatedFile(status: "verified" | "corrected" | "missing"): ValidatedSuggestedFile {
  return {
    originalPath: "src/example.ts",
    resolvedPath: status === "missing" ? null : "src/example.ts",
    action: "modify",
    reason: "test",
    status
  };
}

describe("decideExecutionMode", () => {
  it("patch validation error varsa blocked donmeli", () => {
    const result = decideExecutionMode({
      confidence: makeConfidence(95),
      patchValidationIssues: [makeIssue("error")],
      schemaPatchWarnings: [],
      patchRiskWarnings: [],
      architectureWarnings: [],
      validatedSuggestedFiles: [makeValidatedFile("verified")],
      schemaConfidence: "high",
      storageConfidence: "high"
    });

    expect(result.mode).toBe("blocked");
    expect(result.confidenceScore).toBe(95);
    expect(result.reason).toBe("Blocking validation errors were detected.");
  });

  it("schema validation error varsa blocked donmeli", () => {
    const result = decideExecutionMode({
      confidence: makeConfidence(92),
      patchValidationIssues: [],
      schemaPatchWarnings: [makeIssue("error")],
      patchRiskWarnings: [],
      architectureWarnings: [],
      validatedSuggestedFiles: [makeValidatedFile("verified")],
      schemaConfidence: "high",
      storageConfidence: "high"
    });

    expect(result.mode).toBe("blocked");
    expect(result.confidenceScore).toBe(92);
    expect(result.reason).toBe("Blocking validation errors were detected.");
  });

  it("missing validated file varsa preview_only donmeli", () => {
    const result = decideExecutionMode({
      confidence: makeConfidence(96),
      patchValidationIssues: [],
      schemaPatchWarnings: [],
      patchRiskWarnings: [],
      architectureWarnings: [],
      validatedSuggestedFiles: [makeValidatedFile("missing")],
      schemaConfidence: "high",
      storageConfidence: "high"
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reason).toBe("Some suggested files could not be validated confidently.");
  });

  it("schema confidence low ise preview_only donmeli", () => {
    const result = decideExecutionMode({
      confidence: makeConfidence(96),
      patchValidationIssues: [],
      schemaPatchWarnings: [],
      patchRiskWarnings: [],
      architectureWarnings: [],
      validatedSuggestedFiles: [makeValidatedFile("verified")],
      schemaConfidence: "low",
      storageConfidence: "high"
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reason).toBe("Schema or storage certainty is too low for automatic apply.");
  });

  it("storage confidence low ise preview_only donmeli", () => {
    const result = decideExecutionMode({
      confidence: makeConfidence(96),
      patchValidationIssues: [],
      schemaPatchWarnings: [],
      patchRiskWarnings: [],
      architectureWarnings: [],
      validatedSuggestedFiles: [makeValidatedFile("verified")],
      schemaConfidence: "high",
      storageConfidence: "low"
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reason).toBe("Schema or storage certainty is too low for automatic apply.");
  });

  it("patch risk warning varsa preview_only donmeli", () => {
    const result = decideExecutionMode({
      confidence: makeConfidence(96),
      patchValidationIssues: [],
      schemaPatchWarnings: [],
      patchRiskWarnings: ["unsafe write"],
      architectureWarnings: [],
      validatedSuggestedFiles: [makeValidatedFile("verified")],
      schemaConfidence: "high",
      storageConfidence: "high"
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reason).toBe("Risk or architecture warnings require manual review.");
  });

  it("architecture warning varsa preview_only donmeli", () => {
    const result = decideExecutionMode({
      confidence: makeConfidence(96),
      patchValidationIssues: [],
      schemaPatchWarnings: [],
      patchRiskWarnings: [],
      architectureWarnings: ["layer mismatch"],
      validatedSuggestedFiles: [makeValidatedFile("verified")],
      schemaConfidence: "high",
      storageConfidence: "high"
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reason).toBe("Risk or architecture warnings require manual review.");
  });

  it("non-blocking warning varsa preview_only donmeli", () => {
    const result = decideExecutionMode({
      confidence: makeConfidence(96),
      patchValidationIssues: [makeIssue("warning")],
      schemaPatchWarnings: [],
      patchRiskWarnings: [],
      architectureWarnings: [],
      validatedSuggestedFiles: [makeValidatedFile("verified")],
      schemaConfidence: "high",
      storageConfidence: "high"
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reason).toBe("Non-blocking warnings detected. Manual review is required.");
  });

  it("temiz ve yuksek confidence varsa safe_to_apply donmeli", () => {
    const result = decideExecutionMode({
      confidence: makeConfidence(100),
      patchValidationIssues: [],
      schemaPatchWarnings: [],
      patchRiskWarnings: [],
      architectureWarnings: [],
      validatedSuggestedFiles: [makeValidatedFile("verified")],
      schemaConfidence: "high",
      storageConfidence: "high"
    });

    expect(result.mode).toBe("safe_to_apply");
    expect(result.confidenceScore).toBe(100);
    expect(result.reason).toBe("Validation passed cleanly with high confidence.");
  });
});