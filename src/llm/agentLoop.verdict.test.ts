import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyNoInfraVerificationOverride,
  inferVerificationFromLog,
  validatePassedClaim,
  validateUnrelatedClaim,
  type VerificationReason,
} from "./agentLoop.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent loop framework-aware verdicts", () => {
  it("infers tests_skipped_no_infra when a patch was applied without runnable tests", () => {
    const result = inferVerificationFromLog(
      [
        {
          tool: "apply_patch",
          args: {},
          result: "Success. Updated files.",
          success: true,
        },
      ],
      { hasTests: false, testFilesDetected: false }
    );

    expect(result).toBe("tests_skipped_no_infra");
  });

  it("keeps infra errors inconclusive when a runnable test command exists", () => {
    const result = inferVerificationFromLog(
      [
        {
          tool: "apply_patch",
          args: {},
          result: "Success. Updated files.",
          success: true,
        },
        {
          tool: "run_command",
          args: { command: "npm test" },
          result: "spawn npm ENOENT",
          success: false,
        },
      ],
      { hasTests: true, testFilesDetected: true }
    );

    expect(result).toBe("tests_inconclusive");
  });

  it("demotes unverifiable unrelated failure claims to skipped when no infra exists", () => {
    const result = validateUnrelatedClaim({
      log: [
        {
          tool: "apply_patch",
          args: {},
          result: "Success. Updated files.",
          success: true,
        },
      ],
      patchedFilePaths: ["src/foo.ts"],
      framework: { hasTests: false },
    });

    expect(result.accept).toBe(false);
    expect(result.demoteTo).toBe("tests_skipped_no_infra");
  });

  it("demotes false tests_passed claims to skipped when no infra exists", () => {
    const result = validatePassedClaim([], { hasTests: false });

    expect(result.accept).toBe(false);
    expect(result.demoteTo).toBe("tests_skipped_no_infra");
  });

  it("overrides a natural-completion inconclusive self-tag to skipped when no infra exists", () => {
    const result = applyNoInfraVerificationOverride({
      verificationReason: "tests_inconclusive",
      framework: { hasTests: false, testFilesDetected: true },
      patchApplied: true,
      triggeredBy: "natural_completion",
    });

    expect(result).toBe("tests_skipped_no_infra");
  });

  it("preserves a natural-completion patch-failure self-tag when no infra exists", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = applyNoInfraVerificationOverride({
      verificationReason: "tests_failed_by_patch",
      framework: { hasTests: false, testFilesDetected: true },
      patchApplied: true,
      triggeredBy: "natural_completion",
    });

    expect(result).toBe("tests_failed_by_patch");
    expect(
      logSpy.mock.calls.filter(([message]) => message === "[zone-agent-no-infra-override]")
    ).toHaveLength(0);
  });
});

// T.4: Phase F.2 — isVerificationRegressed strict-equals semantics.
// runLlmPatchFlow.ts:6022: `const isVerificationRegressed = vr === "verification_regressed"`.
// This must NOT match "verification_warnings" — warn-mode patches stay on disk,
// rollback banner must not appear.
describe("Phase F.2 — isVerificationRegressed strict-equals semantics", () => {
  it("T.4: isVerificationRegressed matches only verification_regressed, not verification_warnings", () => {
    // Replicate the exact expression from runLlmPatchFlow.ts:6022.
    function isVerificationRegressed(vr: VerificationReason | string | null | undefined): boolean {
      return vr === "verification_regressed";
    }

    // Must be true for rollback reason
    expect(isVerificationRegressed("verification_regressed")).toBe(true);

    // Must be false for warn-mode reason (Phase F.2 fix: these are distinct)
    expect(isVerificationRegressed("verification_warnings")).toBe(false);

    // Must be false for all other VerificationReason values
    expect(isVerificationRegressed("tests_passed")).toBe(false);
    expect(isVerificationRegressed("tests_inconclusive")).toBe(false);
    expect(isVerificationRegressed("no_verification_attempted")).toBe(false);
    expect(isVerificationRegressed(null)).toBe(false);
    expect(isVerificationRegressed(undefined)).toBe(false);
  });
});
