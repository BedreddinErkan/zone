/**
 * The one thing runLlmPatchFlow.readOnlySuppression.test.ts's C6 tests structurally
 * cannot establish: what an answer-only run ACTUALLY produces when it exhausts its
 * iteration budget.
 *
 * Those tests mock runAgentLoop, so they pin the argument passed and the marker's
 * reaction to a hand-set terminationReason. They would pass identically if production
 * emitted a different literal, or if the budget never bound the loop at all — which
 * is exactly the defect that turned out to be real (fixed in 7a42e33b: the budget was
 * travelling on `maxIterations`, which agentLoop.ts:2292-2296 discards).
 *
 * This file therefore mocks everything around runLlmPatchFlow EXCEPT runAgentLoop, and
 * drives the real loop to real exhaustion through the real production call site. It
 * asserts nothing by hand: the iteration bound and the termination string are both read
 * back out of [zone-answer-only-budget-exhausted], which only fires when production's
 * own gate (terminationReason === "token_budget_exceeded") is satisfied.
 *
 * Gap 12 is why that literal is what it is: composer.ts:207 reports an iteration-cap
 * exit under a token-budget name. If Gap 12 is ever fixed, this probe goes red — which
 * is correct, because C6's marker gate must change in the same commit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../types/project.js";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import type { TaskClassification } from "../llm/taskClassifier.js";

const scanRepoMock = vi.fn();
const detectProjectStructureMock = vi.fn();
const rankRelevantFilesMock = vi.fn();
const readProjectFilesMock = vi.fn();
const planPatchPreviewWithLlmMock = vi.fn();
const runRuntimeVerificationPlanMock = vi.fn();
const classifyTaskMock = vi.fn();

const toolExecutorMock = vi.hoisted(() => ({
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  clearCommandCacheForRun: vi.fn(),
  clearCommandCacheForTest: vi.fn(),
  clearOutlineCacheForTest: vi.fn(),
  isMemoizableCommand: vi.fn(),
  computeCommandFingerprint: vi.fn(),
  truncateCommandOutput: vi.fn(),
  resolveAgentPath: vi.fn(),
  resolveRunCommandCwd: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ createChatCompletion: vi.fn() }));

vi.mock("../repo/scanRepo.js", () => ({ scanRepo: scanRepoMock }));
vi.mock("../repo/detectProjectStructure.js", () => ({ detectProjectStructure: detectProjectStructureMock }));
vi.mock("../repo/rankRelevantFiles.js", () => ({ rankRelevantFiles: rankRelevantFilesMock }));
vi.mock("../repo/readProjectFiles.js", () => ({ readProjectFiles: readProjectFilesMock }));
vi.mock("../llm/planPatchPreview.js", () => ({ planPatchPreviewWithLlm: planPatchPreviewWithLlmMock }));
vi.mock("./runRuntimeVerification.js", () => ({ runRuntimeVerificationPlan: runRuntimeVerificationPlanMock }));
vi.mock("../llm/taskClassifier.js", () => ({
  classifyTask: classifyTaskMock,
  CLASSIFIER_CONFIDENCE_THRESHOLD: 0.5,
}));
// Deliberately NOT mocked: ../llm/agentLoop.js. That is the entire point of this file.
vi.mock("../llm/factory.js", () => ({
  createLLMClient: vi.fn(() => ({ provider: "anthropic", createChatCompletion: mocks.createChatCompletion })),
}));
vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

import { runAgentLoop } from "../llm/agentLoop.js";

function buildRepoFile(p: string, category: RepoFile["category"] = "source"): RepoFile {
  return { path: p, absolutePath: `/tmp/fake-repo/${p}`, extension: p.split(".").pop() ?? "", category };
}

const REPO_FILES = [buildRepoFile("src/index.ts")];

const ANSWER_ONLY_PLAN = {
  objective: "Explain the marker sink",
  steps: [] as Array<{ title: string; description: string; filesLikely: string[] }>,
  scopeSummary: "Explain the marker sink",
  riskHints: [],
  answerOnlyReason: "The task is a question; nothing needs to change.",
};

/** Non-empty steps, no answerOnlyReason — the CONTRAST fixture for 2a: a normal plan driven
 *  to the same exhaustion tail, so the assessment call's content can be compared directly
 *  against ANSWER_ONLY_PLAN's with nothing else differing. */
