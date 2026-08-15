import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../types/project.js";

/**
 * runLlmPatchFlow.ts:5927 re-classifies the raw task string for the execution
 * phase. When the classifier returns investigation/question — the two
 * archetypes with readOnlyPipeline:true — the run gets a read-only capability
 * filter regardless of the plan the user already approved (diagnosed on run
 * d31ead23: accept_all, mode:"patch", toolSubsetSize 5, nothing written).
 *
 * These tests exercise the suppression guard added at that site. runAgentLoop
 * is mocked in this file's harness (see setupRunLlmPatchFlowMocks below), so
 * agentLoop.ts's own body never runs here — including the
 * [zone-readonly-pipeline-suppressed]/[zone-readonly-suppression-mismatch]
 * telemetry, which moved to agentLoop.ts's runAgentLoopScoped (it needs the
 * assembled system prompt to report the branch that actually fired, which
 * doesn't exist yet at this layer). What IS observable here, and what this
 * file tests, is the two fields this site threads onto the object passed to
 * runAgentLoop: whether capabilityFilter is present, and whether
 * readOnlyPipelineSuppressed is set — the signal the telemetry now reads.
 * The telemetry's own outcome-based assertions live in
 * agentLoop.readOnlySuppressionTelemetry.test.ts, against the real function.
 */

const scanRepoMock = vi.fn();
const detectProjectStructureMock = vi.fn();
const rankRelevantFilesMock = vi.fn();
const readProjectFilesMock = vi.fn();
const planPatchPreviewWithLlmMock = vi.fn();
const runRuntimeVerificationPlanMock = vi.fn();
const runAgentLoopMock = vi.fn();
const classifyTaskMock = vi.fn();

vi.mock("../repo/scanRepo.js", () => ({ scanRepo: scanRepoMock }));
vi.mock("../repo/detectProjectStructure.js", () => ({ detectProjectStructure: detectProjectStructureMock }));
vi.mock("../repo/rankRelevantFiles.js", () => ({ rankRelevantFiles: rankRelevantFilesMock }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: readProjectFilesMock }));
vi.mock("../llm/planPatchPreview.js", () => ({ planPatchPreviewWithLlm: planPatchPreviewWithLlmMock }));
// Only generateExecutionPlan is overridden — isAnswerOnlyPlan must stay real. 8 of the 9 tests
// below supply preGeneratedPlan, which sets the local executionPlan var via a DIFFERENT branch
// (runLlmPatchFlow.ts's `if (input.preGeneratedPlan)`) and never calls generateExecutionPlan at
// all; those 8 still reach isAnswerOnlyPlan(executionPlan) on that real, supplied plan (:5687,
// :5954). A full-replace mock (only generateExecutionPlan, no ...actual) would leave
// isAnswerOnlyPlan undefined for all 9 tests and crash the 8 that reach it. Only the 9th test
// ("no approved plan") reaches generateExecutionPlan itself, and mocking it to throw stops that
// one real outbound Anthropic call (root cause of a CI-only timeout) without touching the other 8.
vi.mock("../llm/executionPlan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/executionPlan.js")>();
  return {
    ...actual,
    generateExecutionPlan: vi.fn(async () => { throw new Error("skip"); }),
  };
});
vi.mock("./runRuntimeVerification.js", () => ({ runRuntimeVerificationPlan: runRuntimeVerificationPlanMock }));
vi.mock("../llm/agentLoop.js", () => ({
  runAgentLoop: runAgentLoopMock,
  stripVerificationTag: vi.fn((s: string) => s),
}));
vi.mock("../llm/taskClassifier.js", () => ({
  classifyTask: classifyTaskMock,
  CLASSIFIER_CONFIDENCE_THRESHOLD: 0.5,
}));

function buildRepoFile(path: string, category: RepoFile["category"] = "unknown"): RepoFile {
  return { path, absolutePath: `C:/repo/${path}`, extension: path.split(".").pop() ?? "", category };
}

const REPO_FILES = [buildRepoFile("src/index.ts", "source")];

const APPROVED_PLAN = {
  objective: "Add a helper",
  steps: [
    { title: "Add helper", description: "Add a small helper function.", filesLikely: ["src/utils/foo.ts"] },
  ],
  scopeSummary: "Add a helper",
  riskHints: [],
};

const STEPLESS_PLAN = {
  objective: "Check the build",
  steps: [],
  scopeSummary: "Check the build",
  riskHints: [],
  noChangeReason: "Build already exits 0 — the asserted bug does not reproduce.",
};

