import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../loopTelemetry.js", () => ({
  emitApplyRolledBackFeedback: vi.fn(),
  emitApplyRolledBackMarker: vi.fn(),
  emitVerifyWarnSurfaced: vi.fn(),
  emitAgentFinalAssessment: vi.fn(),
  emitCacheUsage: vi.fn(),
  emitTierConstraints: vi.fn(),
  emitCoachingRule: vi.fn(),
  emitCommandCacheSummary: vi.fn(),
  emitArchetype: vi.fn(),
  emitArchetypePromoted: vi.fn(),
}));

vi.mock("../verification/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../verification/index.js")>();
  return { ...actual, verifyAndFinalize: vi.fn() };
});

import { finalizeRun } from "./composer.js";
import { verifyAndFinalize } from "../verification/index.js";
import type { FinalizeRunInput } from "./types.js";
import type { VerifyOutcome } from "../verification/types.js";
import type { SubagentTokenUsage } from "../subagents.js";

const mockVerifyAndFinalize = verifyAndFinalize as Mock;

const EMPTY_TOKENS: SubagentTokenUsage = { input: 0, output: 0, cached: 0, total: 0 };

const APPLIED_OUTCOME: VerifyOutcome = {
  kind: "applied",
  verification: { label: "npm test", durationMs: 100, baselineErrorCount: 0, postErrorCount: 0 },
  filesFlushed: 1,
};

const SKIPPED_OUTCOME: VerifyOutcome = {
  kind: "skipped",
  reason: "no_staged_files",
};

const patchThenTestPass = [
  { id: "1", tool: "apply_patch", args: {}, result: "ok", success: true },
  { id: "2", tool: "run_command", args: {}, result: "10 passed, 0 failed", success: true },
];

const patchThenTestFail = [
  { id: "1", tool: "apply_patch", args: {}, result: "ok", success: true },
  { id: "2", tool: "run_command", args: {}, result: "1 failed", success: false },
  { id: "3", tool: "run_command", args: {}, result: "2 passed", success: true },
];

function makeEmit() {
  return {
    runBreakdownSummary: vi.fn(),
    cacheSummary: vi.fn(),
    selfValidationSummary: vi.fn(),
    webSearchSummary: vi.fn(),
  };
}

function makeInput(overrides: Partial<FinalizeRunInput>): FinalizeRunInput {
  return {
    trigger: "natural_completion",
    toolCallLog: [],
    filesModified: new Set(["/repo/src/foo.ts"]),
    stagingFiles: new Map([["src/foo.ts", "const x = 1;"]]),
    ownsStagingFiles: true,
    withStagingTempFlush: async <T>(_s: Map<string, string>, body: () => Promise<T>) => body(),
    verifyMode: "rollback",
    repoPath: "/repo",
    iterCount: 3,
    costUsd: 0.01,
    tokenUsage: EMPTY_TOKENS,
    emit: makeEmit(),
    ...overrides,
  };
}

