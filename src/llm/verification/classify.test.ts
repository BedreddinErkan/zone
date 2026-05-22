import { describe, expect, it } from "vitest";
// RED phase: these imports fail until classifyVerificationResult and
// deriveFinalizeBranch are added to classify.ts
import { classifyVerificationResult, deriveFinalizeBranch } from "./classify.js";

describe("classifyVerificationResult", () => {
  it("returns regressed=false, isPreExisting=false when both counts are 0 (pass)", () => {
    expect(classifyVerificationResult(0, 0)).toEqual({ regressed: false, isPreExisting: false });
  });

  it("returns regressed=true when postErrorCount > baselineErrorCount", () => {
    expect(classifyVerificationResult(3, 1)).toEqual({ regressed: true, isPreExisting: false });
  });

  it("returns regressed=true when baseline is 0 and post has errors", () => {
    expect(classifyVerificationResult(2, 0)).toEqual({ regressed: true, isPreExisting: false });
  });

  it("returns isPreExisting=true when baseline > 0 and post <= baseline (equal)", () => {
    expect(classifyVerificationResult(3, 3)).toEqual({ regressed: false, isPreExisting: true });
  });

  it("returns isPreExisting=true when baseline > 0 and post < baseline (improved)", () => {
    expect(classifyVerificationResult(1, 4)).toEqual({ regressed: false, isPreExisting: true });
  });

  it("returns regressed=false, isPreExisting=false when both counts are 0 (identical clean)", () => {
    expect(classifyVerificationResult(0, 0)).toEqual({ regressed: false, isPreExisting: false });
  });
});

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
