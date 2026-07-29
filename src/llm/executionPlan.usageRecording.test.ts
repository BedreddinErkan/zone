import { describe, expect, it, beforeEach } from "vitest";
import { vi } from "vitest";

// Only the network-calling inner adapter is faked. createLLMClient is replaced with a
// factory that still constructs a REAL RecordingLLMClient (dynamically imported below, so
// it isn't itself mocked) wrapping that fake — the real recordFromResponse ->
// recordExecution -> ledger-append chain runs, which is the thing this file verifies. A bare
// fake client (bypassing RecordingLLMClient entirely, as executionPlan.test.ts's mock does
// for its own unrelated purposes) would never exercise usage recording at all.
const hoisted = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("./factory.js", async () => {
  const { RecordingLLMClient } = await import("./recordingClient.js");
  const fakeInner = {
    provider: "anthropic" as const,
    createChatCompletion: hoisted.createChatCompletion,
    createChatCompletionStream: vi.fn(),
    createEmbedding: vi.fn(),
  };
  return {
    createLLMClient: vi.fn(() => new RecordingLLMClient(fakeInner)),
  };
});

import { withRequestContext } from "./openaiContext.js";
import { generateExecutionPlan } from "./executionPlan.js";
import { readRecords } from "../usage/usageTracker.js";

const TEST_USER_ID = "test-user-plangen-usage-recording";
const VALID_PLAN = {
  objective: "Add a helper",
  steps: [{ title: "Add helper", description: "Add a small helper function.", filesLikely: ["src/utils/foo.ts"] }],
  riskHints: [],
  scopeSummary: "Add a helper",
};

function mockPlanResponse(usage: Record<string, number> | undefined): void {
  hoisted.createChatCompletion.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify(VALID_PLAN) } }],
    model: "claude-sonnet-5",
    ...(usage ? { usage } : {}),
  });
}

beforeEach(() => {
  hoisted.createChatCompletion.mockClear();
});

describe("generateExecutionPlan — usage recording carries the ambient runId", () => {
  it("records a usage entry for this call, attributed to the ambient runId, with cost fields populated", async () => {
    const runId = `plangen-usage-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    mockPlanResponse({ input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

    await withRequestContext({ runId, userId: TEST_USER_ID }, () =>
      generateExecutionPlan({
        task: "Add a helper function",
        repoSummary: "A TypeScript project.",
        relevantFiles: [],
        userApiKey: "sk-ant-test",
        provider: "anthropic",
      })
    );

    const record = readRecords(TEST_USER_ID).find((r) => r.runId === runId);
    expect(record).toBeDefined();
    expect(record!.est_cost_usd).toBeGreaterThan(0);
    expect(record!.input_uncached).toBeGreaterThan(0);
    expect(record!.output).toBeGreaterThan(0);
  });
});
