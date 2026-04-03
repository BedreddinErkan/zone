import { describe, expect, it } from "vitest";
import {
  normalizePatchValidationIssues,
  normalizeSchemaValidationIssues,
  normalizePatchRiskWarnings,
  normalizeArchitectureWarnings
} from "./normalizeIssues.js";

describe("normalizePatchValidationIssues", () => {
  it("error level → PATCH_VALIDATION_ERROR, source patch, severity error", () => {
    const result = normalizePatchValidationIssues([
      { level: "error", message: "Path traversal detected", filePath: "src/routes/user.ts" }
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: "PATCH_VALIDATION_ERROR",
      severity: "error",
      source: "patch",
      message: "Path traversal detected",
      file: "src/routes/user.ts"
    });
  });

  it("warning level → PATCH_VALIDATION_WARNING, source patch", () => {
    const result = normalizePatchValidationIssues([
      { level: "warning", message: "Targets node_modules" }
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: "PATCH_VALIDATION_WARNING",
      severity: "warning",
      source: "patch"
    });
  });

  it("filePath → file field'a taşınıyor, eksik filePath → file undefined", () => {
    const result = normalizePatchValidationIssues([
      { level: "error", message: "With path", filePath: "src/index.ts" },
      { level: "warning", message: "Without path" }
    ]);

    expect(result[0]?.file).toBe("src/index.ts");
    expect(result[1]?.file).toBeUndefined();
  });

  it("boş array input → boş array output", () => {
    expect(normalizePatchValidationIssues([])).toEqual([]);
  });

  it("çoklu issue'ları doğru sırayla normalize eder", () => {
    const result = normalizePatchValidationIssues([
      { level: "error", message: "First" },
      { level: "warning", message: "Second" },
      { level: "error", message: "Third" }
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]?.code).toBe("PATCH_VALIDATION_ERROR");
    expect(result[1]?.code).toBe("PATCH_VALIDATION_WARNING");
    expect(result[2]?.code).toBe("PATCH_VALIDATION_ERROR");
  });
});

describe("normalizeSchemaValidationIssues", () => {
  it("error level → SCHEMA_VALIDATION_ERROR, source schema", () => {
    const result = normalizeSchemaValidationIssues([
      { level: "error", message: "Field type mismatch", filePath: "schema.json" }
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: "SCHEMA_VALIDATION_ERROR",
      severity: "error",
      source: "schema",
      message: "Field type mismatch",
      file: "schema.json"
    });
  });

  it("warning level → SCHEMA_VALIDATION_WARNING, source schema", () => {
    const result = normalizeSchemaValidationIssues([
      { level: "warning", message: "Schema snapshot missing" }
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      code: "SCHEMA_VALIDATION_WARNING",
      severity: "warning",
      source: "schema"
    });
  });

  it("boş array → boş array", () => {
    expect(normalizeSchemaValidationIssues([])).toEqual([]);
  });
});

describe("normalizePatchRiskWarnings", () => {
  it("string[] → ValidationIssue[], code PATCH_RISK_WARNING, source patch, severity warning", () => {
    const result = normalizePatchRiskWarnings([
      "Possible tenant scope issue",
      "Wide replacement detected"
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      code: "PATCH_RISK_WARNING",
      severity: "warning",
      source: "patch",
      message: "Possible tenant scope issue"
    });
    expect(result[1]).toMatchObject({
      code: "PATCH_RISK_WARNING",
      severity: "warning",
      source: "patch",
      message: "Wide replacement detected"
    });
  });

  it("boş array → boş array", () => {
    expect(normalizePatchRiskWarnings([])).toEqual([]);
  });

  it("her uyarı için file field tanımsız kalır", () => {
    const result = normalizePatchRiskWarnings(["some warning"]);
    expect(result[0]?.file).toBeUndefined();
  });
});

describe("normalizeArchitectureWarnings", () => {
  it("string[] → ValidationIssue[], code ARCHITECTURE_WARNING, source architecture, severity warning", () => {
    const result = normalizeArchitectureWarnings([
      "Controller pattern mismatch",
      "Circular dependency detected"
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      code: "ARCHITECTURE_WARNING",
      severity: "warning",
      source: "architecture",
      message: "Controller pattern mismatch"
    });
    expect(result[1]).toMatchObject({
      code: "ARCHITECTURE_WARNING",
      severity: "warning",
      source: "architecture",
      message: "Circular dependency detected"
    });
  });

  it("boş array → boş array", () => {
    expect(normalizeArchitectureWarnings([])).toEqual([]);
  });

  it("normalize edilen issue'larda source 'architecture', patch değil", () => {
    const result = normalizeArchitectureWarnings(["arch warning"]);
    expect(result[0]?.source).toBe("architecture");
    expect(result[0]?.source).not.toBe("patch");
  });
});
