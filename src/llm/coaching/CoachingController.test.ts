import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  debugLog: vi.fn(),
  log: vi.fn(),
}));

import { CoachingController } from "./CoachingController.js";
import type { FailureContext, CoachingControllerOpts, CoachingDeps } from "./types.js";
import { log } from "../../utils/logger.js";

const mockLog = log as Mock;

function makeSignal(overrides?: Partial<FailureContext["signal"]>): FailureContext["signal"] {
  return {
    failureDetected: true,
    failedToolName: "apply_patch",
    failedToolOutput: "Error: patch rejected",
    failedToolError: "patch rejected",
    failedToolFilePath: "src/foo.ts",
    failedFilesThisIter: new Set(["src/foo.ts"]),
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<FailureContext>): FailureContext {
  return {
    signal: makeSignal(),
    iter: 0,
    failureHistory: new Map(),
    toolCallLog: [],
    filesModified: new Set(),
    currentBudget: { maxIterationsForRun: 8, escalationBonusGranted: false },
    maxAttempts: 3,
    ...overrides,
  };
}

function makeOpts(overrides?: Partial<CoachingControllerOpts>): CoachingControllerOpts {
  return {
    escalationEnabled: false,
    baseMaxIterations: 8,
    escalatedFiles: new Set(),
    runId: "run-test-1",
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<CoachingDeps>): CoachingDeps {
  return {
    detectRepeatedFailure: vi.fn().mockReturnValue(null),
    maybeGrantEscalationBonus: vi.fn().mockImplementation((state) => state),
    buildCoachingPrompt: vi.fn().mockReturnValue("coaching text"),
    buildVerifyDiagnostic: vi.fn().mockReturnValue({
      text: "diagnostic text",
      generatedPathDetected: false,
      parsed: null,
      candidates: [],
    }),
    maybeExpandScopeForVerifyDiagnostic: vi.fn().mockReturnValue({
      expanded: false,
      addedFile: null,
      reason: "no_plan",
    }),
    applyPatchRetryReason: vi.fn().mockReturnValue("find_mismatch"),
    classifyFailure: vi.fn().mockReturnValue("apply_patch_find_not_found"),
    emitCoachingRule: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CoachingController — noop paths", () => {
  it("returns {kind:'noop'} when failureDetected=false", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const result = ctrl.routeFailure(makeCtx({ signal: makeSignal({ failureDetected: false }) }));
    expect(result.kind).toBe("noop");
  });

  it("does not increment attempts on noop", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    ctrl.routeFailure(makeCtx({ signal: makeSignal({ failureDetected: false }) }));
    expect(ctrl.attempts).toBe(0);
  });
});

