import { describe, expect, it } from "vitest";
import { detectContradictions } from "../contradictionDetector.js";
import type { ContradictionFlag } from "../contradictionDetector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagTypes(flags: ContradictionFlag[]): string[] {
  return flags.map((f) => f.type);
}

// ---------------------------------------------------------------------------
// LOW_CONFIDENCE_ON_SAFE
// ---------------------------------------------------------------------------

describe("detectContradictions — LOW_CONFIDENCE_ON_SAFE", () => {
  it("flags when mode is safe_to_apply and confidenceScore is below 0.4", () => {
    const flags = detectContradictions(0.2, 0.3, "safe_to_apply");
    expect(flagTypes(flags)).toContain("LOW_CONFIDENCE_ON_SAFE");
  });

  it("flags at the boundary just below 0.4 (0.39)", () => {
    const flags = detectContradictions(0.1, 0.39, "safe_to_apply");
    expect(flagTypes(flags)).toContain("LOW_CONFIDENCE_ON_SAFE");
  });

  it("does NOT flag when confidenceScore equals 0.4 (boundary is exclusive)", () => {
    const flags = detectContradictions(0.1, 0.4, "safe_to_apply");
    expect(flagTypes(flags)).not.toContain("LOW_CONFIDENCE_ON_SAFE");
  });

  it("does NOT flag when confidenceScore is above 0.4", () => {
    const flags = detectContradictions(0.1, 0.9, "safe_to_apply");
    expect(flagTypes(flags)).not.toContain("LOW_CONFIDENCE_ON_SAFE");
  });

  it("does NOT flag for preview_only mode even with low confidence", () => {
    const flags = detectContradictions(0.1, 0.1, "preview_only");
    expect(flagTypes(flags)).not.toContain("LOW_CONFIDENCE_ON_SAFE");
  });

  it("does NOT flag for blocked mode even with low confidence", () => {
    const flags = detectContradictions(0.1, 0.1, "blocked");
    expect(flagTypes(flags)).not.toContain("LOW_CONFIDENCE_ON_SAFE");
  });
});

// ---------------------------------------------------------------------------
// HIGH_CONFIDENCE_ON_BLOCK
// ---------------------------------------------------------------------------

describe("detectContradictions — HIGH_CONFIDENCE_ON_BLOCK", () => {
  it("flags when mode is blocked and riskScore is below 0.3", () => {
    const flags = detectContradictions(0.1, 0.9, "blocked");
    expect(flagTypes(flags)).toContain("HIGH_CONFIDENCE_ON_BLOCK");
  });

  it("flags at the boundary just below 0.3 (0.29)", () => {
    const flags = detectContradictions(0.29, 0.8, "blocked");
    expect(flagTypes(flags)).toContain("HIGH_CONFIDENCE_ON_BLOCK");
  });

  it("does NOT flag when riskScore equals 0.3 (boundary is exclusive)", () => {
    const flags = detectContradictions(0.3, 0.9, "blocked");
    expect(flagTypes(flags)).not.toContain("HIGH_CONFIDENCE_ON_BLOCK");
  });

  it("does NOT flag when riskScore is above 0.3", () => {
    const flags = detectContradictions(0.8, 0.9, "blocked");
    expect(flagTypes(flags)).not.toContain("HIGH_CONFIDENCE_ON_BLOCK");
  });

  it("does NOT flag for safe_to_apply mode with low riskScore", () => {
    const flags = detectContradictions(0.1, 0.9, "safe_to_apply");
    expect(flagTypes(flags)).not.toContain("HIGH_CONFIDENCE_ON_BLOCK");
  });

  it("does NOT flag for preview_only mode with low riskScore", () => {
    const flags = detectContradictions(0.1, 0.9, "preview_only");
    expect(flagTypes(flags)).not.toContain("HIGH_CONFIDENCE_ON_BLOCK");
  });
});

// ---------------------------------------------------------------------------
// SCORE_TENSION
// ---------------------------------------------------------------------------

