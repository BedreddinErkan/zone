import { describe, expect, it } from "vitest";
import { classifyVerificationResult, deriveFinalizeBranch, validatePassedClaim, type CodedError } from "./classify.js";

// Helper: build minimal CodedError arrays for tests
function coded(code: string, file = "src/a.ts", line = 1): CodedError {
  return { file, line, code, message: `Error ${code}` };
}
function codedMsg(code: string, message: string, file = "src/a.ts", line = 1): CodedError {
  return { file, line, code, message };
}

// ─── classifyVerificationResult ───────────────────────────────────────────────

describe("classifyVerificationResult — count fallback (no coded errors)", () => {
  it("returns regressed=false, isPreExisting=false when both counts are 0", () => {
    expect(classifyVerificationResult({ count: 0, codedErrors: [] }, { count: 0, codedErrors: [] }))
      .toEqual({ regressed: false, isPreExisting: false });
  });

  it("returns regressed=true when postCount > baselineCount and no coded errors", () => {
    expect(classifyVerificationResult({ count: 3, codedErrors: [] }, { count: 1, codedErrors: [] }))
      .toEqual({ regressed: true, isPreExisting: false });
  });

  it("returns regressed=true when baseline is 0 and post has count", () => {
    expect(classifyVerificationResult({ count: 2, codedErrors: [] }, { count: 0, codedErrors: [] }))
      .toEqual({ regressed: true, isPreExisting: false });
  });

  it("returns isPreExisting=true when baseline > 0 and post <= baseline (equal, no coded)", () => {
    expect(classifyVerificationResult({ count: 3, codedErrors: [] }, { count: 3, codedErrors: [] }))
      .toEqual({ regressed: false, isPreExisting: true });
  });

  it("returns isPreExisting=true when baseline > 0 and post < baseline (improved, no coded)", () => {
    expect(classifyVerificationResult({ count: 1, codedErrors: [] }, { count: 4, codedErrors: [] }))
      .toEqual({ regressed: false, isPreExisting: true });
  });
});

describe("classifyVerificationResult — identity-based (coded errors present)", () => {
  it("identical single error in post and baseline → regressed:false, isPreExisting:true", () => {
    const err = coded("TS2304");
    expect(
      classifyVerificationResult(
        { count: 1, codedErrors: [err] },
        { count: 1, codedErrors: [err] }
      )
    ).toEqual({ regressed: false, isPreExisting: true });
  });

  it("post is strict superset of baseline (new error added) → regressed:true", () => {
    const base = coded("TS2304", "src/a.ts", 1);
    const extra = coded("TS2305", "src/a.ts", 2);
    expect(
      classifyVerificationResult(
        { count: 2, codedErrors: [base, extra] },
        { count: 1, codedErrors: [base] }
      )
    ).toEqual({ regressed: true, isPreExisting: false });
  });

  it("(a) equal-count error-set SWAP → regressed:true even though counts match", () => {
    // Replacing N DOM-shadowing errors with N TS18047 errors is a regression.
    const postErrors = [
      coded("TS18047", "src/a.ts", 1),
      coded("TS18047", "src/a.ts", 2),
    ];
    const baseErrors = [
      coded("TS2540", "src/a.ts", 1),
      coded("TS2540", "src/a.ts", 2),
    ];
    expect(
      classifyVerificationResult(
        { count: 2, codedErrors: postErrors },
        { count: 2, codedErrors: baseErrors }
      )
    ).toEqual({ regressed: true, isPreExisting: false });
  });

  it("(b) genuine subset: same errors in post and baseline → regressed:false, isPreExisting:true", () => {
    const errs = [
      coded("TS2304", "src/a.ts", 5),
      coded("TS2305", "src/b.ts", 10),
    ];
    expect(
      classifyVerificationResult(
        { count: 2, codedErrors: errs },
        { count: 2, codedErrors: errs }
      )
    ).toEqual({ regressed: false, isPreExisting: true });
  });

  it("post is empty, baseline has errors → regressed:false (patch improved the tree)", () => {
    const base = coded("TS2304");
    expect(
      classifyVerificationResult(
        { count: 0, codedErrors: [] },
        { count: 1, codedErrors: [base] }
      )
    ).toEqual({ regressed: false, isPreExisting: true });
  });

  it("post has new error not in baseline → regressed:true (clean baseline)", () => {
    const newErr = coded("TS2304");
    expect(
      classifyVerificationResult(
        { count: 1, codedErrors: [newErr] },
        { count: 0, codedErrors: [] }
      )
    ).toEqual({ regressed: true, isPreExisting: false });
  });

  it("message normalization: same error with extra whitespace in message matches", () => {
    const post = [codedMsg("TS2304", "Cannot find name 'x'.", "src/a.ts", 1)];
    const base = [codedMsg("TS2304", "Cannot find name 'x'.", "src/a.ts", 1)];
    expect(
      classifyVerificationResult(
        { count: 1, codedErrors: post },
        { count: 1, codedErrors: base }
      )
    ).toEqual({ regressed: false, isPreExisting: true });
  });

  it("same code but different line number → treated as different errors (regression)", () => {
    const post = [coded("TS2304", "src/a.ts", 5)];
    const base = [coded("TS2304", "src/a.ts", 10)];
    expect(
      classifyVerificationResult(
        { count: 1, codedErrors: post },
        { count: 1, codedErrors: base }
      )
    ).toEqual({ regressed: true, isPreExisting: false });
  });

  it("baseline only has coded errors, post has none → regressed:false (improved)", () => {
    const base = [coded("TS2304")];
    expect(
      classifyVerificationResult(
        { count: 0, codedErrors: [] },
        { count: 1, codedErrors: base }
      )
    ).toEqual({ regressed: false, isPreExisting: true });
  });
});

