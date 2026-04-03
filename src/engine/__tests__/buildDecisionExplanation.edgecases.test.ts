import { describe, expect, it } from "vitest";
import {
  buildDecisionExplanation,
  type DecisionExplanation,
  type ResolvedReason,
} from "../buildDecisionExplanation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the codes present in the resolved reasons array. */
function resolvedCodes(explanation: DecisionExplanation): string[] {
  return explanation.reasons.map((r) => r.code);
}

/** Asserts that every field in every ResolvedReason is a non-empty string. */
function assertCompleteShape(explanation: DecisionExplanation): void {
  expect(typeof explanation.why).toBe("string");
  expect(explanation.why.length).toBeGreaterThan(0);
  expect(Array.isArray(explanation.reasons)).toBe(true);

  for (const reason of explanation.reasons) {
    expect(typeof reason.code).toBe("string");
    expect(reason.code.length).toBeGreaterThan(0);
    expect(typeof reason.severity).toBe("string");
    expect(reason.severity.length).toBeGreaterThan(0);
    expect(typeof reason.category).toBe("string");
    expect(reason.category.length).toBeGreaterThan(0);
    expect(typeof reason.summary).toBe("string");
    expect(reason.summary.length).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// Empty reasonCodes
// ---------------------------------------------------------------------------

describe("buildDecisionExplanation — empty reasonCodes", () => {
  it("returns fallback why when reasonCodes is an empty array", () => {
    const result = buildDecisionExplanation({ reasonCodes: [] });
    expect(result.why).toBe("No reason codes provided");
  });

  it("returns empty reasons array when reasonCodes is []", () => {
    const result = buildDecisionExplanation({ reasonCodes: [] });
    expect(result.reasons).toEqual([]);
  });

  it("does NOT throw when reasonCodes is an empty array", () => {
    expect(() => buildDecisionExplanation({ reasonCodes: [] })).not.toThrow();
  });

  it("output shape is complete with empty codes", () => {
    assertCompleteShape(buildDecisionExplanation({ reasonCodes: [] }));
  });
});

// ---------------------------------------------------------------------------
// null and undefined reasonCodes
// ---------------------------------------------------------------------------

describe("buildDecisionExplanation — null / undefined reasonCodes", () => {
  it("treats null reasonCodes as empty — returns fallback why", () => {
    const result = buildDecisionExplanation({ reasonCodes: null });
    expect(result.why).toBe("No reason codes provided");
  });

  it("treats null reasonCodes as empty — returns empty reasons array", () => {
    const result = buildDecisionExplanation({ reasonCodes: null });
    expect(result.reasons).toEqual([]);
  });

  it("does NOT throw when reasonCodes is null", () => {
    expect(() => buildDecisionExplanation({ reasonCodes: null })).not.toThrow();
  });

  it("treats undefined reasonCodes as empty — returns fallback why", () => {
    const result = buildDecisionExplanation({ reasonCodes: undefined });
    expect(result.why).toBe("No reason codes provided");
  });

  it("treats undefined reasonCodes as empty — returns empty reasons array", () => {
    const result = buildDecisionExplanation({ reasonCodes: undefined });
    expect(result.reasons).toEqual([]);
  });

  it("does NOT throw when reasonCodes is undefined", () => {
    expect(() =>
      buildDecisionExplanation({ reasonCodes: undefined })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Single unknown code
// ---------------------------------------------------------------------------

describe("buildDecisionExplanation — single unknown code", () => {
  it("returns empty reasons when the sole code is unknown", () => {
    const result = buildDecisionExplanation({
      reasonCodes: ["TOTALLY_UNKNOWN_CODE_XYZ"],
    });
    expect(result.reasons).toEqual([]);
  });

  it("returns fallback why when the sole code is unknown", () => {
    const result = buildDecisionExplanation({
      reasonCodes: ["TOTALLY_UNKNOWN_CODE_XYZ"],
    });
    expect(result.why).toBe("No valid reason codes resolved");
  });

  it("does NOT throw on a single unknown code", () => {
    expect(() =>
      buildDecisionExplanation({ reasonCodes: ["DOES_NOT_EXIST"] })
    ).not.toThrow();
  });

  it("output shape is complete with a single unknown code", () => {
    assertCompleteShape(
      buildDecisionExplanation({ reasonCodes: ["UNKNOWN_42"] })
    );
  });
});

// ---------------------------------------------------------------------------
// All codes unknown (every code skipped)
// ---------------------------------------------------------------------------

describe("buildDecisionExplanation — all codes unknown", () => {
  it("returns fallback why when every code is unknown", () => {
    const result = buildDecisionExplanation({
      reasonCodes: ["UNKNOWN_A", "UNKNOWN_B", "UNKNOWN_C"],
    });
    expect(result.why).toBe("No valid reason codes resolved");
  });

  it("returns empty reasons array when every code is unknown", () => {
    const result = buildDecisionExplanation({
      reasonCodes: ["UNKNOWN_A", "UNKNOWN_B"],
    });
    expect(result.reasons).toEqual([]);
  });

  it("does NOT throw when all codes are unknown", () => {
    expect(() =>
      buildDecisionExplanation({ reasonCodes: ["GHOST_CODE", "PHANTOM_CODE"] })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mix of valid + unknown codes
// ---------------------------------------------------------------------------

describe("buildDecisionExplanation — mix of valid and unknown codes", () => {
  it("includes only valid codes in the reasons array", () => {
    const result = buildDecisionExplanation({
      reasonCodes: ["BLOCKED_HIGH_RISK_SCORE", "UNKNOWN_CODE_XYZ"],
    });
    expect(resolvedCodes(result)).toContain("BLOCKED_HIGH_RISK_SCORE");
    expect(resolvedCodes(result)).not.toContain("UNKNOWN_CODE_XYZ");
  });

  it("reasons length equals only the count of valid codes", () => {
    const result = buildDecisionExplanation({
      reasonCodes: [
        "SAFE_HIGH_CONFIDENCE",
        "MYSTERY_CODE_1",
        "MYSTERY_CODE_2",
      ],
    });
    expect(result.reasons).toHaveLength(1);
  });

  it("does NOT throw when mixing valid and unknown codes", () => {
    expect(() =>
      buildDecisionExplanation({
        reasonCodes: ["BLOCKED_SCHEMA_RISK", "DOES_NOT_EXIST"],
      })
    ).not.toThrow();
  });

  it("why string reflects only the valid codes that were resolved", () => {
    const result = buildDecisionExplanation({
      reasonCodes: ["PREVIEW_LOW_CONFIDENCE", "FAKE_CODE"],
    });
    expect(result.why).toContain("PREVIEW_LOW_CONFIDENCE");
    expect(result.why).not.toContain("FAKE_CODE");
  });

  it("output shape is complete for mixed-code input", () => {
    assertCompleteShape(
      buildDecisionExplanation({
        reasonCodes: ["BLOCKED_DESTRUCTIVE_OPERATION", "GHOST_CODE"],
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Missing severity in metadata → defaults to "info"
// ---------------------------------------------------------------------------

describe("buildDecisionExplanation — missing severity fallback", () => {
  it("defaults severity to 'info' when metadata severity is undefined", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: {
          MY_CODE: { category: "risk", summary: "Something happened." },
          // severity intentionally omitted
        },
      }
    );
    expect(result.reasons[0]?.severity).toBe("info");
  });

  it("defaults severity to 'info' when metadata severity is null", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: {
          MY_CODE: { severity: null, category: "risk", summary: "Test." },
        },
      }
    );
    expect(result.reasons[0]?.severity).toBe("info");
  });

  it("defaults severity to 'info' when metadata severity is an empty string", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: {
          MY_CODE: { severity: "", category: "risk", summary: "Test." },
        },
      }
    );
    expect(result.reasons[0]?.severity).toBe("info");
  });

  it("maps 'high' severity to 'critical'", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "high", category: "risk", summary: "High risk." } },
      }
    );
    expect(result.reasons[0]?.severity).toBe("critical");
  });

  it("maps 'medium' severity to 'warning'", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "medium", category: "scope", summary: "Medium." } },
      }
    );
    expect(result.reasons[0]?.severity).toBe("warning");
  });

  it("maps 'low' severity to 'info'", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "low", category: "safety", summary: "Low risk." } },
      }
    );
    expect(result.reasons[0]?.severity).toBe("info");
  });

  it("defaults unrecognised severity string to 'info'", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "extreme", category: "risk", summary: "Unknown sev." } },
      }
    );
    expect(result.reasons[0]?.severity).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// Missing category in metadata → defaults to "general"