const NORMAL_PLAN = {
  objective: "Fix the marker sink",
  steps: [{ title: "Fix it", description: "Patch the sink.", filesLikely: ["src/index.ts"] }],
  scopeSummary: "Fix the marker sink",
  riskHints: [],
};

type CapturedMessage = { role: string; content: unknown };

/** Distinct filePath per call: four identical tool+args hashes trip the loop detector
 *  (TERMINATE_THRESHOLD=4) and would end the run as "loop_detected" long before the
 *  budget is reached — a different tail than the one under test. */
function makeReadFileResponse(filePath: string) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: `call_rf_${filePath.replace(/\W/g, "_")}`,
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ filePath }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** `investigation` carries iterCap 12 (archetypeDispatcher.ts:100), above
 *  ANSWER_ONLY_ITER_BUDGET, so the clamp resolves to 8 and the budget under test is the
 *  answer-only one rather than the archetype's. */
function classification(): TaskClassification {
  return {
    tier: "medium",
    estimatedFiles: 2,
    estimatedIterations: 5,
    confidence: 0.9,
    classifierCostUsd: 0.002,
    classifierLatencyMs: 1000,
    classifierModel: "claude-haiku-4-5",
    fallbackUsed: false,
    archetype: "investigation",
    archetypeConfidence: 0.9,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

function markerPayload(name: string): Record<string, unknown> | undefined {
  const call = logSpy.mock.calls.find((c: unknown[]) => c[0] === name);
  return call ? (JSON.parse(call[1] as string) as Record<string, unknown>) : undefined;
}

const exhaustionMarker = () => markerPayload("[zone-answer-only-budget-exhausted]");
const promotionMarker = () => markerPayload("[zone-archetype-promoted]");

/** Overwritten on every createChatCompletion call, so once the run has finished this holds
 *  the LAST call made — the assessment call, since it fires exactly once after the
 *  iteration loop exhausts and nothing calls createChatCompletion after it (traced through
 *  agentLoop.ts's post-loop finalizeRun and runLlmPatchFlow's post-loop handling of
 *  terminationReason "token_budget_exceeded": both are pure/local from there, neither
 *  issues another completion). ASSESSMENT_CALL_PREFIX is the positive control that proves
 *  this — asserted in both 2a tests before the tag-instruction assertion, so an absent tag
 *  means "gated", not "captured the wrong call".
 */
let lastMessages: CapturedMessage[] = [];
const ASSESSMENT_CALL_PREFIX = "You have reached the maximum number of iterations";
const lastCallContent = () =>
  String((lastMessages[lastMessages.length - 1] as CapturedMessage | undefined)?.content ?? "");

beforeEach(() => {
  delete process.env["ZONE_FORCE_FLOW"];
  vi.clearAllMocks();
  resetToolExecutorMock(toolExecutorMock);
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
  runRuntimeVerificationPlanMock.mockResolvedValue({
    attempted: false, status: "skipped_no_command", steps: [], summary: "No safe verification command detected.",
  });
  scanRepoMock.mockResolvedValue(REPO_FILES);
  detectProjectStructureMock.mockReturnValue({ notes: ["Node.js"] });
  rankRelevantFilesMock.mockReturnValue([{ ...REPO_FILES[0]!, score: 10 }]);
  readProjectFilesMock.mockResolvedValue({});
  planPatchPreviewWithLlmMock.mockResolvedValue({ patches: [] });
  classifyTaskMock.mockResolvedValue(classification());

  lastMessages = [];
  // mockImplementation, not ...Once: the loop must never complete naturally, so it
  // falls through to the max-iterations tail rather than the natural_completion one.
  let call = 0;
  mocks.createChatCompletion.mockImplementation(async (params: { messages: CapturedMessage[] }) => {
    call += 1;
    lastMessages = params.messages;
    return makeReadFileResponse(`src/probe-${call}.ts`);
  });

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  delete process.env["ZONE_FORCE_FLOW"];
});

describe("PROBE: an answer-only run's real exhaustion, through the production call site", () => {
  it("bounds at ANSWER_ONLY_ITER_BUDGET and terminates as token_budget_exceeded", async () => {
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    await runLlmPatchFlow({
      task: "why does the marker sink write where it does",
      repoPath: "/tmp/fake-repo",
      runId: "run-answer-probe",
      onProgress: () => undefined,
      abortSignal: new AbortController().signal,
      userApiKey: "sk-fake",
      provider: "anthropic",
      mode: "patch",
      preGeneratedPlan: ANSWER_ONLY_PLAN,
    });

    const marker = exhaustionMarker();

    // The marker firing at all IS the terminationReason assertion: production gates it
    // on `loop.terminationReason === "token_budget_exceeded"` and nothing here mocks
    // that value. Its absence would mean the real loop produced a different string.
    expect(marker).toBeDefined();

    // The budget really bound at 8. Read from the promotion marker rather than the
    // constant: L5.1b-2 fires `trigger:"iter_cap"` at exactly the iteration the cap was
    // set to, so atIter IS the enforced bound observed from inside the loop. Before
    // 7a42e33b there was no promotion at 8 at all — the budget travelled on a field the
    // tier block discards and the run simply ran to 75.
    expect(promotionMarker()).toMatchObject({ atIter: 8, trigger: "iter_cap" });

    // ...and then ran to 15, because that same promotion relaxes maxIterationsForRun to
    // BASE_MAX_ITERATIONS mid-run. Recorded, not fixed: promotion exists to rescue a
    // patch run that ran out of room mid-edit, which an answer-only run cannot be — it
    // is offered no write tool. Suppressing it for this shape is a behavior change on
    // a general mechanism and belongs in its own pass. Asserted so the gap between the
    // nominal budget and the real ceiling is pinned rather than assumed away.
    expect(marker?.["observedIterCount"]).toBe(15);

    // Positive control FIRST: proves lastMessages captured the assessment call specifically
    // — not some other completion that might fire after it — before the tag assertion below
    // is allowed to mean anything. Without this, a wiring change that made lastMessages hold
    // a DIFFERENT call would make not.toContain("[ZONE_VERIFICATION") pass vacuously.
    expect(lastCallContent()).toContain(ASSESSMENT_CALL_PREFIX);

    // 2a's actual target: the max-iterations wrapup must not ask an answer-only run to
    // verify tests it never ran. "[ZONE_VERIFICATION: <reason>]" (with the colon+reason),
    // not the bare "[ZONE_VERIFICATION" prefix: the answer-only branch's own prohibition
    // text ("Do NOT include a [ZONE_VERIFICATION] tag") contains the bare prefix, so
    // asserting on that would match this test's own production text against itself — the
    // same collision Task 3 hit with "## What changed" in ANSWER_SUMMARY's FORBIDDEN list.
    expect(lastCallContent()).not.toContain("[ZONE_VERIFICATION: <reason>]");
  });

  it("CONTRAST: a normal exhausted run still gets the verification tag instruction", async () => {
    // Same harness, same never-completing mock, only the plan's shape differs — isolating
    // the assertion to the plan rather than to anything else about this run.
    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    await runLlmPatchFlow({
      task: "why does the marker sink write where it does",
      repoPath: "/tmp/fake-repo",
      runId: "run-normal-probe",
      onProgress: () => undefined,
      abortSignal: new AbortController().signal,
      userApiKey: "sk-fake",
      provider: "anthropic",
      mode: "patch",
      preGeneratedPlan: NORMAL_PLAN,
    });

    // Same positive control as above, for the same reason: prove the captured call is the
    // assessment call before trusting what it does or doesn't contain.
    expect(lastCallContent()).toContain(ASSESSMENT_CALL_PREFIX);
    // Same discriminator as the answer-only test's not.toContain, for a direct comparison.
    expect(lastCallContent()).toContain("[ZONE_VERIFICATION: <reason>]");
  });

  it("CONTRAST: the readonly tail yields max_iterations, and only a mode this path never has reaches it", async () => {
    // Proves "max_iterations" is live rather than vestigial, and that the sole route to
    // it is isReadOnlyMode (agentLoop.ts:2125-2127, :5181-5215) — a mode dispatch.ts
    // never supplies, since all three runLlmPatchFlow call sites pass mode:"patch"
    // literally (dispatch.ts:648, :708, :811). That is why C6's gate reads the other
    // literal: gating on this one would leave the marker permanently dead.
    const loop = await runAgentLoop({
      task: "why does the marker sink write where it does",
      repoPath: "/tmp/fake-repo",
      taskClassification: classification(),
      executionPlan: ANSWER_ONLY_PLAN,
      planApproved: false,
      mode: "investigate",
      maxIterationsOverride: 1,
    });

    expect(loop.terminationReason).toBe("max_iterations");
  });
});

/**
 * R4 — the read-only posture of an approved answer-only plan, pinned THROUGH the
 * production archetype seam.
 *
 * R5 is the standing counter-example this test exists to avoid repeating:
 * agentLoop.steplessAnswerShape.test.ts asserts a read-only tool set while forcing
 * archetype "investigation", a value production does not produce for this shape. The
 * builders it exercises are real; the input is a fixture.
 *
 * So this classifies as **"debug"** — the archetype a real run measurably produced for
 * "Why does the loop detector fire on 4 identical tool+args hashes?" — which makes
 * buildPipelineConfig return null, buildDispatcherCapabilityFilter return undefined, and
 * runLlmPatchFlow.ts's `pipelineCfg &&` spread skip its nested capabilityFilter entirely.
 * That is the exact path that left the measured run on the medium-tier subset (9 tools,
 * writes included) with scopeGuard as the only enforced layer.
 */
function classificationDebug(): TaskClassification {
  return { ...classification(), archetype: "debug", archetypeConfidence: 0.8 };
}

describe("R4: an answer-only plan gets a read-only tool set through the real archetype seam", () => {
  it("offers no write tool even when the fresh classification yields a null pipeline config", async () => {
    classifyTaskMock.mockResolvedValue(classificationDebug());

    let toolNames: string[] = [];
    mocks.createChatCompletion.mockImplementation(
      async (params: { tools?: Array<{ function?: { name?: string } }> }) => {
        if (toolNames.length === 0 && params.tools) {
          toolNames = params.tools.map((t) => t.function?.name ?? "");
        }
        return {
          choices: [{ message: { content: "Answered.", tool_calls: null }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      },
    );

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    await runLlmPatchFlow({
      task: "Why does the loop detector fire on 4 identical tool+args hashes?",
      repoPath: "/tmp/fake-repo",
      runId: "run-r4-debug-archetype",
      onProgress: () => undefined,
      abortSignal: new AbortController().signal,
      userApiKey: "sk-fake",
      provider: "anthropic",
      mode: "patch",
      preGeneratedPlan: ANSWER_ONLY_PLAN,
    });

    // Positive control FIRST: "contains no write tool" is vacuously true of an empty or
    // never-populated list, so the absence checks below mean nothing until the tool set
    // is shown to be real and read-capable.
    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames).toContain("read_file");

    // The fix itself. Before it, this run reached the medium-tier subset and all three
    // of these were present.
    expect(toolNames).not.toContain("apply_patch");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("multi_edit");
  });
});
