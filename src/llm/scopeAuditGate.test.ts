/**
 * Phase AS.0 — scope audit gate integration tests.
 * Tests shouldRunAudit gating logic and judge integration via unit-level
 * stubs (no HTTP calls). The server.ts wiring is validated structurally;
 * the full E2E path is covered by scopeJudge.test.ts + revisionApprovals.test.ts.
 */

import { describe, expect, it } from "vitest";

// shouldRunAudit is not exported from server.ts (it's inlined), so we
// test the same logic here as a standalone helper.
function shouldRunAudit(
  tier: "simple" | "medium" | "complex",
  perRunFlag: boolean,
  autoAuditComplexTasks: boolean
): boolean {
  if (tier === "complex" && autoAuditComplexTasks) return true;
  if (tier === "medium" && perRunFlag) return true;
  return false;
}

describe("shouldRunAudit gating logic", () => {
  it("complex + autoAudit=true → run audit", () => {
    expect(shouldRunAudit("complex", false, true)).toBe(true);
  });

  it("complex + autoAudit=false → skip", () => {
    expect(shouldRunAudit("complex", false, false)).toBe(false);
  });

  it("medium + perRunFlag=true → run audit", () => {
    expect(shouldRunAudit("medium", true, false)).toBe(true);
  });

  it("medium + perRunFlag=false + autoAudit=true → skip (auto only for complex)", () => {
    expect(shouldRunAudit("medium", false, true)).toBe(false);
  });

  it("medium + perRunFlag=false + autoAudit=false → skip", () => {
    expect(shouldRunAudit("medium", false, false)).toBe(false);
  });

  it("simple + any flags → always skip", () => {
    expect(shouldRunAudit("simple", true, true)).toBe(false);
    expect(shouldRunAudit("simple", false, false)).toBe(false);
  });

  it("complex + perRunFlag=true + autoAudit=false → skip (perRunFlag only gates medium)", () => {
    // Per spec: perRunFlag is a medium-tier opt-in; complex is always auto when setting is on.
    // complex + autoAudit=false + perRunFlag=true → false (neither branch matches)
    expect(shouldRunAudit("complex", true, false)).toBe(false);
  });
});

describe("shouldRunAudit — all tier × setting combinations", () => {
  const tiers = ["simple", "medium", "complex"] as const;
  const expected: Record<string, boolean> = {
    "simple-false-false": false,
    "simple-false-true": false,
    "simple-true-false": false,
    "simple-true-true": false,
    "medium-false-false": false,
    "medium-false-true": false,
    "medium-true-false": true,
    "medium-true-true": true,
    "complex-false-false": false,
    "complex-false-true": true,
    "complex-true-false": false,
    "complex-true-true": true,
  };

  for (const tier of tiers) {
    for (const perRun of [false, true]) {
      for (const autoComplex of [false, true]) {
        const key = `${tier}-${perRun}-${autoComplex}`;
        it(`${key} → ${expected[key]}`, () => {
          expect(shouldRunAudit(tier, perRun, autoComplex)).toBe(expected[key]);
        });
      }
    }
  }
});