// ---------------------------------------------------------------------------

describe("buildDecisionExplanation — missing category fallback", () => {
  it("defaults category to 'general' when metadata category is undefined", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "high", summary: "No category." } },
      }
    );
    expect(result.reasons[0]?.category).toBe("general");
  });

  it("defaults category to 'general' when metadata category is null", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "medium", category: null, summary: "Null cat." } },
      }
    );
    expect(result.reasons[0]?.category).toBe("general");
  });

  it("defaults category to 'general' when metadata category is an empty string", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "low", category: "", summary: "Empty cat." } },
      }
    );
    expect(result.reasons[0]?.category).toBe("general");
  });

  it("uses the provided category when it is a non-empty string", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "high", category: "security", summary: "Security." } },
      }
    );
    expect(result.reasons[0]?.category).toBe("security");
  });
});

// ---------------------------------------------------------------------------
// Missing summary in metadata → defaults to "No summary available"
// ---------------------------------------------------------------------------

describe("buildDecisionExplanation — missing summary fallback", () => {
  it("defaults summary to 'No summary available' when metadata summary is undefined", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "high", category: "risk" } },
      }
    );
    expect(result.reasons[0]?.summary).toBe("No summary available");
  });

  it("defaults summary to 'No summary available' when metadata summary is null", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "low", category: "scope", summary: null } },
      }
    );
    expect(result.reasons[0]?.summary).toBe("No summary available");
  });

  it("defaults summary to 'No summary available' when metadata summary is empty string", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "medium", category: "confidence", summary: "" } },
      }
    );
    expect(result.reasons[0]?.summary).toBe("No summary available");
  });

  it("uses the provided summary when it is a non-empty string", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["MY_CODE"] },
      {
        metadata: { MY_CODE: { severity: "high", category: "risk", summary: "A real summary." } },
      }
    );
    expect(result.reasons[0]?.summary).toBe("A real summary.");
  });
});