// ─── deriveFinalizeBranch ─────────────────────────────────────────────────────

describe("deriveFinalizeBranch", () => {
  it('returns "applied" for pass status', () => {
    expect(deriveFinalizeBranch({ status: "pass" }, "warn")).toBe("applied");
    expect(deriveFinalizeBranch({ status: "pass" }, "rollback")).toBe("applied");
  });

  it('returns "skipped_no_command" for skipped with no_command_for_framework reason', () => {
    expect(deriveFinalizeBranch({ status: "skipped", reason: "no_command_for_framework" }, "warn")).toBe("skipped_no_command");
  });

  it('returns "no_change" for skipped with no_changes_made reason', () => {
    expect(deriveFinalizeBranch({ status: "skipped", reason: "no_changes_made" }, "warn")).toBe("no_change");
  });

  it('returns "skipped_no_command" for any other skipped reason', () => {
    expect(deriveFinalizeBranch({ status: "skipped", reason: "no_staged_files" }, "warn")).toBe("skipped_no_command");
  });

  it('returns "pre_existing_errors" for fail with regressed=false', () => {
    expect(deriveFinalizeBranch({ status: "fail", regressed: false }, "warn")).toBe("pre_existing_errors");
    expect(deriveFinalizeBranch({ status: "fail", regressed: false }, "rollback")).toBe("pre_existing_errors");
  });

  it('returns "rolled_back" for fail with regressed=true in rollback mode', () => {
    expect(deriveFinalizeBranch({ status: "fail", regressed: true }, "rollback")).toBe("rolled_back");
  });

  it('returns "applied_with_warnings" for fail with regressed=true in warn mode', () => {
    expect(deriveFinalizeBranch({ status: "fail", regressed: true }, "warn")).toBe("applied_with_warnings");
  });

  it('returns "applied_with_warnings" for fail with regressed=undefined in warn mode (treat as regression)', () => {
    expect(deriveFinalizeBranch({ status: "fail" }, "warn")).toBe("applied_with_warnings");
  });

  it('returns "rolled_back" for fail with regressed=undefined in rollback mode', () => {
    expect(deriveFinalizeBranch({ status: "fail" }, "rollback")).toBe("rolled_back");
  });
});

// ─── validatePassedClaim ───────────────────────────────────────────────────────
// Item 204: the predicate decides accept/demote from entry.success (exit code) on a
// command-text-narrowed candidate set — never from output-text success patterns.

describe("validatePassedClaim — false-accept fixed (mixed-result text no longer overrides exit code)", () => {
  it("demotes a claim when the matching run_command's own text contains a passing substring but it exited non-zero", () => {
    const log = [
      { tool: "run_command", args: { command: "npx vitest run" }, result: "3 passed, 1 failed", success: false },
    ];
    const result = validatePassedClaim(log, { hasTests: true });
    expect(result.accept).toBe(false);
    expect(result.demoteTo).toBe("tests_inconclusive");
  });
});