describe("CoachingController — coach branch", () => {
  it("returns {kind:'coach'} with non-empty coachingAppend on first failure", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const result = ctrl.routeFailure(makeCtx());
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      expect(result.coachingAppend).toBeTruthy();
      expect(typeof result.coachingAppend).toBe("string");
    }
  });

  it("increments attempts to 1 after first coaching call", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    ctrl.routeFailure(makeCtx());
    expect(ctrl.attempts).toBe(1);
  });

  it("increments attempts across multiple calls", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    ctrl.routeFailure(makeCtx());
    ctrl.routeFailure(makeCtx());
    expect(ctrl.attempts).toBe(2);
  });

  it("coachingAppend contains attempt/max counter format", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const result = ctrl.routeFailure(makeCtx({ maxAttempts: 5 }));
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      expect(result.coachingAppend).toContain("attempt 1 of 5");
    }
  });

  it("coachingAppend contains error preview (first 300 chars of failedToolOutput)", () => {
    const errorOutput = "x".repeat(400);
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const result = ctrl.routeFailure(makeCtx({ signal: makeSignal({ failedToolOutput: errorOutput }) }));
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      expect(result.coachingAppend).toContain(errorOutput.slice(0, 300));
      expect(result.coachingAppend).not.toContain(errorOutput.slice(0, 400));
    }
  });

  it("emitCoachingRule is called for test_failed trigger (run_command failure)", () => {
    const deps = makeDeps({
      classifyFailure: vi.fn().mockReturnValue("test_failed"),
    });
    const ctrl = new CoachingController(makeOpts(), deps);
    ctrl.routeFailure(makeCtx({ signal: makeSignal({ failedToolName: "run_command" }) }));
    expect(deps.emitCoachingRule).toHaveBeenCalledWith(
      expect.objectContaining({ rule: "test_failure_scope_check" })
    );
  });

  it("emitCoachingRule is called for tool_command_spawn_failure trigger", () => {
    const deps = makeDeps({
      classifyFailure: vi.fn().mockReturnValue("tool_command_spawn_failure"),
    });
    const ctrl = new CoachingController(makeOpts(), deps);
    ctrl.routeFailure(makeCtx({ signal: makeSignal({ failedToolName: "run_command" }) }));
    expect(deps.emitCoachingRule).toHaveBeenCalled();
  });

  it("emitCoachingRule NOT called for apply_patch_find_not_found trigger", () => {
    const deps = makeDeps({
      classifyFailure: vi.fn().mockReturnValue("apply_patch_find_not_found"),
    });
    const ctrl = new CoachingController(makeOpts(), deps);
    ctrl.routeFailure(makeCtx());
    expect(deps.emitCoachingRule).not.toHaveBeenCalled();
  });

  it("adds to escalatedFiles and returns repeat trigger on repeat failure", () => {
    const escalatedFiles = new Set<string>();
    const opts = makeOpts({ escalatedFiles });
    const deps = makeDeps({
      detectRepeatedFailure: vi.fn().mockReturnValue({ filePath: "src/foo.ts", reason: "identical_patch_retried" }),
    });
    const ctrl = new CoachingController(opts, deps);
    ctrl.routeFailure(makeCtx());
    expect(escalatedFiles.has("src/foo.ts")).toBe(true);
  });

  it("returns newIterationBudget in decision when escalationEnabled and bonus fires", () => {
    const newBudget = { maxIterationsForRun: 12, escalationBonusGranted: true };
    const escalatedFiles = new Set<string>();
    const deps = makeDeps({
      detectRepeatedFailure: vi.fn().mockReturnValue({ filePath: "src/foo.ts", reason: "identical_patch_retried" }),
      maybeGrantEscalationBonus: vi.fn().mockReturnValue(newBudget),
    });
    const ctrl = new CoachingController(makeOpts({ escalationEnabled: true, escalatedFiles }), deps);
    const result = ctrl.routeFailure(makeCtx());
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      expect(result.newIterationBudget).toEqual(newBudget);
    }
  });

  it("returns scopeExpanded in decision when expansion fires", () => {
    const deps = makeDeps({
      maybeExpandScopeForVerifyDiagnostic: vi.fn().mockReturnValue({
        expanded: true,
        addedFile: "src/bar.ts",
        reason: "parsed_failing_file",
      }),
    });
    const ctrl = new CoachingController(makeOpts(), deps);
    const result = ctrl.routeFailure(makeCtx());
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      expect(result.scopeExpanded).toEqual({ addedFile: "src/bar.ts", reason: "parsed_failing_file" });
    }
  });

  it("emits [zone-apply-patch-retry] JSONL log for apply_patch failure", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    ctrl.routeFailure(makeCtx());
    expect(mockLog).toHaveBeenCalledWith(
      "[zone-apply-patch-retry]",
      expect.stringContaining("apply_patch_retry")
    );
  });

  it("does NOT emit [zone-apply-patch-retry] for run_command failure", () => {
    const deps = makeDeps({ classifyFailure: vi.fn().mockReturnValue("test_failed") });
    const ctrl = new CoachingController(makeOpts(), deps);
    ctrl.routeFailure(makeCtx({ signal: makeSignal({ failedToolName: "run_command" }) }));
    expect(mockLog).not.toHaveBeenCalledWith("[zone-apply-patch-retry]", expect.anything());
  });
});

describe("CoachingController — exhausted branch", () => {
  it("returns {kind:'exhausted'} when attempts >= maxAttempts", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const ctx = makeCtx({ maxAttempts: 1 });
    ctrl.routeFailure(ctx);
    const result = ctrl.routeFailure(ctx);
    expect(result.kind).toBe("exhausted");
  });

  it("sets budgetExhausted=true when exhausted", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const ctx = makeCtx({ maxAttempts: 1 });
    ctrl.routeFailure(ctx);
    ctrl.routeFailure(ctx);
    expect(ctrl.budgetExhausted).toBe(true);
  });

  it("budgetExhausted stays false while still in budget", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    ctrl.routeFailure(makeCtx({ maxAttempts: 3 }));
    expect(ctrl.budgetExhausted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B.2: repeat-read counter integration (Phase 6.A Branch B)
// ---------------------------------------------------------------------------

describe("repeat-read counter integration (Phase 6.A Branch B)", () => {
  it("T.5: coachingAppend includes file path when read count >= 3", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const filesReadCountThisRun = new Map([["src/foo.ts", 3]]);
    const result = ctrl.routeFailure(makeCtx({ filesReadCountThisRun }));
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      expect(result.coachingAppend).toContain("src/foo.ts");
      expect(result.coachingAppend).toContain("read 3x");
    }
  });

  it("T.6: no repeat-read notice when all files read fewer than 3 times", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const filesReadCountThisRun = new Map([
      ["src/a.ts", 1],
      ["src/b.ts", 2],
      ["src/c.ts", 1],
    ]);
    const result = ctrl.routeFailure(makeCtx({ filesReadCountThisRun }));
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      expect(result.coachingAppend).not.toContain("re-read the following files many times");
    }
  });

  it("T.7: no repeat-read notice when filesReadCountThisRun is absent (backward compat)", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    // No filesReadCountThisRun in ctx (optional field absent)
    const result = ctrl.routeFailure(makeCtx());
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      expect(result.coachingAppend).not.toContain("re-read the following files many times");
    }
  });
});