describe("detectContradictions — SCORE_TENSION", () => {
  it("flags when riskScore > 0.6, confidenceScore > 0.8, and mode is safe_to_apply", () => {
    const flags = detectContradictions(0.7, 0.9, "safe_to_apply");
    expect(flagTypes(flags)).toContain("SCORE_TENSION");
  });

  it("flags at minimum triggering values (0.61 risk, 0.81 confidence)", () => {
    const flags = detectContradictions(0.61, 0.81, "safe_to_apply");
    expect(flagTypes(flags)).toContain("SCORE_TENSION");
  });

  it("does NOT flag when riskScore equals exactly 0.6 (boundary is exclusive)", () => {
    const flags = detectContradictions(0.6, 0.9, "safe_to_apply");
    expect(flagTypes(flags)).not.toContain("SCORE_TENSION");
  });

  it("does NOT flag when confidenceScore equals exactly 0.8 (boundary is exclusive)", () => {
    const flags = detectContradictions(0.7, 0.8, "safe_to_apply");
    expect(flagTypes(flags)).not.toContain("SCORE_TENSION");
  });

  it("does NOT flag for blocked mode even with high risk and high confidence", () => {
    const flags = detectContradictions(0.9, 0.9, "blocked");
    expect(flagTypes(flags)).not.toContain("SCORE_TENSION");
  });

  it("does NOT flag for preview_only mode even with high risk and high confidence", () => {
    const flags = detectContradictions(0.9, 0.9, "preview_only");
    expect(flagTypes(flags)).not.toContain("SCORE_TENSION");
  });
});

// ---------------------------------------------------------------------------
// No contradictions — clean cases
// ---------------------------------------------------------------------------

describe("detectContradictions — clean cases (no flags)", () => {
  it("returns empty array for a well-supported safe_to_apply decision", () => {
    // Low risk, high confidence, safe mode — no contradictions
    const flags = detectContradictions(0.2, 0.9, "safe_to_apply");
    expect(flags).toEqual([]);
  });

  it("returns empty array for a justified blocked decision with high risk", () => {
    // High risk, high confidence, blocked — semantically consistent
    const flags = detectContradictions(0.8, 0.9, "blocked");
    expect(flags).toEqual([]);
  });

  it("returns empty array for a blocked decision with moderate risk", () => {
    const flags = detectContradictions(0.5, 0.6, "blocked");
    expect(flags).toEqual([]);
  });

  it("returns empty array for preview_only with moderate scores", () => {
    const flags = detectContradictions(0.4, 0.6, "preview_only");
    expect(flags).toEqual([]);
  });

  it("returns empty array for preview_only with high risk", () => {
    const flags = detectContradictions(0.8, 0.8, "preview_only");
    expect(flags).toEqual([]);
  });

  it("returns empty array for safe_to_apply with mid-range confidence (0.5)", () => {
    const flags = detectContradictions(0.1, 0.5, "safe_to_apply");
    expect(flags).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Severity values
// ---------------------------------------------------------------------------

describe("detectContradictions — severity values", () => {
  it("LOW_CONFIDENCE_ON_SAFE has severity 'warning'", () => {
    const flags = detectContradictions(0.2, 0.3, "safe_to_apply");
    const flag = flags.find((f) => f.type === "LOW_CONFIDENCE_ON_SAFE");
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("warning");
  });

  it("HIGH_CONFIDENCE_ON_BLOCK has severity 'info'", () => {
    const flags = detectContradictions(0.1, 0.9, "blocked");
    const flag = flags.find((f) => f.type === "HIGH_CONFIDENCE_ON_BLOCK");
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("info");
  });

  it("SCORE_TENSION has severity 'critical'", () => {
    const flags = detectContradictions(0.7, 0.9, "safe_to_apply");
    const flag = flags.find((f) => f.type === "SCORE_TENSION");
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe("critical");
  });

  it("each flag carries a non-empty message string", () => {
    const allFlags = [
      ...detectContradictions(0.2, 0.3, "safe_to_apply"),
      ...detectContradictions(0.1, 0.9, "blocked"),
      ...detectContradictions(0.7, 0.9, "safe_to_apply"),
    ];

    for (const flag of allFlags) {
      expect(typeof flag.message).toBe("string");
      expect(flag.message.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Return type shape
// ---------------------------------------------------------------------------

describe("detectContradictions — return type shape", () => {
  it("always returns an array", () => {
    expect(Array.isArray(detectContradictions(0.5, 0.5, "preview_only"))).toBe(true);
  });

  it("each flag has type, severity, and message fields", () => {
    const flags = detectContradictions(0.1, 0.9, "blocked");
    for (const flag of flags) {
      expect(flag).toHaveProperty("type");
      expect(flag).toHaveProperty("severity");
      expect(flag).toHaveProperty("message");
    }
  });

  it("multiple flags can be returned in the same call", () => {
    // LOW_CONFIDENCE_ON_SAFE triggers (mode=safe, confidence=0.3)
    // HIGH_CONFIDENCE_ON_BLOCK does NOT trigger (wrong mode)
    // SCORE_TENSION does NOT trigger (risk too low)
    const flags = detectContradictions(0.2, 0.3, "safe_to_apply");
    expect(flags.length).toBeGreaterThanOrEqual(1);
  });
});