describe("finalizeRun — parity tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyAndFinalize.mockResolvedValue(APPLIED_OUTCOME);
  });

  describe("natural_completion trigger", () => {
    it("returns success:true, terminationReason:natural_completion on applied outcome", async () => {
      const input = makeInput({
        trigger: "natural_completion",
        finalText: "All done. [ZONE_VERIFICATION: tests_passed]",
        toolCallLog: patchThenTestPass,
      });
      const result = await finalizeRun(input);
      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe("natural_completion");
      expect(result.filesModified).toEqual(["/repo/src/foo.ts"]);
      expect(result.discardedStaging).toBeUndefined();
    });

    it("readOnly sub-path: returns success:true, no_verification_attempted, no verifyAndFinalize call", async () => {
      const input = makeInput({
        trigger: "natural_completion",
        isReadOnlyMode: true,
        finalText: "Summary text",
      });
      const result = await finalizeRun(input);
      expect(result.success).toBe(true);
      expect(result.terminationReason).toBe("natural_completion");
      expect(result.verificationReason).toBe("no_verification_attempted");
      expect(result.filesModified).toEqual([]);
      expect(mockVerifyAndFinalize).not.toHaveBeenCalled();
    });
  });

  describe("max_iterations_readonly trigger", () => {
    it("returns success:false, terminationReason:max_iterations, no verifyAndFinalize call", async () => {
      const input = makeInput({
        trigger: "max_iterations_readonly",
        finalText: "Final summary",
        iterCount: 10,
      });
      const result = await finalizeRun(input);
      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe("max_iterations");
      expect(result.verificationReason).toBe("no_verification_attempted");
      expect(result.patchValidatedByAgent).toBe(false);
      expect(mockVerifyAndFinalize).not.toHaveBeenCalled();
    });
  });

  describe("max_iterations trigger", () => {
    it("returns success:false and patchValidatedByAgent derived from verdict", async () => {
      const input = makeInput({
        trigger: "max_iterations",
        finalText: "Done [ZONE_VERIFICATION: tests_passed]",
        toolCallLog: patchThenTestPass,
      });
      const result = await finalizeRun(input);
      expect(result.success).toBe(false);
      expect(result.patchValidatedByAgent).toBe(true);
    });

    it("@latent-bug: terminationReason is token_budget_exceeded at safety-ceiling max-iter exit", async () => {
      // @latent-bug — see audit §3 C1 risk callouts.
      // Real fix tracked separately as Gap 12 candidate / follow-up ticket.
      const input = makeInput({
        trigger: "max_iterations",
        finalText: "Max iterations hit",
        toolCallLog: patchThenTestPass,
      });
      const result = await finalizeRun(input);
      expect(result.terminationReason).toBe("token_budget_exceeded"); // NOT "max_iterations"
    });
  });

  describe("Bug 44b — tests_failed_unrelated promote-path", () => {
    it("promotes to tests_passed when validateUnrelatedClaim accepts with resolved-by-run_command reason", async () => {
      const input = makeInput({
        trigger: "natural_completion",
        finalText: "Done [ZONE_VERIFICATION: tests_failed_unrelated]",
        toolCallLog: patchThenTestFail,
        filesModified: new Set(["/repo/src/other.ts"]), // different file from any failing test
      });
      const result = await finalizeRun(input);
      expect(result.verificationReason).toBe("tests_passed");
    });
  });

  describe("applyNoInfraVerificationOverride", () => {
    it("overrides tests_inconclusive to tests_skipped_no_infra when framework has no tests", async () => {
      const input = makeInput({
        trigger: "natural_completion",
        finalText: "Done [ZONE_VERIFICATION: tests_inconclusive]",
        toolCallLog: [{ id: "1", tool: "apply_patch", args: {}, result: "ok", success: true }],
        framework: {
          language: "typescript" as const,
          testCommand: "",
          hasTests: false,
          testFilesDetected: false,
        },
      });
      const result = await finalizeRun(input);
      expect(result.verificationReason).toBe("tests_skipped_no_infra");
    });

    // Relies on this describe block's beforeEach default (mockVerifyAndFinalize
    // resolved to APPLIED_OUTCOME) rather than overriding it — that default is
    // what makes this reachable at all. A real single-entry no-op run never
    // produces outcome.kind:"applied": finalizeStaging's allUnchanged check
    // (verification/staging.ts) would take the no_change branch first, and
    // deriveResultFields hardcodes verificationReason:"no_changes_made" for
    // that outcome kind regardless of what the verdict computed. This fixture
    // exists to observe the pre-mask verdict, which production masks here.
    it("item 12: an apply_patch no-op (empty filesStaged) leaves the override's patchApplied gate closed, so the tagged reason is not upgraded", async () => {
      const input = makeInput({
        trigger: "natural_completion",
        finalText: "Done [ZONE_VERIFICATION: tests_inconclusive]",
        toolCallLog: [
          { id: "1", tool: "apply_patch", args: {}, result: "ok", success: true, filesStaged: [] },
        ],
        framework: {
          language: "typescript" as const,
          testCommand: "",
          hasTests: false,
          testFilesDetected: false,
        },
      });
      const result = await finalizeRun(input);
      expect(result.verificationReason).toBe("tests_inconclusive");
    });
  });

  describe("discardedStaging threading", () => {
    it("populates result.discardedStaging on rolled_back outcome", async () => {
      const discarded = new Map([["src/foo.ts", "broken content"]]);
      mockVerifyAndFinalize.mockResolvedValue({
        kind: "rolled_back",
        verification: { label: "npm test", durationMs: 200, baselineErrorCount: 0, postErrorCount: 2 },
        restoredFiles: ["/repo/src/foo.ts"],
        errors: [{ file: "src/foo.ts", line: 1, message: "error", context: "" }],
        appendix: "\n[rolled back]",
        discardedStaging: discarded,
      } satisfies VerifyOutcome);

      const input = makeInput({
        trigger: "natural_completion",
        finalText: "Done [ZONE_VERIFICATION: tests_passed]",
        toolCallLog: patchThenTestPass,
      });
      const result = await finalizeRun(input);
      expect(result.discardedStaging).toBe(discarded);
      expect(result.verificationReason).toBe("verification_regressed");
    });

    it("discardedStaging absent on applied outcome", async () => {
      const input = makeInput({
        trigger: "natural_completion",
        finalText: "Done [ZONE_VERIFICATION: tests_passed]",
        toolCallLog: patchThenTestPass,
      });
      const result = await finalizeRun(input);
      expect(result.discardedStaging).toBeUndefined();
    });
  });

  describe("emit.webSearchSummary called on all terminal paths", () => {
    it("natural_completion (readOnly): calls webSearchSummary", async () => {
      const input = makeInput({ trigger: "natural_completion", isReadOnlyMode: true, finalText: "x" });
      await finalizeRun(input);
      expect((input.emit as ReturnType<typeof makeEmit>).webSearchSummary).toHaveBeenCalledOnce();
    });

    it("max_iterations_readonly: calls webSearchSummary", async () => {
      const input = makeInput({ trigger: "max_iterations_readonly", finalText: "x" });
      await finalizeRun(input);
      expect((input.emit as ReturnType<typeof makeEmit>).webSearchSummary).toHaveBeenCalledOnce();
    });

    it("natural_completion (non-readOnly): calls webSearchSummary", async () => {
      const input = makeInput({
        trigger: "natural_completion",
        finalText: "x [ZONE_VERIFICATION: tests_passed]",
        toolCallLog: patchThenTestPass,
      });
      await finalizeRun(input);
      expect((input.emit as ReturnType<typeof makeEmit>).webSearchSummary).toHaveBeenCalledOnce();
    });

    it("max_iterations (non-readOnly): calls webSearchSummary", async () => {
      const input = makeInput({
        trigger: "max_iterations",
        finalText: "x [ZONE_VERIFICATION: tests_passed]",
        toolCallLog: patchThenTestPass,
      });
      await finalizeRun(input);
      expect((input.emit as ReturnType<typeof makeEmit>).webSearchSummary).toHaveBeenCalledOnce();
    });
  });

  describe("FIX 2 — success coupled to verification verdict", () => {
    it("natural_completion + applied_with_warnings → success:false (RED tree must not succeed)", async () => {
      mockVerifyAndFinalize.mockResolvedValue({
        kind: "applied_with_warnings",
        verification: { label: "tsc", durationMs: 120, baselineErrorCount: 0, postErrorCount: 3 },
        appendix: "\n\nVERIFICATION WARNINGS — patches applied, new errors detected.",
        errors: [{ code: "TS18047", message: "Object is possibly null." }],
        filesFlushed: 1,
      } satisfies VerifyOutcome);

      const result = await finalizeRun(makeInput({
        trigger: "natural_completion",
        finalText: "done [ZONE_VERIFICATION: tests_passed]",
        toolCallLog: patchThenTestPass,
      }));
      expect(result.success).toBe(false);
      expect(result.terminationReason).toBe("natural_completion");
    });

    it("natural_completion + applied (clean) → success:true (unchanged)", async () => {
      mockVerifyAndFinalize.mockResolvedValue(APPLIED_OUTCOME);
      const result = await finalizeRun(makeInput({
        trigger: "natural_completion",
        finalText: "done [ZONE_VERIFICATION: tests_passed]",
        toolCallLog: patchThenTestPass,
      }));
      expect(result.success).toBe(true);
    });

    it("natural_completion + pre_existing_errors → success:true (pre-existing is not a regression)", async () => {
      mockVerifyAndFinalize.mockResolvedValue({
        kind: "pre_existing_errors",
        verification: { label: "tsc", durationMs: 100, baselineErrorCount: 3, postErrorCount: 3 },
        appendix: "\n\n**Verification has pre-existing errors**",
        filesFlushed: 1,
      } satisfies VerifyOutcome);

      const result = await finalizeRun(makeInput({
        trigger: "natural_completion",
        finalText: "done",
        toolCallLog: patchThenTestPass,
      }));
      expect(result.success).toBe(true);
    });

    it("max_iterations + applied_with_warnings → success:false (unchanged — trigger wins)", async () => {
      mockVerifyAndFinalize.mockResolvedValue({
        kind: "applied_with_warnings",
        verification: { label: "tsc", durationMs: 120, baselineErrorCount: 0, postErrorCount: 1 },
        appendix: "\n\nVERIFICATION WARNINGS",
        errors: [{ code: "TS2304", message: "Cannot find name 'x'." }],
        filesFlushed: 1,
      } satisfies VerifyOutcome);

      const result = await finalizeRun(makeInput({
        trigger: "max_iterations",
        finalText: "done",
        toolCallLog: [],
      }));
      expect(result.success).toBe(false);
    });
  });

  describe("latent naming inconsistencies preserved (Gap 12)", () => {
    it("max_iterations: emitApplyRolledBackMarker uses site:max_iter (not max_iterations)", async () => {
      const { emitApplyRolledBackMarker } = await import("../loopTelemetry.js");
      const mockMarker = emitApplyRolledBackMarker as Mock;

      mockVerifyAndFinalize.mockResolvedValue({
        kind: "rolled_back",
        verification: { label: "npm test", durationMs: 100, baselineErrorCount: 0, postErrorCount: 1 },
        restoredFiles: ["/repo/src/foo.ts"],
        errors: [{ file: "src/foo.ts", line: 1, message: "e", context: "" }],
        appendix: "\n[rolled back]",
        discardedStaging: new Map(),
      } satisfies VerifyOutcome);

      await finalizeRun(makeInput({
        trigger: "max_iterations",
        finalText: "Done [ZONE_VERIFICATION: tests_passed]",
        toolCallLog: patchThenTestPass,
      }));

      expect(mockMarker).toHaveBeenCalledWith(expect.objectContaining({ site: "max_iter" }));
    });

    it("max_iterations: emitVerifyWarnSurfaced uses site:token_budget_exceeded", async () => {
      const { emitVerifyWarnSurfaced } = await import("../loopTelemetry.js");
      const mockWarn = emitVerifyWarnSurfaced as Mock;

      mockVerifyAndFinalize.mockResolvedValue({
        kind: "applied_with_warnings",
        verification: { label: "npm test", durationMs: 100, baselineErrorCount: 0, postErrorCount: 1 },
        appendix: "\n[warnings]",
        errors: [{ file: "src/foo.ts", line: 1, message: "w", context: "" }],
        filesFlushed: 1,
      } satisfies VerifyOutcome);

      await finalizeRun(makeInput({
        trigger: "max_iterations",
        finalText: "Done",
        toolCallLog: [],
      }));

      expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ site: "token_budget_exceeded" }));
    });
  });
});