/** Same steps:[] shape as STEPLESS_PLAN, but answer-shaped (C6) — the iter
 *  budget must come from ANSWER_ONLY_ITER_BUDGET (8), not
 *  computeWorkerMaxIterations's 0→1 coercion (6), so this needs a genuinely
 *  distinct value to prove the new branch fired rather than coincidentally
 *  matching the old one. */
const ANSWER_ONLY_PLAN = {
  objective: "Explain the marker sink",
  steps: [],
  scopeSummary: "Explain the marker sink",
  riskHints: [],
  answerOnlyReason: "The task is a question; nothing needs to change.",
};

function classification(archetype: "investigation" | "question" | "simple_add" | "targeted_fix") {
  return {
    tier: "medium" as const,
    archetype,
    confidence: 0.9,
    archetypeConfidence: 0.9,
    fallbackUsed: false,
  };
}

// Item 166 stage one. Same shape as APPROVED_PLAN, plus requestedTools — a real,
// non-empty steps plan so it flows the normal success path (not noChange/answerOnly).
function planWithRequestedTools(requestedTools: string[]) {
  return { ...APPROVED_PLAN, requestedTools };
}

// Item 166 stage two. A step carrying the plan's own delegation mark — real ExecutionPlan
// step shape, not a partial. filesLikely defaults to a single path unless overridden, since
// most marked-step fixtures below care about the mark/type/count triple, not the path itself.
function markedStep(
  filesLikely: string[],
  subagentType: "worker" | "explore" = "worker"
): (typeof APPROVED_PLAN)["steps"][number] & { subagentEligible: true; subagentType: "worker" | "explore" } {
  return { title: "step", description: "d", filesLikely, subagentEligible: true, subagentType };
}

// Same non-empty-steps shape as planWithRequestedTools, but the steps carry the plan's own
// delegation marks instead of (or alongside) an explicit requestedTools entry.
function planWithMarkedSteps(
  steps: Array<ReturnType<typeof markedStep> | { title: string; description: string; filesLikely: string[] }>,
  requestedTools?: string[]
) {
  return {
    ...APPROVED_PLAN,
    steps,
    ...(requestedTools ? { requestedTools } : {}),
  };
}

beforeEach(() => {
  delete process.env["ZONE_FORCE_FLOW"];
  vi.clearAllMocks();
  runRuntimeVerificationPlanMock.mockResolvedValue({
    attempted: false,
    status: "skipped_no_command",
    steps: [],
    summary: "No safe verification command detected.",
  });
  runAgentLoopMock.mockResolvedValue({
    success: true,
    summary: "mock agent loop",
    toolCallLog: [],
    filesModified: [],
    patchValidatedByAgent: false,
    verificationReason: "tests_inconclusive",
    terminationReason: "natural_completion",
    iterCount: 1,
    promotedFromArchetype: null,
    promotionTrigger: null,
    promotedAtIter: null,
  });
  scanRepoMock.mockResolvedValue(REPO_FILES);
  detectProjectStructureMock.mockReturnValue({ notes: ["Node.js"] });
  rankRelevantFilesMock.mockReturnValue([{ ...REPO_FILES[0]!, score: 10 }]);
  readProjectFilesMock.mockResolvedValue({});
  planPatchPreviewWithLlmMock.mockResolvedValue({ patches: [] });
});

afterEach(() => {
  delete process.env["ZONE_FORCE_FLOW"];
});

async function runWith(opts: {
  archetype: "investigation" | "question" | "simple_add" | "targeted_fix";
  preGeneratedPlan?:
    | typeof APPROVED_PLAN
    | typeof STEPLESS_PLAN
    | typeof ANSWER_ONLY_PLAN
    | ReturnType<typeof planWithRequestedTools>
    | ReturnType<typeof planWithMarkedSteps>;
  runId: string;
}) {
  classifyTaskMock.mockResolvedValue(classification(opts.archetype));
  const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
  await runLlmPatchFlow({
    task: "trace how a tool result reaches the message history",
    repoPath: "/tmp/fake-repo",
    runId: opts.runId,
    onProgress: () => undefined,
    abortSignal: new AbortController().signal,
    userApiKey: "sk-fake",
    provider: "anthropic",
    mode: "patch",
    ...(opts.preGeneratedPlan ? { preGeneratedPlan: opts.preGeneratedPlan } : {}),
  });
  return runAgentLoopMock.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
}

