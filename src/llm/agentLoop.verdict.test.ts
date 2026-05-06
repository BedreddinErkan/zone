import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyNoInfraVerificationOverride,
  inferVerificationFromLog,
  validatePassedClaim,
  validateUnrelatedClaim,
} from "./agentLoop.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent loop framework-aware verdicts", () => {
  it("infers tests_skipped_no_infra when a patch was applied without runnable tests", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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
    expect(
      logSpy.mock.calls.filter(([message]) => message === "[zone-agent-no-infra-verdict]")
    ).toHaveLength(1);
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
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = applyNoInfraVerificationOverride({
      verificationReason: "tests_inconclusive",
      framework: { hasTests: false, testFilesDetected: true },
      patchApplied: true,
      triggeredBy: "natural_completion",
    });

    expect(result).toBe("tests_skipped_no_infra");
    expect(
      logSpy.mock.calls.filter(([message]) => message === "[zone-agent-no-infra-override]")
    ).toHaveLength(1);
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
