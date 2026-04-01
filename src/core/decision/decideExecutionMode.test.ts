import { describe, expect, it } from "vitest";
import { decideExecutionMode } from "./decideExecutionMode.js";

describe("decideExecutionMode", () => {
  it("returns blocked when patch validation errors exist", () => {
    const result = decideExecutionMode({
      schemaConfidence: 90,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [
        {
          level: "error",
          code: "PATH_OUTSIDE_REPO",
          message: "Patch target resolves outside the repository root.",
          filePath: "../secret.txt",
        },
      ],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    expect(result.mode).toBe("blocked");
    expect(result.confidenceScore).toBe(0);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PATCH_VALIDATION_ERROR",
          severity: "critical",
        }),
      ])
    );
  });

  it("returns blocked when schema validation errors exist", () => {
    const result = decideExecutionMode({
      schemaConfidence: 90,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [
        {
          level: "error",
          code: "SCHEMA_FIELD_MISMATCH",
          message: "Schema mismatch detected.",
          filePath: "src/test.ts",
        },
      ],
      hasValidatedFiles: true,
    });

    expect(result.mode).toBe("blocked");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SCHEMA_VALIDATION_ERROR",
          severity: "critical",
        }),
      ])
    );
  });

  it("returns preview_only when patch validation warnings exist", () => {
    const result = decideExecutionMode({
      schemaConfidence: 90,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [
        {
          level: "warning",
          code: "TARGETS_NODE_MODULES",
          message: "Patch targets node_modules.",
          filePath: "node_modules/pkg/index.js",
        },
      ],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PATCH_VALIDATION_WARNING",
          severity: "warning",
        }),
      ])
    );
  });

  it("returns preview_only when schema validation warnings exist", () => {
    const result = decideExecutionMode({
      schemaConfidence: 90,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [
        {
          level: "warning",
          code: "SCHEMA_SNAPSHOT_MISSING",
          message: "No schema snapshot loaded.",
        },
      ],
      hasValidatedFiles: true,
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SCHEMA_VALIDATION_WARNING",
          severity: "warning",
        }),
      ])
    );
  });

  it("returns preview_only when validated files are missing", () => {
    const result = decideExecutionMode({
      schemaConfidence: 90,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: false,
    });

    expect(result.mode).toBe("preview_only");
    expect(result.confidenceScore).toBe(80);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MISSING_VALIDATED_FILES",
        }),
      ])
    );
  });

  it("returns preview_only when schema confidence is low", () => {
    const result = decideExecutionMode({
      schemaConfidence: 55,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LOW_SCHEMA_CONFIDENCE",
        }),
      ])
    );
  });

  it("returns preview_only when storage confidence is low", () => {
    const result = decideExecutionMode({
      schemaConfidence: 90,
      storageConfidence: 50,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LOW_STORAGE_CONFIDENCE",
        }),
      ])
    );
  });

  it("returns preview_only when patch risk warnings exist", () => {
    const result = decideExecutionMode({
      schemaConfidence: 90,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: ["wide replacement detected"],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PATCH_RISK_WARNING",
        }),
      ])
    );
  });

  it("returns preview_only when architecture warnings exist", () => {
    const result = decideExecutionMode({
      schemaConfidence: 90,
      storageConfidence: 90,
      architectureWarnings: ["controller and service pattern mismatch"],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    expect(result.mode).toBe("preview_only");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ARCHITECTURE_WARNING",
        }),
      ])
    );
  });

  it("returns safe_to_apply when no risks are detected", () => {
    const result = decideExecutionMode({
      schemaConfidence: 92,
      storageConfidence: 90,
      architectureWarnings: [],
      patchRiskWarnings: [],
      patchValidationIssues: [],
      schemaValidationIssues: [],
      hasValidatedFiles: true,
    });

    expect(result.mode).toBe("safe_to_apply");
    expect(result.confidenceScore).toBe(100);
    expect(result.reasons).toEqual([
      expect.objectContaining({
        code: "SAFE_TO_APPLY",
        severity: "info",
      }),
    ]);
  });

  it("keeps blocked precedence over preview_only signals", () => {
    const result = decideExecutionMode({
      schemaConfidence: 35,
      storageConfidence: 40,
      architectureWarnings: ["pattern mismatch"],
      patchRiskWarnings: ["wide patch"],
      patchValidationIssues: [
        {
          level: "error",
          code: "TARGETS_PROTECTED_FILE",
          message: "Patch targets a protected file.",
          filePath: ".env",
        },
      ],
      schemaValidationIssues: [],
      hasValidatedFiles: false,
    });

    expect(result.mode).toBe("blocked");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PATCH_VALIDATION_ERROR",
        }),
      ])
    );
  });
});