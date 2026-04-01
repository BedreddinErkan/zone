import { describe, expect, it } from "vitest";
import { calculateConfidenceScore } from "./calculateConfidenceScore";

describe("calculateConfidenceScore", () => {
  it("hic penalty yoksa score 1 olmali", () => {
    const result = calculateConfidenceScore({});

    expect(result.score).toBe(1);
    expect(result.reasons).toEqual([]);
  });

  it("tek bir penalty dogru dususu uygulamali", () => {
    const result = calculateConfidenceScore({
      missingTargetFile: true
    });

    expect(result.score).toBe(0.75);
    expect(result.reasons).toContain("missing_target_file");
  });

  it("birden fazla penalty kume halinde uygulanmali", () => {
    const result = calculateConfidenceScore({
      missingTargetFile: true,
      weakPatchAnchors: true,
      schemaMismatch: true
    });

    expect(result.score).toBe(0.4);
    expect(result.reasons).toEqual([
      "missing_target_file",
      "weak_patch_anchors",
      "schema_mismatch"
    ]);
  });

  it("score 0 altina dusmemeli", () => {
    const result = calculateConfidenceScore({
      missingTargetFile: true,
      weakFileRanking: true,
      weakPatchAnchors: true,
      schemaMismatch: true,
      architectureMismatch: true,
      unsafeCreateOperation: true
    });

    expect(result.score).toBe(0);
  });
});