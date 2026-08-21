/**
 * The consumer surface of the `run_usd_cap_exceeded` termination reason — ledger item 259.
 *
 * Last pass recorded "13 consumers, 22 sites" as the cost of adding a member, and that figure was
 * wrong: two instruments disagreed (git grep 13 files, AST 11) and BOTH were wrong — one reference
 * is comment-only, one is an indexed access type the AST didn't cover. Classifying all 90
 * production references showed only three consumers change behaviour, and only one was a defect.
 * These tests pin that one, plus the envelope claim that would otherwise rest on a comment.
 */

import { describe, expect, it } from "vitest";
import { getPatchUserFacingReason, canResumeFromTerminationReason } from "./patchUserFacingReason.js";

describe("a run stopped by --max-budget-usd is resumable, not 'unexpected' (item 259)", () => {
  it("is resumable — the default arm would have said otherwise", () => {
    expect(canResumeFromTerminationReason("run_usd_cap_exceeded")).toBe(true);
  });

  it("is categorised a warning, not an error", () => {
    const o = getPatchUserFacingReason({ terminationReason: "run_usd_cap_exceeded" });
    expect(o.category).toBe("warning");
    expect(o.userFacingMessage).not.toContain("unexpectedly");
    expect(o.resumeHint).toContain("--max-budget-usd");
  });

  it("names spend and cap when the context carries them", () => {
    const o = getPatchUserFacingReason({
      terminationReason: "run_usd_cap_exceeded",
      context: { costUsd: 0.26, capUsd: 0.25 },
    });
    expect(o.userFacingMessage).toContain("$0.26");
    expect(o.userFacingMessage).toContain("$0.25");
  });

  /**
   * Anti-vacuity: proves the three assertions above are actually carried by the new case rather
   * than being what the default would have produced anyway. This is the exact wrong answer the
   * default gives, and it is why the case had to be added rather than relied upon.
   */
  it("detector: an unknown reason still gets the wrong-for-a-budget-stop default", () => {
    const o = getPatchUserFacingReason({ terminationReason: "some_unhandled_reason" });
    expect(o.canResume).toBe(false);
    expect(o.category).toBe("error");
    expect(o.userFacingMessage).toContain("unexpectedly");
  });
});

describe("EnvelopeStatus admits the new reason by construction (item 259)", () => {
  /**
   * `diskRunEnvelope.ts`'s comment claims adding a terminationReason is "zero envelope change".
   * Verified rather than trusted, and the real reason is stronger than the comment: the resume
   * predicate is `env.status !== "running" || !isPidAlive(env.pid)` — a denylist of ONE — so any
   * new status is resumable with no allowlist to update, and nothing switches on EnvelopeStatus.
   */
  it("the new reason is assignable to EnvelopeStatus without a cast", async () => {
    const mod = await import("../api/diskRunEnvelope.js");
    type EnvelopeStatus = import("../api/diskRunEnvelope.js").EnvelopeStatus;
    const status: EnvelopeStatus = "run_usd_cap_exceeded";
    expect(status).toBe("run_usd_cap_exceeded");
    expect(typeof mod.stampEnvelopeStatus).toBe("function");
  });

  /**
   * The one value the derivation deliberately excludes — and which the stamp site's
   * `as EnvelopeStatus` cast nevertheless admits at runtime. Recorded as its own ledger finding:
   * `composer.ts` can emit `natural_completion` with `success: false` (an `applied_with_warnings`
   * outcome), which routes to the stamping branch and writes a status the type says is impossible.
   * This asserts the exclusion is real, so the day someone replaces the cast with a checked mapping
   * there is a test saying what the mapping must not silently allow.
   */
  it("natural_completion is excluded from EnvelopeStatus — the exclusion the cast bypasses", () => {
    type EnvelopeStatus = import("../api/diskRunEnvelope.js").EnvelopeStatus;
    const excluded: "natural_completion" extends EnvelopeStatus ? false : true = true;
    expect(excluded).toBe(true);
  });
});
