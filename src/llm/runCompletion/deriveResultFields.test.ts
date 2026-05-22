import { describe, it, expect } from "vitest";
import { deriveResultFields } from "./deriveResultFields.js";
import type { VerifyOutcome } from "../verification/types.js";
import type { VerdictResult } from "./types.js";

const baseVerdict: VerdictResult = {
  reason: "tests_passed",
  patchValidatedByAgent: true,
  inferredFrom: "tag",
  strippedText: "All done.",
};

const baseVerification = {
  label: "npm test",
  durationMs: 1000,
};

describe("deriveResultFields", () => {
  it("no_change → no_changes_made, patchValidated=false", () => {
    const outcome: VerifyOutcome = { kind: "no_change" };
    const fields = deriveResultFields(outcome, baseVerdict);
    expect(fields.verificationReason).toBe("no_changes_made");
    expect(fields.patchValidatedByAgent).toBe(false);
    expect(fields.summaryAppendix).toBe("");
  });

  it("pre_existing_errors → tests_inconclusive, patchValidated=false, appendix set", () => {
    const outcome: VerifyOutcome = {
      kind: "pre_existing_errors",
      verification: baseVerification,
      appendix: "\n[pre-existing errors]",
      filesFlushed: 1,
    };
    const fields = deriveResultFields(outcome, baseVerdict);
    expect(fields.verificationReason).toBe("tests_inconclusive");
    expect(fields.patchValidatedByAgent).toBe(false);
    expect(fields.summaryAppendix).toBe("\n[pre-existing errors]");
  });

  it("rolled_back → verification_regressed, patchValidated=false, restoredFiles+errors+discardedStaging set", () => {
    const discarded = new Map([["file.ts", "content"]]);
    const outcome: VerifyOutcome = {
      kind: "rolled_back",
      verification: baseVerification,
      restoredFiles: ["/repo/file.ts"],
      errors: [{ file: "file.ts", line: 1, message: "err", context: "" }],
      appendix: "\n[rolled back]",
      discardedStaging: discarded,
    };
    const fields = deriveResultFields(outcome, baseVerdict);
    expect(fields.verificationReason).toBe("verification_regressed");
    expect(fields.patchValidatedByAgent).toBe(false);
    expect(fields.summaryAppendix).toBe("\n[rolled back]");
    expect(fields.restoredFiles).toEqual(["/repo/file.ts"]);
    expect(fields.errors).toHaveLength(1);
    expect(fields.discardedStaging).toBe(discarded);
  });

  it("applied_with_warnings → verification_warnings, patchValidated=false, appendix+errors set", () => {
    const outcome: VerifyOutcome = {
      kind: "applied_with_warnings",
      verification: baseVerification,
      appendix: "\n[warnings]",
      errors: [{ file: "file.ts", line: 1, message: "warn", context: "" }],
      filesFlushed: 1,
    };
    const fields = deriveResultFields(outcome, baseVerdict);
    expect(fields.verificationReason).toBe("verification_warnings");
    expect(fields.patchValidatedByAgent).toBe(false);
    expect(fields.summaryAppendix).toBe("\n[warnings]");
    expect(fields.errors).toHaveLength(1);
  });

  it("applied → passes verdict through", () => {
    const outcome: VerifyOutcome = {
      kind: "applied",
      verification: baseVerification,
      filesFlushed: 2,
    };
    const fields = deriveResultFields(outcome, baseVerdict);
    expect(fields.verificationReason).toBe("tests_passed");
    expect(fields.patchValidatedByAgent).toBe(true);
    expect(fields.summaryAppendix).toBe("");
    expect(fields.restoredFiles).toBeUndefined();
    expect(fields.errors).toBeUndefined();
    expect(fields.discardedStaging).toBeUndefined();
  });

  it("skipped → passes verdict through", () => {
    const outcome: VerifyOutcome = {
      kind: "skipped",
      reason: "no_staged_files",
    };
    const fields = deriveResultFields(outcome, baseVerdict);
    expect(fields.verificationReason).toBe("tests_passed");
    expect(fields.patchValidatedByAgent).toBe(true);
    expect(fields.summaryAppendix).toBe("");
  });
});
