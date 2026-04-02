import { describe, expect, it } from "vitest";
import { buildRecommendation } from "./buildRecommendation.js";

describe("buildRecommendation", () => {
  it("returns default blocked recommendation when blocking validation exists", () => {
    const output = buildRecommendation({
      mode: "blocked",
      confidenceScore: 0,
      reasons: [
        {
          code: "PATCH_VALIDATION_ERROR",
          severity: "critical",
          message: "Patch validation failed."
        }
      ]
    });

    expect(output).toBe(
      "Do not apply automatically. Fix blocking validation issues first."
    );
  });

  it("returns schema-focused blocked recommendation when schema issues exist", () => {
    const output = buildRecommendation({
      mode: "blocked",
      confidenceScore: 0,
      reasons: [
        {
          code: "SCHEMA_VALIDATION_ERROR",
          severity: "critical",
          message: "Schema validation failed."
        }
      ]
    });

    expect(output).toBe(
      "Do not apply automatically. Resolve schema issues and verify schema alignment first."
    );
  });

  it("returns high-risk preview recommendation when high top risk exists", () => {
    const output = buildRecommendation({
      mode: "preview_only",
      confidenceScore: 62,
      reasons: [
        {
          code: "PATCH_RISK_WARNING",
          severity: "warning",
          message: "Patch risk warning."
        }
      ],
      topRisks: [
        {
          id: "risk-1",
          title: "Dangerous target",
          description: "High risk target.",
          severity: "high",
          score: 92,
          category: "patch",
          source: "warning"
        }
      ]
    });

    expect(output).toBe(
      "Preview the patch and complete manual review before any apply step because high-severity risks are still present."
    );
  });

  it("returns schema-focused preview recommendation when schema signals exist", () => {
    const output = buildRecommendation({
      mode: "preview_only",
      confidenceScore: 70,
      reasons: [
        {
          code: "LOW_SCHEMA_CONFIDENCE",
          severity: "warning",
          message: "Schema confidence is limited."
        }
      ]
    });

    expect(output).toBe(
      "Preview the patch and verify schema alignment before any apply step."
    );
  });

  it("returns patch-focused preview recommendation when patch warnings exist", () => {
    const output = buildRecommendation({
      mode: "preview_only",
      confidenceScore: 70,
      reasons: [
        {
          code: "PATCH_VALIDATION_WARNING",
          severity: "warning",
          message: "Patch should be reviewed."
        }
      ]
    });

    expect(output).toBe(
      "Preview the patch and review patch scope before any apply step."
    );
  });

  it("returns safe recommendation for safe_to_apply mode", () => {
    const output = buildRecommendation({
      mode: "safe_to_apply",
      confidenceScore: 92,
      reasons: [
        {
          code: "SAFE_TO_APPLY",
          severity: "info",
          message: "No blocking execution risks were detected."
        }
      ]
    });

    expect(output).toBe(
      "Patch can be applied automatically under current safeguards."
    );
  });
});