describe("validatePassedClaim — false-demote-by-output-shape fixed (passing output not matching any retired text pattern is now accepted, independent of ecosystem)", () => {
  it("accepts a passing Go test run (output shape unmatched by any retired pattern)", () => {
    const log = [
      { tool: "run_command", args: { command: "go test ./..." }, result: "ok  \tmypkg\t0.014s", success: true },
    ];
    expect(validatePassedClaim(log, { hasTests: true })).toEqual({
      accept: true,
      reason: "test command(s) invoked and none exited non-zero",
    });
  });

  it("accepts a passing Maven test run (output shape unmatched by any retired pattern)", () => {
    const log = [
      { tool: "run_command", args: { command: "mvn test" }, result: "BUILD SUCCESS", success: true },
    ];
    expect(validatePassedClaim(log, { hasTests: true }).accept).toBe(true);
  });

  it("accepts a passing PHPUnit run (output shape unmatched by any retired pattern)", () => {
    const log = [
      { tool: "run_command", args: { command: "phpunit" }, result: "Time: 00:00.123, Memory: 6.00 MB", success: true },
    ];
    expect(validatePassedClaim(log, { hasTests: true }).accept).toBe(true);
  });

  it("accepts a passing RSpec test run (output shape unmatched by any retired pattern)", () => {
    const log = [
      { tool: "run_command", args: { command: "bundle exec rspec" }, result: "Finished in 0.02341 seconds", success: true },
    ];
    expect(validatePassedClaim(log, { hasTests: true }).accept).toBe(true);
  });

  // The retired /\bTests:\s+.*passed/i pattern matches "Total tests: 8. Passed: 8." (its own
  // "Passed" satisfies the tail), so that older dotnet-test summary form would have been
  // accepted by the pre-fix predicate too and does not discriminate. This modern VSTest
  // summary line matches none of the six retired patterns — confirmed by running both forms
  // against a faithful pre-fix reconstruction.
  it("accepts a passing dotnet-test run using the modern VSTest summary line (the older 'Total tests: N. Passed: N.' form matches a retired pattern and would not discriminate)", () => {
    const log = [
      { tool: "run_command", args: { command: "dotnet test" }, result: "Passed!  - Failed: 0, Passed: 8, Skipped: 0, Total: 8", success: true },
    ];
    expect(validatePassedClaim(log, { hasTests: true }).accept).toBe(true);
  });
});

describe("validatePassedClaim — false-demote-by-tool-filter fixed (run_command_readonly now recognized)", () => {
  it("accepts a passing test run verified via run_command_readonly", () => {
    const log = [
      { tool: "run_command_readonly", args: { command: "npm test" }, result: "10 passed, 0 failed", success: true },
    ];
    expect(validatePassedClaim(log, { hasTests: true }).accept).toBe(true);
  });
});

// The empty-log cases below (and the two "regression guards" cases further down) also pass
// against a faithful pre-fix reconstruction — established directly, not assumed. That is
// correct, not a coverage gap: an empty toolCallLog produces an empty candidate set under
// both implementations by construction, so no input could make these two differ. The clean-fail
// regression guard is structurally identical for a different reason — its text matches no
// retired pattern, so the pre-fix predicate falls through to its own `success === false` check,
// the same signal the current predicate always reads; the two implementations agree because the
// old one's own fallback path already looked at the exit code, not by luck of the text. The
// clean-pass regression guard shares the coincidental-match mechanism the dotnet-test case above
// was replaced for, but its job — confirming the easy case stays easy — doesn't claim to
// demonstrate a specific defect fix, so it is not a candidate for replacement on that ground.
describe("validatePassedClaim — no-attempt branch precision", () => {
  it("demotes to no_verification_attempted for a truly empty log when the framework has tests", () => {
    const result = validatePassedClaim([], { hasTests: true });
    expect(result.accept).toBe(false);
    expect(result.demoteTo).toBe("no_verification_attempted");
  });

  it("demotes to tests_skipped_no_infra for a truly empty log when the framework has no tests", () => {
    const result = validatePassedClaim([], { hasTests: false });
    expect(result.accept).toBe(false);
    expect(result.demoteTo).toBe("tests_skipped_no_infra");
  });

  it("treats a log with only irrelevant run_command entries the same as an empty log, not as an inconclusive attempt", () => {
    // Behavior change beyond the three defects named for this pass: today, any run_command
    // entry — however irrelevant — forecloses no_verification_attempted. Command-text
    // narrowing means an irrelevant entry no longer counts as an attempt at all.
    const log = [
      { tool: "run_command", args: { command: "git status" }, result: "On branch master, nothing to commit", success: true },
    ];
    const result = validatePassedClaim(log, { hasTests: true });
    expect(result.accept).toBe(false);
    expect(result.demoteTo).toBe("no_verification_attempted");
  });
});

describe("validatePassedClaim — regression guards", () => {
  it("still accepts a single clean passing invocation", () => {
    const log = [
      { tool: "run_command", args: { command: "npm test" }, result: "10 passed, 0 failed", success: true },
    ];
    expect(validatePassedClaim(log, { hasTests: true }).accept).toBe(true);
  });

  it("still demotes a single clean failing invocation", () => {
    const log = [
      { tool: "run_command", args: { command: "npx vitest run" }, result: "1 failed", success: false },
    ];
    const result = validatePassedClaim(log, { hasTests: true });
    expect(result.accept).toBe(false);
    expect(result.demoteTo).toBe("tests_inconclusive");
  });
});

describe("validatePassedClaim — mixed candidates", () => {
  it("isolates the real test invocation from an interspersed irrelevant command when deciding failure", () => {
    const log = [
      { tool: "run_command", args: { command: "git status" }, result: "On branch master", success: true },
      { tool: "run_command", args: { command: "npx vitest run" }, result: "3 passed, 1 failed", success: false },
    ];
    const result = validatePassedClaim(log, { hasTests: true });
    expect(result.accept).toBe(false);
    expect(result.demoteTo).toBe("tests_inconclusive");
  });
});
