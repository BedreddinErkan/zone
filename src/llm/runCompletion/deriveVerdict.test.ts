import { describe, it, expect, vi, beforeEach } from "vitest";
import { deriveVerdict } from "./deriveVerdict.js";
import type { VerdictInput } from "./types.js";

const mockDebugLog = vi.hoisted(() => vi.fn());
vi.mock("../../utils/logger.js", () => ({ debugLog: mockDebugLog }));

// Minimal tool-call log entries
const noLog: VerdictInput["toolCallLog"] = [];
const patchLog: VerdictInput["toolCallLog"] = [
  { id: "1", tool: "apply_patch", args: {}, result: "ok", success: true },
];
const patchThenTestPass: VerdictInput["toolCallLog"] = [
  { id: "1", tool: "apply_patch", args: {}, result: "ok", success: true },
  { id: "2", tool: "run_command", args: {}, result: "10 passed, 0 failed", success: true },
];
const patchThenTestFail: VerdictInput["toolCallLog"] = [
  { id: "1", tool: "apply_patch", args: {}, result: "ok", success: true },
  { id: "2", tool: "run_command", args: {}, result: "1 failed", success: false },
  { id: "3", tool: "run_command", args: {}, result: "2 passed", success: true },
];

describe("deriveVerdict", () => {
  describe("tag path", () => {
    it("returns the tagged reason and strips the tag", () => {
      const input: VerdictInput = {
        finalText: "All done. [ZONE_VERIFICATION: tests_passed]",
        trigger: "natural_completion",
        toolCallLog: patchThenTestPass,
        filesModified: ["/repo/src/foo.ts"],
        patchApplied: true,
      };
      const result = deriveVerdict(input);
      expect(result.reason).toBe("tests_passed");
      expect(result.inferredFrom).toBe("tag");
      expect(result.strippedText).not.toContain("[ZONE_VERIFICATION");
    });

    it("falls back to heuristic on unknown tag value", () => {
      const input: VerdictInput = {
        finalText: "Done [ZONE_VERIFICATION: totally_made_up]",
        trigger: "max_iterations",
        toolCallLog: patchLog,
        filesModified: [],
        patchApplied: true,
      };
      const result = deriveVerdict(input);
      expect(result.inferredFrom).toBe("heuristic");
    });
  });

  describe("heuristic path", () => {
    it("returns no_verification_attempted for natural_completion with no tag", () => {
      const input: VerdictInput = {
        finalText: "No tag here",
        trigger: "natural_completion",
        toolCallLog: noLog,
        filesModified: [],
        patchApplied: false,
      };
      const result = deriveVerdict(input);
      expect(result.reason).toBe("no_verification_attempted");
      expect(result.inferredFrom).toBe("heuristic");
      expect(result.strippedText).toBe("No tag here");
    });

    it("infers from log for max_iterations", () => {
      const input: VerdictInput = {
        finalText: "Max iter hit",
        trigger: "max_iterations",
        toolCallLog: patchThenTestPass,
        filesModified: ["/repo/src/foo.ts"],
        patchApplied: true,
      };
      const result = deriveVerdict(input);
      expect(result.inferredFrom).toBe("heuristic");
    });
  });

  describe("tests_passed demotion", () => {
    it("demotes tests_passed when validatePassedClaim rejects (no run_command)", () => {
      const input: VerdictInput = {
        finalText: "Done [ZONE_VERIFICATION: tests_passed]",
        trigger: "natural_completion",
        toolCallLog: [
          { id: "1", tool: "apply_patch", args: {}, result: "ok", success: true },
          // no run_command → validatePassedClaim rejects
        ],
        filesModified: [],
        patchApplied: true,
      };
      const result = deriveVerdict(input);
      // validatePassedClaim: no runCommands → demote
      expect(result.reason).not.toBe("tests_passed");
    });
  });

  describe("Bug 44b — tests_failed_unrelated promote-path", () => {
    it("promotes tests_failed_unrelated to tests_passed when validateUnrelatedClaim accepts with resolved-by-run_command reason", () => {
      // This is Bug 44b verbatim: failure resolved by a later successful run_command
      const input: VerdictInput = {
        finalText: "Done [ZONE_VERIFICATION: tests_failed_unrelated]",
        trigger: "natural_completion",
        toolCallLog: patchThenTestFail,  // failing cmd followed by passing cmd
        filesModified: ["/repo/src/other.ts"],  // not the failing file
        patchApplied: true,
      };
      const result = deriveVerdict(input);
      // validateUnrelatedClaim should accept and return reason containing
      // "resolved by a later successful run_command" → promote to tests_passed
      expect(result.reason).toBe("tests_passed");
      expect(result.patchValidatedByAgent).toBe(true);
    });

    it("demotes tests_failed_unrelated when validateUnrelatedClaim rejects", () => {
      const input: VerdictInput = {
        finalText: "Done [ZONE_VERIFICATION: tests_failed_unrelated]",
        trigger: "natural_completion",
        toolCallLog: [
          // no run_command at all
          { id: "1", tool: "apply_patch", args: {}, result: "ok", success: true },
        ],
        filesModified: [],
        patchApplied: true,
      };
      const result = deriveVerdict(input);
      expect(result.reason).not.toBe("tests_failed_unrelated");
      expect(result.reason).not.toBe("tests_passed");
    });
  });

  describe("patchValidatedByAgent", () => {
    it("is true for tests_passed", () => {
      const input: VerdictInput = {
        finalText: "Done [ZONE_VERIFICATION: tests_passed]",
        trigger: "natural_completion",
        toolCallLog: patchThenTestPass,
        filesModified: [],
        patchApplied: true,
      };
      const result = deriveVerdict(input);
      expect(result.patchValidatedByAgent).toBe(true);
    });

    it("is true for tests_skipped_no_infra", () => {
      const input: VerdictInput = {
        finalText: "Done [ZONE_VERIFICATION: tests_skipped_no_infra]",
        trigger: "natural_completion",
        toolCallLog: patchLog,
        filesModified: [],
        patchApplied: true,
        framework: { hasTests: false, testFilesDetected: false },
      };
      const result = deriveVerdict(input);
      expect(result.patchValidatedByAgent).toBe(true);
    });

    it("is false for tests_failed_by_patch", () => {
      const input: VerdictInput = {
        finalText: "Done [ZONE_VERIFICATION: tests_failed_by_patch]",
        trigger: "natural_completion",
        toolCallLog: patchLog,
        filesModified: [],
        patchApplied: true,
      };
      const result = deriveVerdict(input);
      expect(result.patchValidatedByAgent).toBe(false);
    });
  });

  describe("applyNoInfraVerificationOverride", () => {
    it("overrides tests_inconclusive to tests_skipped_no_infra when framework has no tests", () => {
      const input: VerdictInput = {
        finalText: "Done [ZONE_VERIFICATION: tests_inconclusive]",
        trigger: "natural_completion",
        toolCallLog: patchLog,
        filesModified: [],
        patchApplied: true,
        framework: { hasTests: false, testFilesDetected: false },
      };
      const result = deriveVerdict(input);
      expect(result.reason).toBe("tests_skipped_no_infra");
    });
  });

  describe("inferredFrom telemetry", () => {
    beforeEach(() => {
      mockDebugLog.mockClear();
    });

    it("emits [zone-agent-verdict-inferred-from] with inferredFrom:tag when a tag is present", () => {
      deriveVerdict({
        finalText: "Done [ZONE_VERIFICATION: tests_passed]",
        trigger: "natural_completion",
        toolCallLog: patchThenTestPass,
        filesModified: [],
        patchApplied: true,
      });
      expect(mockDebugLog).toHaveBeenCalledWith(
        "[zone-agent-verdict-inferred-from]",
        JSON.stringify({ inferredFrom: "tag", reason: "tests_passed", trigger: "natural_completion" })
      );
    });

    // Mirrors the "infers from log for max_iterations" fixture above (heuristic path
    // describe block) — no tag, trigger:max_iterations, reason genuinely computed via
    // inferVerificationFromLog. This is the branch the telemetry exists to measure
    // against the tag path.
    it("emits inferredFrom:heuristic when no tag is present and trigger is max_iterations (genuine heuristic)", () => {
      deriveVerdict({
        finalText: "Max iter hit",
        trigger: "max_iterations",
        toolCallLog: patchThenTestPass,
        filesModified: ["/repo/src/foo.ts"],
        patchApplied: true,
      });
      expect(mockDebugLog).toHaveBeenCalledWith(
        "[zone-agent-verdict-inferred-from]",
        JSON.stringify({ inferredFrom: "heuristic", reason: "tests_passed", trigger: "max_iterations" })
      );
    });

    // inferredFrom is `tagged ? "tag" : "heuristic"` (deriveVerdict.ts) -- a function of
    // tagged alone, not of trigger. So this case (no tag, trigger:natural_completion) ALSO
    // records inferredFrom:"heuristic", even though reason here is the hardcoded literal
    // "no_verification_attempted", not the output of inferVerificationFromLog. There is no
    // third inferredFrom value -- the type is strictly "tag"|"heuristic" -- but the
    // "heuristic" label covers two different mechanisms. Pinned here so that distinction
    // stays visible in the marker's own payload (same inferredFrom, different reason from
    // the case above).
    it("emits inferredFrom:heuristic (hardcoded default, not the heuristic function) when no tag and trigger is natural_completion", () => {
      deriveVerdict({
        finalText: "No tag here",
        trigger: "natural_completion",
        toolCallLog: noLog,
        filesModified: [],
        patchApplied: false,
      });
      expect(mockDebugLog).toHaveBeenCalledWith(
        "[zone-agent-verdict-inferred-from]",
        JSON.stringify({ inferredFrom: "heuristic", reason: "no_verification_attempted", trigger: "natural_completion" })
      );
    });
  });
});
