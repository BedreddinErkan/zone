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
 * agentLoop.ts's own body — including [zone-write-capability-absent]'s call
 * site — never runs here. What IS observable and is what this commit changes:
 * whether capabilityFilter is present on the object passed to runAgentLoop.
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

function classification(archetype: "investigation" | "question") {
  return {
    tier: "medium" as const,
    archetype,
    confidence: 0.9,
    archetypeConfidence: 0.9,
    fallbackUsed: false,
  };
}

function events(spy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((c: unknown[]) => c[0] === "[zone-readonly-pipeline-suppressed]")
    .map((c: unknown[]) => JSON.parse(c[1] as string) as Record<string, unknown>);
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
  archetype: "investigation" | "question";
  preGeneratedPlan?: typeof APPROVED_PLAN | typeof STEPLESS_PLAN;
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
  it("investigation + approved plan with steps → capabilityFilter suppressed, marker fires", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const call = await runWith({ archetype: "investigation", preGeneratedPlan: APPROVED_PLAN, runId: "run-inv-1" });

    expect(call?.capabilityFilter).toBeUndefined();
    const [evt] = events(consoleLogSpy);
    expect(evt).toBeDefined();
    expect(evt.archetype).toBe("investigation");
    expect(evt.stepCount).toBe(1);
  });

  it("question + approved plan with steps → capabilityFilter suppressed, marker fires", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const call = await runWith({ archetype: "question", preGeneratedPlan: APPROVED_PLAN, runId: "run-q-1" });

    expect(call?.capabilityFilter).toBeUndefined();
    const [evt] = events(consoleLogSpy);
    expect(evt).toBeDefined();
    expect(evt.archetype).toBe("question");
    expect(evt.stepCount).toBe(1);
  });

  it("investigation + approved but stepless plan (noChangeReason) → stays read-only, marker silent", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const call = await runWith({ archetype: "investigation", preGeneratedPlan: STEPLESS_PLAN, runId: "run-inv-2" });

    expect(call?.capabilityFilter).toBeDefined();
    expect(events(consoleLogSpy)).toHaveLength(0);
  });

  it("investigation + no approved plan → unchanged, stays read-only, marker silent", async () => {
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const call = await runWith({ archetype: "investigation", runId: "run-inv-3" });

    expect(call?.capabilityFilter).toBeDefined();
    expect(events(consoleLogSpy)).toHaveLength(0);
  });
});
