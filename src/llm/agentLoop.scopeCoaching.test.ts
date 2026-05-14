/**
 * U.2.C Commit 2: scope-aware coaching rule for test failures.
 *
 * The tests_failed coaching prompt must use TEST_FAILURE_SCOPE_HARDENING
 * (not PROVIDER_AGNOSTIC_HARDENING) so the agent can emit tests_failed_unrelated
 * for out-of-scope failures without a mandatory patch attempt.
 */

import { describe, expect, it } from "vitest";
import { buildCoachingPrompt } from "./agentLoop.js";

describe("U.2.C — scope-aware coaching for test failures", () => {
  it("tests_failed coaching contains scope-OUT fast-exit path", () => {
    const prompt = buildCoachingPrompt("test_failed", "npm test exited 1", [], {});
    // Must contain the scope check heading
    expect(prompt).toContain("SCOPE CHECK BEFORE CLAIMING UNRELATED");
  });

  it("tests_failed coaching contains scope-OUT instruction to NOT patch out-of-scope files", () => {
    const prompt = buildCoachingPrompt("test_failed", "npm test exited 1", [], {});
    expect(prompt).toContain("Do NOT attempt to patch files outside your scope");
  });

  it("tests_failed coaching contains scope-IN mandatory patch instruction", () => {
    const prompt = buildCoachingPrompt("test_failed", "npm test exited 1", [], {});
    expect(prompt).toContain("You MUST attempt a corrective apply_patch");
  });

  it("tests_failed coaching does NOT contain the old unconditional patch mandate", () => {
    const prompt = buildCoachingPrompt("test_failed", "npm test exited 1", [], {});
    // The old text required patching for ALL failures — ensure it's gone from test_failed path
    expect(prompt).not.toContain(
      "Attempt at least one apply_patch implementing that hypothesis"
    );
  });

  it("syntax_broken coaching still contains the full PROVIDER_AGNOSTIC_HARDENING", () => {
    const prompt = buildCoachingPrompt(
      "apply_patch_syntax_broken_post_write",
      "broke file syntax",
      [],
      {}
    );
    // Syntax errors should still mandate patch attempts unconditionally
    expect(prompt).toContain("Attempt at least one apply_patch implementing that hypothesis");
  });

  it("tests_failed coaching allows tests_failed_unrelated verdict for out-of-scope", () => {
    const prompt = buildCoachingPrompt("test_failed", "npm test exited 1", [], {});
    expect(prompt).toContain("tests_failed_unrelated");
    // And the path is: cite evidence, confirm not in edits
    expect(prompt).toContain("confirmation it is not in your edits");
  });
});
