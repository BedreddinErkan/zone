import { describe, expect, it } from "vitest";
import {
  canResumeFromTerminationReason,
  getPatchUserFacingReason,
} from "./patchUserFacingReason.js";

describe("getPatchUserFacingReason", () => {
  it("natural_completion: success message, canResume=true, no hint", () => {
    const out = getPatchUserFacingReason({ terminationReason: "natural_completion" });
    expect(out.userFacingMessage).toBe("Run completed successfully.");
    expect(out.canResume).toBe(true);
    expect(out.resumeHint).toBeNull();
    expect(out.reason).toBe("natural_completion");
  });

  it("max_iterations with context: includes iter count in message, canResume=true", () => {
    const out = getPatchUserFacingReason({
      terminationReason: "max_iterations",
      context: { iterCount: 25, iterCap: 25 },
    });
    expect(out.userFacingMessage).toContain("(25/25)");
    expect(out.canResume).toBe(true);
    expect(out.resumeHint).toBe("Try a more focused follow-up task");
  });

  it("max_iterations without context: omits iter count, still canResume=true", () => {
    const out = getPatchUserFacingReason({ terminationReason: "max_iterations" });
    expect(out.userFacingMessage).toContain("Hit max iteration limit");
    expect(out.userFacingMessage).not.toContain("(");
    expect(out.canResume).toBe(true);
  });

  it("token_budget_exceeded: mentions ZONE_TIER_TOKEN_CAP, canResume=true", () => {
    const out = getPatchUserFacingReason({ terminationReason: "token_budget_exceeded" });
    expect(out.userFacingMessage).toContain("ZONE_TIER_TOKEN_CAP");
    expect(out.canResume).toBe(true);
    expect(out.resumeHint).toBe("Raise token cap or split task");
  });

  it("daily_usd_cap_exceeded with context: includes spent/cap, canResume=true", () => {
    const out = getPatchUserFacingReason({
      terminationReason: "daily_usd_cap_exceeded",
      context: { costUsd: 9.87, capUsd: 10.0 },
    });
    expect(out.userFacingMessage).toContain("$9.87");
    expect(out.userFacingMessage).toContain("$10.00");
    expect(out.canResume).toBe(true);
    expect(out.resumeHint).toContain("ZONE_DAILY_USD_CAP");
  });

  it("daily_usd_cap_exceeded without context: omits budget part, still canResume=true", () => {
    const out = getPatchUserFacingReason({ terminationReason: "daily_usd_cap_exceeded" });
    expect(out.userFacingMessage).toContain("Daily USD cap reached");
    expect(out.userFacingMessage).not.toContain("$");
    expect(out.canResume).toBe(true);
  });

  it("compaction_exhausted: canResume=false, no resumeHint", () => {
    const out = getPatchUserFacingReason({ terminationReason: "compaction_exhausted" });
    expect(out.canResume).toBe(false);
    expect(out.resumeHint).toBeNull();
    expect(out.userFacingMessage).toContain("compaction");
  });

  it("loop_detected: canResume=false, no resumeHint", () => {
    const out = getPatchUserFacingReason({ terminationReason: "loop_detected" });
    expect(out.canResume).toBe(false);
    expect(out.resumeHint).toBeNull();
    expect(out.userFacingMessage).toContain("loop");
  });

  it("APPLY_ROLLED_BACK: canResume=true, has resumeHint", () => {
    const out = getPatchUserFacingReason({ terminationReason: "APPLY_ROLLED_BACK" });
    expect(out.canResume).toBe(true);
    expect(out.resumeHint).toContain("verification");
    expect(out.userFacingMessage).toContain("rolled back");
  });

  it("unknown reason: canResume=false, message contains the raw reason", () => {
    const out = getPatchUserFacingReason({ terminationReason: "some_unknown_error" });
    expect(out.canResume).toBe(false);
    expect(out.userFacingMessage).toContain("some_unknown_error");
    expect(out.resumeHint).toBeNull();
  });
});

describe("canResumeFromTerminationReason", () => {
  it("returns true for resumable reasons", () => {
    expect(canResumeFromTerminationReason("natural_completion")).toBe(true);
    expect(canResumeFromTerminationReason("max_iterations")).toBe(true);
    expect(canResumeFromTerminationReason("token_budget_exceeded")).toBe(true);
    expect(canResumeFromTerminationReason("daily_usd_cap_exceeded")).toBe(true);
    expect(canResumeFromTerminationReason("APPLY_ROLLED_BACK")).toBe(true);
  });

  it("returns false for non-resumable reasons", () => {
    expect(canResumeFromTerminationReason("loop_detected")).toBe(false);
    expect(canResumeFromTerminationReason("compaction_exhausted")).toBe(false);
    expect(canResumeFromTerminationReason("unknown_reason")).toBe(false);
  });
});