// ---------------------------------------------------------------------------
// All fields missing simultaneously (fully incomplete metadata entry)
// ---------------------------------------------------------------------------

describe("buildDecisionExplanation — all fields missing simultaneously", () => {
  it("applies all three fallbacks when metadata entry has no fields", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["BARE_CODE"] },
      { metadata: { BARE_CODE: {} } }
    );
    const reason = result.reasons[0] as ResolvedReason;
    expect(reason.severity).toBe("info");
    expect(reason.category).toBe("general");
    expect(reason.summary).toBe("No summary available");
  });

  it("still uses the original code string when metadata entry has no fields", () => {
    const result = buildDecisionExplanation(
      { reasonCodes: ["BARE_CODE"] },
      { metadata: { BARE_CODE: {} } }
    );
    expect(result.reasons[0]?.code).toBe("BARE_CODE");
  });

  it("output shape is always complete even with a fully empty metadata entry", () => {
    assertCompleteShape(
      buildDecisionExplanation(
        { reasonCodes: ["BARE_CODE"] },
        { metadata: { BARE_CODE: {} } }
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Normal path — real metadata registry, no edge cases
// ---------------------------------------------------------------------------

describe("buildDecisionExplanation — normal (happy) path with real metadata", () => {
  it("resolves a known code correctly", () => {
    const result = buildDecisionExplanation({
      reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"],
    });
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]?.code).toBe("BLOCKED_HIGH_RISK_SCORE");
  });

  it("why string mentions the resolved code", () => {
    const result = buildDecisionExplanation({
      reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
    });
    expect(result.why).toContain("SAFE_HIGH_CONFIDENCE");
  });

  it("resolves multiple known codes preserving order", () => {
    const result = buildDecisionExplanation({
      reasonCodes: ["BLOCKED_SCHEMA_RISK", "BLOCKED_CRITICAL_RISK"],
    });
    expect(resolvedCodes(result)).toEqual([
      "BLOCKED_SCHEMA_RISK",
      "BLOCKED_CRITICAL_RISK",
    ]);
  });

  it("normal path output shape is always complete", () => {
    assertCompleteShape(
      buildDecisionExplanation({
        reasonCodes: ["PREVIEW_LOW_CONFIDENCE", "PREVIEW_MASS_SCOPE_CHANGE"],
      })
    );
  });

  it("maps known 'high' metadata severity to 'critical' in the resolved reason", () => {
    const result = buildDecisionExplanation({
      reasonCodes: ["BLOCKED_DESTRUCTIVE_OPERATION"],
    });
    expect(result.reasons[0]?.severity).toBe("critical");
  });

  it("maps known 'low' metadata severity to 'info' in the resolved reason", () => {
    const result = buildDecisionExplanation({
      reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
    });
    expect(result.reasons[0]?.severity).toBe("info");
  });
});