describe("read-only pipeline suppression when an approved plan justifies writing", () => {
  it("investigation + approved plan with steps → capabilityFilter suppressed, readOnlyPipelineSuppressed threaded", async () => {
    const call = await runWith({ archetype: "investigation", preGeneratedPlan: APPROVED_PLAN, runId: "run-inv-1" });

    expect(call?.capabilityFilter).toBeUndefined();
    expect(call?.readOnlyPipelineSuppressed).toBe(true);
    // Contrast partner to the stepless case below: 1 step and 0 steps both land on
    // WORKER_ITER_FLOOR, so this VALUE cannot distinguish "one thing to do" from
    // "nothing to do" (computeWorkerMaxIterations coerces 0 via `|| 1`, subagents.ts:46).
    //
    // R3: 6 is the argument passed, NOT the loop's bound. `maxIterations` is discarded
    // by agentLoop.ts:2292-2296 and never restored, so the run is really bounded at
    // softIterWarn*3 (75 at medium). This assertion pins the call-site contract and
    // says nothing about behavior — do not read it as "this run gets 6 iterations".
    expect(call?.planApproved).toBe(true);
    expect(call?.maxIterations).toBe(6);
  });

  it("question + approved plan with steps → capabilityFilter suppressed, readOnlyPipelineSuppressed threaded", async () => {
    const call = await runWith({ archetype: "question", preGeneratedPlan: APPROVED_PLAN, runId: "run-q-1" });

    expect(call?.capabilityFilter).toBeUndefined();
    expect(call?.readOnlyPipelineSuppressed).toBe(true);
  });

  it("investigation + approved but stepless plan (noChangeReason) → stays read-only, readOnlyPipelineSuppressed not set", async () => {
    const call = await runWith({ archetype: "investigation", preGeneratedPlan: STEPLESS_PLAN, runId: "run-inv-2" });

    expect(call?.capabilityFilter).toBeDefined();
    expect(call?.readOnlyPipelineSuppressed).not.toBe(true);
    // hasApprovedSteps (runLlmPatchFlow.ts:5917) is a local const with no observable
    // value; these two fields are the only places its `false` surfaces. Asserting both
    // is what makes the stepless branch measured rather than read.
    expect(call?.planApproved).toBe(false);
    // 0 steps → WORKER_ITER_FLOOR, not 0: `planStepsCount || 1` (subagents.ts:46) coerces
    // 0 to 1 before the floor applies, so a plan declaring nothing to do still asks for 6.
    // R3, as above: this pins the argument, not the bound — agentLoop.ts:2292-2296
    // discards it. A noChangeReason plan still routes through `maxIterations`; only the
    // answer-only shape moved to maxIterationsOverride.
    expect(call?.maxIterations).toBe(6);
  });

  it("investigation + no approved plan → unchanged, stays read-only, readOnlyPipelineSuppressed not set", async () => {
    const call = await runWith({ archetype: "investigation", runId: "run-inv-3" });

    expect(call?.capabilityFilter).toBeDefined();
    expect(call?.readOnlyPipelineSuppressed).not.toBe(true);
  });

  it("investigation + answer-only plan → the budget routes through maxIterationsOverride, the only field that actually binds", async () => {
    const call = await runWith({ archetype: "investigation", preGeneratedPlan: ANSWER_ONLY_PLAN, runId: "run-inv-4" });

    // ANSWER_ONLY_ITER_BUDGET, on the field that survives the tier block. Probed
    // directly against the real loop: maxIterationsOverride:1 bounds at 1 iteration,
    // maxIterations:1 ran 75 — see agentLoop.terminationReasonProbe.test.ts.
    expect(call?.maxIterationsOverride).toBe(8);
    // The contrast that makes the assertion above about ROUTING rather than value:
    // if the budget were still on `maxIterations`, both could hold 8 and this test
    // would pass while the loop stayed bounded at softIterWarn*3.
    expect(call?.maxIterations).toBeUndefined();
  });

  it("answer-only + a TIGHTER archetype cap → the archetype cap wins, not the answer-only budget", async () => {
    // `question` carries iterCap 3 (archetypeDispatcher.ts:58) — below
    // ANSWER_ONLY_ITER_BUDGET, and the archetype an answer-only plan most often gets.
    // Both budgets land on the same field, so whichever is written last would win on
    // key order alone; the clamp is what makes the outcome a decision rather than an
    // ordering accident. Without it this reads 8 and silently relaxes a tighter cap.
    const call = await runWith({ archetype: "question", preGeneratedPlan: ANSWER_ONLY_PLAN, runId: "run-q-answer" });

    expect(call?.maxIterationsOverride).toBe(3);
  });
});

