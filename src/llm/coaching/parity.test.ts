/**
 * Parity lock-in tests: verify CoachingController produces identical behavior
 * to the old inline coaching block in agentLoop.ts.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../utils/logger.js", () => ({
  debugLog: vi.fn(),
  log: vi.fn(),
}));

import { CoachingController } from "./CoachingController.js";
import type { FailureContext, CoachingControllerOpts, CoachingDeps } from "./types.js";
import { log, debugLog } from "../../utils/logger.js";

const mockLog = log as Mock;
const mockDebugLog = debugLog as Mock;

function makeSignal(overrides?: Partial<FailureContext["signal"]>): FailureContext["signal"] {
  return {
    failureDetected: true,
    failedToolName: "apply_patch",
    failedToolOutput: "Error: patch failed",
    failedToolError: "patch failed",
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
    runId: "run-parity-1",
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<CoachingDeps>): CoachingDeps {
  return {
    detectRepeatedFailure: vi.fn().mockReturnValue(null),
    maybeGrantEscalationBonus: vi.fn().mockImplementation((state) => state),
    buildCoachingPrompt: vi.fn().mockReturnValue("coaching instructions"),
    buildVerifyDiagnostic: vi.fn().mockReturnValue({
      text: "## Diagnostic\nSome diagnostic text.",
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

beforeEach(() => vi.clearAllMocks());

describe("parity — noop path", () => {
  it("{kind:'noop'} when failureDetected=false, no side effects", () => {
    const escalatedFiles = new Set<string>();
    const deps = makeDeps();
    const ctrl = new CoachingController(makeOpts({ escalatedFiles }), deps);
    const result = ctrl.routeFailure(makeCtx({ signal: makeSignal({ failureDetected: false }) }));
    expect(result.kind).toBe("noop");
    expect(escalatedFiles.size).toBe(0);
    expect(deps.buildCoachingPrompt).not.toHaveBeenCalled();
    expect(deps.buildVerifyDiagnostic).not.toHaveBeenCalled();
    expect(ctrl.attempts).toBe(0);
  });
});

describe("parity — coach path", () => {
  it("coachingAppend contains verbatim format marker [Zone coaching — attempt 1 of N]", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const result = ctrl.routeFailure(makeCtx({ maxAttempts: 5 }));
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      expect(result.coachingAppend).toContain("[Zone coaching — attempt 1 of 5]");
    }
  });

  it("coachingAppend contains failure context block with tool name and error preview", () => {
    const errorOutput = "Error: FIND content not found in file";
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const result = ctrl.routeFailure(makeCtx({ signal: makeSignal({ failedToolOutput: errorOutput }) }));
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      expect(result.coachingAppend).toContain("Recent failure context:");
      expect(result.coachingAppend).toContain("- Tool: apply_patch");
      expect(result.coachingAppend).toContain("Error preview (first 300 chars):");
      expect(result.coachingAppend).toContain(errorOutput.slice(0, 300));
    }
  });

  it("coachingAppend contains retry-attempts-remaining counter", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const result = ctrl.routeFailure(makeCtx({ maxAttempts: 3 }));
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      // remaining = 3 - 1 = 2
      expect(result.coachingAppend).toContain("You have 2 retry attempts remaining.");
    }
  });
});

describe("parity — exhausted path", () => {
  it("{kind:'exhausted'} + budgetExhausted=true when budget hit", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const ctx = makeCtx({ maxAttempts: 1 });
    ctrl.routeFailure(ctx);
    const result = ctrl.routeFailure(ctx);
    expect(result.kind).toBe("exhausted");
    expect(ctrl.budgetExhausted).toBe(true);
  });

  it("debugLog emitted with willRetry:false when exhausted", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const ctx = makeCtx({ maxAttempts: 1 });
    ctrl.routeFailure(ctx);
    mockDebugLog.mockClear();
    ctrl.routeFailure(ctx);
    const calls = mockDebugLog.mock.calls;
    const selfCorrectCall = calls.find((c) => c[0] === "[zone-agent-self-correct]");
    expect(selfCorrectCall).toBeDefined();
    const payload = JSON.parse(selfCorrectCall![1]);
    expect(payload.willRetry).toBe(false);
  });
});

describe("parity — Pattern A: coachingAppend is a string, not a responseInput push", () => {
  it("controller does NOT push to any array — coachingAppend is returned as a string for the loop to apply", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    const result = ctrl.routeFailure(makeCtx());
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      // The controller returns a string — caller does Pattern A append
      expect(typeof result.coachingAppend).toBe("string");
      expect(result.coachingAppend.length).toBeGreaterThan(0);
    }
    // There's no responseInput in the controller — it never calls push
    // This is verified structurally: routeFailure takes FailureContext, which has no responseInput field
  });
});

describe("parity — scopeExpanded threading", () => {
  it("when expansion fires: diagnosticText includes scope notice AND scopeExpanded returned", () => {
    const deps = makeDeps({
      buildVerifyDiagnostic: vi.fn().mockReturnValue({
        text: "Base diagnostic.",
        generatedPathDetected: false,
        parsed: { failingFile: "src/bar.ts", failingLine: 42, errorType: "TypeError", affectedFiles: [] },
        candidates: [],
      }),
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
      // Scope notice is injected into diagnosticText which goes into coachingAppend
      expect(result.coachingAppend).toContain("Scope expanded");
      expect(result.coachingAppend).toContain("src/bar.ts");
      // scopeExpanded decision field also present
      expect(result.scopeExpanded).toEqual({ addedFile: "src/bar.ts", reason: "parsed_failing_file" });
    }
  });
});

describe("parity — emitCoachingRule for test_failed", () => {
  it("emitCoachingRule called with rule:test_failure_scope_check for test_failed trigger", () => {
    const deps = makeDeps({
      classifyFailure: vi.fn().mockReturnValue("test_failed"),
    });
    const ctrl = new CoachingController(makeOpts(), deps);
    ctrl.routeFailure(makeCtx({ signal: makeSignal({ failedToolName: "run_command" }) }));
    expect(deps.emitCoachingRule).toHaveBeenCalledWith(
      expect.objectContaining({ rule: "test_failure_scope_check" })
    );
  });
});

describe("parity — escalatedFiles.add called on repeat", () => {
  it("shared Set mutated with filePath when repeat detected", () => {
    const escalatedFiles = new Set<string>();
    const deps = makeDeps({
      detectRepeatedFailure: vi.fn().mockReturnValue({ filePath: "src/foo.ts", reason: "identical_patch_retried" }),
    });
    const ctrl = new CoachingController(makeOpts({ escalatedFiles }), deps);
    ctrl.routeFailure(makeCtx());
    expect(escalatedFiles.has("src/foo.ts")).toBe(true);
  });
});

describe("parity — newIterationBudget returned when escalation fires", () => {
  it("newIterationBudget present in decision when maybeGrantEscalationBonus returns new budget", () => {
    const grantedBudget = { maxIterationsForRun: 12, escalationBonusGranted: true };
    const deps = makeDeps({
      detectRepeatedFailure: vi.fn().mockReturnValue({ filePath: "src/foo.ts", reason: "identical_patch_retried" }),
      maybeGrantEscalationBonus: vi.fn().mockReturnValue(grantedBudget),
    });
    const ctrl = new CoachingController(makeOpts({ escalationEnabled: true }), deps);
    const result = ctrl.routeFailure(makeCtx());
    expect(result.kind).toBe("coach");
    if (result.kind === "coach") {
      expect(result.newIterationBudget).toEqual(grantedBudget);
    }
  });
});

describe("parity — attempts accumulates across routeFailure calls", () => {
  it("attempts counter increments on each coaching call", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    expect(ctrl.attempts).toBe(0);
    ctrl.routeFailure(makeCtx({ maxAttempts: 5 }));
    expect(ctrl.attempts).toBe(1);
    ctrl.routeFailure(makeCtx({ maxAttempts: 5 }));
    expect(ctrl.attempts).toBe(2);
    ctrl.routeFailure(makeCtx({ maxAttempts: 5 }));
    expect(ctrl.attempts).toBe(3);
  });
});

describe("parity — apply_patch JSONL log", () => {
  it("log([zone-apply-patch-retry], ...) called for apply_patch failure", () => {
    const ctrl = new CoachingController(makeOpts(), makeDeps());
    ctrl.routeFailure(makeCtx());
    expect(mockLog).toHaveBeenCalledWith(
      "[zone-apply-patch-retry]",
      expect.stringContaining('"event":"apply_patch_retry"')
    );
  });

  it("log([zone-apply-patch-retry], ...) NOT called for run_command failure", () => {
    const deps = makeDeps({ classifyFailure: vi.fn().mockReturnValue("test_failed") });
    const ctrl = new CoachingController(makeOpts(), deps);
    ctrl.routeFailure(makeCtx({ signal: makeSignal({ failedToolName: "run_command" }) }));
    expect(mockLog).not.toHaveBeenCalledWith("[zone-apply-patch-retry]", expect.anything());
  });
});
