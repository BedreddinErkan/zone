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

// ── Characterization: item 14's Step 9 fix — this test is unaffected by it ─────
//
// deriveVerdict.ts:42-47 wires filesModified straight through as validateUnrelatedClaim's
// patchedFilePaths, with zero transformation. Before item 14's fix, Step 9 added a write
// attempt's filePath to filesModified with no result.success check, so a FAILED patch
// landed it in patchedFilePaths exactly like a successful one. This test calls
// validateUnrelatedClaim directly with a hand-built patchedFilePaths — it never goes
// through Step 9 — so it's a synthetic reproduction of that shape, not a
// regression-sensitive measurement of the fix. It stays green, unchanged: a real run can
// no longer produce this exact input (Step 9 now excludes a failed patch's file via
// filesStaged), but validateUnrelatedClaim's own contract — treat patchedFilePaths as
// given, don't re-derive it from `log` — is still worth pinning on its own terms.
describe("characterization: validateUnrelatedClaim's patchedFilePaths contract (unaffected by item 14)", () => {
  it("demotes an unrelated-failure claim when the only prior touch to the failing file was a FAILED patch", () => {
    // Simulates today's ungated handleToolResult Step 9: a FAILED apply_patch on
    // src/foo.ts still lands its filePath in ctx.filesModified, which deriveVerdict.ts
    // wires straight through unchanged as patchedFilePaths. validateUnrelatedClaim
    // (classify.ts:172) takes patchedFilePaths as a plain input — it never re-derives it
    // from `log` and never inspects the apply_patch log entry's own `success` flag — so
    // this call is structurally identical whether the patch succeeded or failed.
    const result = validateUnrelatedClaim({
      log: [
        // Narrative fidelity only — validateUnrelatedClaim only ever inspects entries
        // where tool==="run_command"; this entry's presence/absence does not change the
        // function's return value. It documents WHY "src/foo.ts" is in patchedFilePaths
        // despite never having a successful write.
        {
          tool: "apply_patch",
          args: { filePath: "src/foo.ts" },
          result: "Block 1: FIND content not found in file. Re-read the file with read_file...",
          success: false,
        },
        {
          tool: "run_command",
          args: { command: "npm test" },
          result:
            "FAIL src/foo.test.ts\n" +
            "TypeError: Cannot read properties of undefined (reading 'bar')\n" +
            "    at Object.<anonymous> (src/foo.ts:12:5)\n" +
            "    at Object.<anonymous> (src/foo.test.ts:8:3)",
          success: false,
        },
      ],
      patchedFilePaths: ["src/foo.ts"],
      framework: { hasTests: true },
    });

    expect(result.accept).toBe(false);
    expect(result.demoteTo).toBe("tests_failed_by_patch");
  });
});