/**
 * [zone-answer-only-budget-exhausted] (C6) — reuses this file's harness
 * rather than a new one: runAgentLoopMock is already fully controllable here
 * and preGeneratedPlan wiring is already exercised above. log() is not
 * mocked at module level in this file (an unmocked call falls through to
 * real console.log), so these tests spy on console.log locally instead of
 * widening the file's module mocks.
 */
describe("answer-only budget exhaustion marker (C6)", () => {
  function findMarkerCall(logSpy: ReturnType<typeof vi.spyOn>) {
    return logSpy.mock.calls.find((c) => c[0] === "[zone-answer-only-budget-exhausted]");
  }

  it("fires with iterBudget:8 when an answer-only plan's run hits token_budget_exceeded", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runAgentLoopMock.mockResolvedValue({
      success: false,
      summary: "",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "tests_inconclusive",
      terminationReason: "token_budget_exceeded",
      iterCount: 8,
      promotedFromArchetype: null,
      promotionTrigger: null,
      promotedAtIter: null,
    });

    await runWith({ archetype: "investigation", preGeneratedPlan: ANSWER_ONLY_PLAN, runId: "run-answer-exhausted" });

    const markerCall = findMarkerCall(logSpy);
    expect(markerCall).toBeDefined();
    // Both numbers: the nominal budget AND what the loop actually ran. The mocked
    // loop reports iterCount 8 here, but the two can legitimately differ (a tier whose
    // softIterWarn*3 is below 8 fails the `< current` guard at agentLoop.ts:2364-2367
    // and leaves the run bounded lower), which is exactly why the observed value is
    // recorded rather than inferred from the constant.
    expect(JSON.parse(markerCall![1] as string)).toMatchObject({ iterBudget: 8, observedIterCount: 8 });

    logSpy.mockRestore();
  });

  it("does not fire when the run terminates via natural_completion", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runAgentLoopMock.mockResolvedValue({
      success: true,
      summary: "The build passes; nothing needs to change.",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "tests_inconclusive",
      terminationReason: "natural_completion",
      iterCount: 3,
      promotedFromArchetype: null,
      promotionTrigger: null,
      promotedAtIter: null,
    });

    await runWith({ archetype: "investigation", preGeneratedPlan: ANSWER_ONLY_PLAN, runId: "run-answer-ok" });

    expect(findMarkerCall(logSpy)).toBeUndefined();

    logSpy.mockRestore();
  });

  it("does not fire for a non-answer stepless plan even at token_budget_exceeded — the marker is answer-shape-specific, not a general iter-cap marker", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    runAgentLoopMock.mockResolvedValue({
      success: false,
      summary: "",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "tests_inconclusive",
      terminationReason: "token_budget_exceeded",
      iterCount: 6,
      promotedFromArchetype: null,
      promotionTrigger: null,
      promotedAtIter: null,
    });

    await runWith({ archetype: "investigation", preGeneratedPlan: STEPLESS_PLAN, runId: "run-stepless-exhausted" });

    expect(findMarkerCall(logSpy)).toBeUndefined();

    logSpy.mockRestore();
  });
});

