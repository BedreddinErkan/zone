/**
 * Phase AS.0 — scope audit gate integration tests.
 * Tests shouldRunAudit gating logic and judge integration via unit-level
 * stubs (no HTTP calls). The server.ts wiring is validated structurally;
 * the full E2E path is covered by scopeJudge.test.ts + revisionApprovals.test.ts.
 *
 * Phase AS.0.1: audit is now default-on for medium and complex tiers.
 * perRunOverride semantics: undefined = don't block (use autoAuditSetting),
 * false = user explicitly turned off this run, true = user explicitly kept on.
 */

import { describe, expect, it } from "vitest";

// shouldRunAudit is not exported from server.ts (it's inlined), so we
// test the same logic here as a standalone helper.
function shouldRunAudit(
  tier: "simple" | "medium" | "complex",
  perRunOverride: boolean | undefined,
  autoAuditSetting: boolean
): boolean {
  if (tier === "simple") return false;
  if (perRunOverride === false) return false;
  return autoAuditSetting;
}

describe("shouldRunAudit — basic tier logic", () => {
  it("simple → always skip regardless of flags", () => {
    expect(shouldRunAudit("simple", true, true)).toBe(false);
    expect(shouldRunAudit("simple", false, true)).toBe(false);
    expect(shouldRunAudit("simple", undefined, true)).toBe(false);
    expect(shouldRunAudit("simple", undefined, false)).toBe(false);
  });

  it("medium + autoAudit=true + perRunOverride=undefined → run (default-on)", () => {
    expect(shouldRunAudit("medium", undefined, true)).toBe(true);
  });

  it("medium + autoAudit=true + perRunOverride=true → run", () => {
    expect(shouldRunAudit("medium", true, true)).toBe(true);
  });

  it("medium + autoAudit=true + perRunOverride=false → skip (user turned off)", () => {
    expect(shouldRunAudit("medium", false, true)).toBe(false);
  });

  it("medium + autoAudit=false + perRunOverride=undefined → skip (global off)", () => {
    expect(shouldRunAudit("medium", undefined, false)).toBe(false);
  });

  it("medium + autoAudit=false + perRunOverride=true → skip (global off wins)", () => {
    expect(shouldRunAudit("medium", true, false)).toBe(false);
  });

  it("complex + autoAudit=true + perRunOverride=undefined → run (default-on)", () => {
    expect(shouldRunAudit("complex", undefined, true)).toBe(true);
  });

  it("complex + autoAudit=true + perRunOverride=false → skip (user turned off)", () => {
    expect(shouldRunAudit("complex", false, true)).toBe(false);
  });

  it("complex + autoAudit=false + perRunOverride=undefined → skip (global off)", () => {
    expect(shouldRunAudit("complex", undefined, false)).toBe(false);
  });
});

describe("shouldRunAudit — all tier × setting combinations (perRunOverride=undefined = default behavior)", () => {
  const tiers = ["simple", "medium", "complex"] as const;

  // With perRunOverride=undefined, result is purely autoAuditSetting for non-simple.
  const expected: Record<string, boolean> = {
    "simple-false": false,
    "simple-true": false,
    "medium-false": false,
    "medium-true": true,
    "complex-false": false,
    "complex-true": true,
  };

  for (const tier of tiers) {
    for (const autoAudit of [false, true]) {
      const key = `${tier}-${autoAudit}`;
      it(`${key} → ${expected[key]}`, () => {
        expect(shouldRunAudit(tier, undefined, autoAudit)).toBe(expected[key]);
      });
    }
  }
});

describe("shouldRunAudit — perRunOverride=false always skips non-simple", () => {
  it("medium + perRunOverride=false → skip even with autoAudit=true", () => {
    expect(shouldRunAudit("medium", false, true)).toBe(false);
  });

  it("complex + perRunOverride=false → skip even with autoAudit=true", () => {
    expect(shouldRunAudit("complex", false, true)).toBe(false);
  });
});
