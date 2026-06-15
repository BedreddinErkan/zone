import { describe, expect, it } from "vitest";
import { classifyVerificationResult, deriveFinalizeBranch, type CodedError } from "./classify.js";

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