// Item 166 stage one. simple_add is the one archetype (of the five PipelineConfig
// literals) with a real, non-trivial, always non-empty excludeToolNames
// ({Task, suggest_scope_change}) — established by running
// buildDispatcherCapabilityFilter against all five before this test was written.
// investigation/question both hit the suppression branch above whenever a plan
// has real steps, clearing capabilityFilter to undefined before this feature's
// grant logic would ever see it — not useful fixtures for a live grant test.
describe("item 166 stage one — requestedTools grant, live through runLlmPatchFlow", () => {
  beforeEach(() => {
    process.env["ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD"] = "1";
  });
  afterEach(() => {
    delete process.env["ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD"];
  });

  it("byte-identity regression pin: no requestedTools on the plan → filter shape unaffected AND the grant block does not run at all", async () => {
    // Content-equality on the filter alone is not sufficient here: applyRequestedToolsGrant
    // already no-ops gracefully on an empty array (same reference, same content) regardless
    // of whether the CALLER'S guard fires — a mutation that removes that guard changes real,
    // observable behaviour (the grant call happens, telemetry fires with an empty payload)
    // without changing the filter's content. Caught only by asserting the marker's absence,
    // not by asserting the filter's shape alone (found by actually running this mutation
    // before finalizing this test, not assumed).
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const call = await runWith({ archetype: "simple_add", preGeneratedPlan: APPROVED_PLAN, runId: "run-sa-noreq" });

    const filter = call?.capabilityFilter as { excludeToolNames?: Set<string>; allowToolNames?: Set<string> } | undefined;
    expect(filter?.excludeToolNames).toEqual(new Set(["Task", "suggest_scope_change"]));
    expect(filter?.allowToolNames).toBeUndefined(); // never introduced when nothing was requested

    const markerCall = logSpy.mock.calls.find((args) => String(args[0]).includes("[zone-requested-tools-granted]"));
    expect(markerCall).toBeUndefined(); // the grant block must not run when requestedTools is absent

    logSpy.mockRestore();
  });

  // The required live-path test (approval addition #2): requestedTools:["run_command"]
  // through a realistic write-capable pipeline. The outcome is not predicted in the
  // plan — asserted here on whatever the real, wired-up code path actually produces.
  it("live path: requestedTools=[\"run_command\"] through simple_add — asserts the actual observed outcome", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const call = await runWith({
      archetype: "simple_add",
      preGeneratedPlan: planWithRequestedTools(["run_command"]),
      runId: "run-sa-runcommand",
    });

    const filter = call?.capabilityFilter as { excludeToolNames?: Set<string>; allowToolNames?: Set<string> } | undefined;
    // Observed: run_command is not a member of simple_add's excludeToolNames (it's
    // already offered outright at this pipeline), so applyRequestedToolsGrant drops
    // it as not_dispatcher_excluded and the filter is untouched.
    expect(filter?.excludeToolNames).toEqual(new Set(["Task", "suggest_scope_change"]));
    expect(filter?.allowToolNames).toBeUndefined();

    const markerCall = logSpy.mock.calls.find((args) => String(args[0]).includes("[zone-requested-tools-granted]"));
    expect(markerCall).toBeDefined();
    const payload = JSON.parse(String(markerCall![1]));
    expect(payload.requested).toEqual([{ name: "run_command", source: "explicit" }]);
    expect(payload.granted).toEqual([]);
    expect(payload.dropped).toEqual([
      { name: "run_command", reason: "not_dispatcher_excluded", source: "explicit" },
    ]);
    expect(payload.runId).toBe("run-sa-runcommand");

    logSpy.mockRestore();
  });

  it("live path: requestedTools=[\"Task\"] through simple_add — eligible name is actually granted end-to-end", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const call = await runWith({
      archetype: "simple_add",
      preGeneratedPlan: planWithRequestedTools(["Task"]),
      runId: "run-sa-task",
    });

    const filter = call?.capabilityFilter as { excludeToolNames?: Set<string>; allowToolNames?: Set<string> } | undefined;
    expect(filter?.excludeToolNames).toEqual(new Set(["suggest_scope_change"])); // Task removed
    expect(filter?.allowToolNames).toBeUndefined(); // hadAllowFilter was false — never introduced

    const markerCall = logSpy.mock.calls.find((args) => String(args[0]).includes("[zone-requested-tools-granted]"));
    const payload = JSON.parse(String(markerCall![1]));
    expect(payload.granted).toEqual(["Task"]);
    expect(payload.dropped).toEqual([]);

    logSpy.mockRestore();
  });
});

