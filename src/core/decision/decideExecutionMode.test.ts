import { describe, expect, it } from "vitest";
import { decideExecutionMode } from "./decideExecutionMode";

describe("decideExecutionMode", () => {
  it("confidence cok dusukse blocked donmeli", () => {
    const result = decideExecutionMode({
      confidenceScore: 0.2,
      hasPatchValidationErrors: false,
      hasHighRiskIssues: false
    });

    expect(result).toBe("blocked");
  });

  it("confidence orta seviyedeyse preview_only donmeli", () => {
    const result = decideExecutionMode({
      confidenceScore: 0.61,
      hasPatchValidationErrors: false,
      hasHighRiskIssues: false
    });

    expect(result).toBe("preview_only");
  });

  it("confidence yuksek ve risk yoksa safe_to_apply donmeli", () => {
    const result = decideExecutionMode({
      confidenceScore: 0.92,
      hasPatchValidationErrors: false,
      hasHighRiskIssues: false
    });

    expect(result).toBe("safe_to_apply");
  });

  it("validation hatasi varsa confidence yuksek olsa bile blocked donmeli", () => {
    const result = decideExecutionMode({
      confidenceScore: 0.95,
      hasPatchValidationErrors: true,
      hasHighRiskIssues: false
    });

    expect(result).toBe("blocked");
  });

  it("high risk issue varsa blocked donmeli", () => {
    const result = decideExecutionMode({
      confidenceScore: 0.95,
      hasPatchValidationErrors: false,
      hasHighRiskIssues: true
    });

    expect(result).toBe("blocked");
  });
});