describe("item 166 stage two — Task granted from the plan's own delegation marks, live through runLlmPatchFlow", () => {
  beforeEach(() => {
    process.env["ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD"] = "1";
  });
  afterEach(() => {
    delete process.env["ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD"];
  });

  it("qualifying mark (worker, 3+ files) → Task granted end-to-end, telemetry source:plan_marks", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const call = await runWith({
      archetype: "simple_add",
      preGeneratedPlan: planWithMarkedSteps([
        markedStep(["a.ts"]),
        markedStep(["b.ts"]),
        markedStep(["c.ts", "d.ts", "e.ts", "f.ts"]),
      ]),
      runId: "run-sa-marks-qualify",
    });

    const filter = call?.capabilityFilter as { excludeToolNames?: Set<string>; allowToolNames?: Set<string> } | undefined;
    // Superset invariant: only Task is removed from simple_add's two-name exclusion set.
    expect(filter?.excludeToolNames).toEqual(new Set(["suggest_scope_change"]));
    expect(filter?.allowToolNames).toBeUndefined();

    const markerCall = logSpy.mock.calls.find((args) => String(args[0]).includes("[zone-requested-tools-granted]"));
    expect(markerCall).toBeDefined();
    const payload = JSON.parse(String(markerCall![1]));
    expect(payload.requested).toEqual([{ name: "Task", source: "plan_marks" }]);
    expect(payload.granted).toEqual(["Task"]);
    expect(payload.dropped).toEqual([]);

    logSpy.mockRestore();
  });

  it("marks present but none qualify (single-file worker marks only) → no grant, filter untouched, telemetry still fires with no_qualifying_marks", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const call = await runWith({
      archetype: "simple_add",
      preGeneratedPlan: planWithMarkedSteps([
        markedStep(["a.ts"]),
        markedStep(["b.ts"]),
        { title: "unmarked", description: "d", filesLikely: ["c.ts"] },
      ]),
      runId: "run-sa-marks-norule",
    });

    const filter = call?.capabilityFilter as { excludeToolNames?: Set<string>; allowToolNames?: Set<string> } | undefined;
    // No qualifying mark reached applyRequestedToolsGrant at all — the pre-grant dropped
    // entry is synthesized at the call site, never passed through the grant function — so
    // the filter is exactly what buildDispatcherCapabilityFilter(SIMPLE_ADD_PIPELINE) produces,
    // untouched by this run.
    expect(filter?.excludeToolNames).toEqual(new Set(["Task", "suggest_scope_change"]));
    expect(filter?.allowToolNames).toBeUndefined();

    const markerCall = logSpy.mock.calls.find((args) => String(args[0]).includes("[zone-requested-tools-granted]"));
    expect(markerCall).toBeDefined(); // this IS the discard the read-only pass found nothing observing
    const payload = JSON.parse(String(markerCall![1]));
    expect(payload.requested).toEqual([]);
    expect(payload.granted).toEqual([]);
    expect(payload.dropped).toEqual([{ name: "Task", reason: "no_qualifying_marks", source: "plan_marks" }]);

    logSpy.mockRestore();
  });

  it("qualifying mark under an archetype whose dispatcher ceiling is empty (targeted_fix) → no grant, reason names the empty ceiling, not the rule", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runWith({
      archetype: "targeted_fix",
      preGeneratedPlan: planWithMarkedSteps([markedStep(["a.ts", "b.ts", "c.ts"])]),
      runId: "run-tf-marks-emptyceiling",
    });

    const markerCall = logSpy.mock.calls.find((args) => String(args[0]).includes("[zone-requested-tools-granted]"));
    expect(markerCall).toBeDefined();
    const payload = JSON.parse(String(markerCall![1]));
    // The rule PASSED (a qualifying mark exists), so "Task" reached applyRequestedToolsGrant
    // and got that function's OWN vocabulary — not_dispatcher_excluded — proving the two
    // refusal paths (pre-grant rule refusal vs. grant-function refusal) are distinguishable
    // by reason string alone, exactly as targeted_fix/refactor's empty filter already made
    // an explicit requestedTools:["Task"] request fail for the same reason.
    expect(payload.requested).toEqual([{ name: "Task", source: "plan_marks" }]);
    expect(payload.granted).toEqual([]);
    expect(payload.dropped).toEqual([{ name: "Task", reason: "not_dispatcher_excluded", source: "plan_marks" }]);

    logSpy.mockRestore();
  });

  it("both channels present (explicit requestedTools:[\"Task\"] AND a qualifying mark) → exactly one grant, one telemetry line, not two", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const call = await runWith({
      archetype: "simple_add",
      preGeneratedPlan: planWithMarkedSteps(
        [markedStep(["a.ts", "b.ts", "c.ts"])],
        ["Task"]
      ),
      runId: "run-sa-both-channels",
    });

    const filter = call?.capabilityFilter as { excludeToolNames?: Set<string>; allowToolNames?: Set<string> } | undefined;
    expect(filter?.excludeToolNames).toEqual(new Set(["suggest_scope_change"]));

    const markerCalls = logSpy.mock.calls.filter((args) => String(args[0]).includes("[zone-requested-tools-granted]"));
    expect(markerCalls).toHaveLength(1); // one grant, not two — the one-shot guard and the de-dup both hold
    const payload = JSON.parse(String(markerCalls[0]![1]));
    // Explicit wins the source label on a name both channels named — assembled explicit-first,
    // so "Task" is already in sourceByName as "explicit" before the marks branch is consulted.
    expect(payload.requested).toEqual([{ name: "Task", source: "explicit" }]);
    expect(payload.granted).toEqual(["Task"]);
    expect(payload.dropped).toEqual([]);

    logSpy.mockRestore();
  });
});
