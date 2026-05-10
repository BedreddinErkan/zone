import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyTask, clearClassificationCache } from "./taskClassifier.js";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

function buildResponse(jsonContent: string, model = "gpt-5.4-mini") {
  return {
    model,
    choices: [{ message: { content: jsonContent } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearClassificationCache();
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

describe("Phase L.1 task classifier", () => {
  it("classifies a simple task correctly", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "simple",
          estimatedFiles: 1,
          estimatedIterations: 5,
          needsSubagent: false,
          confidence: 0.9,
          reasoning: "single-line comment add",
        })
      )
    );

    const result = await classifyTask("Add a comment above the export in src/foo.ts");

    expect(result.tier).toBe("simple");
    expect(result.needsSubagent).toBe(false);
    expect(result.estimatedFiles).toBe(1);
    expect(result.confidence).toBe(0.9);
    expect(result.fallbackUsed).toBeUndefined();
    expect(result.classifierModel).toBe("gpt-5.4-mini");
    expect(result.classifierCostUsd).toBeGreaterThan(0);
    expect(result.classifierLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("classifies a medium task correctly", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 5,
          estimatedIterations: 15,
          needsSubagent: true,
          confidence: 0.75,
          reasoning: "multi-file refactor across 1-2 modules",
        })
      )
    );

    const result = await classifyTask("Refactor the auth middleware into smaller helpers");

    expect(result.tier).toBe("medium");
    expect(result.estimatedFiles).toBe(5);
    expect(result.needsSubagent).toBe(true);
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("classifies a complex task correctly", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 15,
          estimatedIterations: 40,
          needsSubagent: true,
          confidence: 0.85,
          reasoning: "cross-cutting architectural change",
        })
      )
    );

    const result = await classifyTask("Migrate every legacy session API call to the new auth client");

    expect(result.tier).toBe("complex");
    expect(result.estimatedFiles).toBe(15);
    expect(result.estimatedIterations).toBe(40);
  });

  it("falls back to Tier 2 (medium) when the classifier API throws", async () => {
    mocks.createChatCompletion.mockRejectedValue(new Error("api_unavailable"));

    const result = await classifyTask("anything");

    expect(result.tier).toBe("medium");
    expect(result.fallbackUsed).toBe(true);
    expect(result.confidence).toBe(0);
    expect(result.reasoning).toMatch(/classifier fallback/);
  });

  it("falls back to Tier 2 when confidence is below threshold (0.5)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "simple",
          estimatedFiles: 1,
          estimatedIterations: 3,
          needsSubagent: false,
          confidence: 0.3,
          reasoning: "uncertain",
        })
      )
    );

    const result = await classifyTask("ambiguous task");

    expect(result.tier).toBe("medium");
    expect(result.fallbackUsed).toBe(true);
    expect(result.reasoning).toMatch(/low confidence/);
  });

  it("falls back to Tier 2 on JSON parse failure", async () => {
    mocks.createChatCompletion.mockResolvedValue(buildResponse("not json at all"));

    const result = await classifyTask("malformed-response task");

    expect(result.tier).toBe("medium");
    expect(result.fallbackUsed).toBe(true);
  });

  it("falls back to Tier 2 when tier value is invalid", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "trivial",
          estimatedFiles: 1,
          estimatedIterations: 1,
          needsSubagent: false,
          confidence: 0.9,
        })
      )
    );

    const result = await classifyTask("invalid-tier task");

    expect(result.tier).toBe("medium");
    expect(result.fallbackUsed).toBe(true);
  });

  it("caches classification by task description hash", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "simple",
          estimatedFiles: 1,
          estimatedIterations: 4,
          needsSubagent: false,
          confidence: 0.85,
        })
      )
    );

    const taskDescription = "Rename the constant FOO to BAR in config.ts";
    const first = await classifyTask(taskDescription);
    const second = await classifyTask(taskDescription);

    expect(first).toBe(second);
    expect(mocks.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("respects the skipCache option", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "simple",
          estimatedFiles: 1,
          estimatedIterations: 4,
          needsSubagent: false,
          confidence: 0.9,
        })
      )
    );

    const taskDescription = "task that should re-classify";
    await classifyTask(taskDescription);
    await classifyTask(taskDescription, { skipCache: true });

    expect(mocks.createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("emits [zone-task-classified] log entry on success", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 4,
          estimatedIterations: 12,
          needsSubagent: false,
          confidence: 0.8,
        })
      )
    );

    await classifyTask("log emission task");

    const successLogCall = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-task-classified]"
    );
    expect(successLogCall).toBeDefined();
    const payload = JSON.parse(String(successLogCall![1]));
    expect(payload).toMatchObject({
      tier: "medium",
      estimatedFiles: 4,
      needsSubagent: false,
      classifierModel: "gpt-5.4-mini",
    });
    expect(typeof payload.taskHash).toBe("string");
    expect(payload.classifierLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("emits [zone-task-classifier-failure] log entry on error", async () => {
    mocks.createChatCompletion.mockRejectedValue(new Error("boom"));

    await classifyTask("error path task");

    // L.1 bug-G: failure entry routed to stdout (log) rather than stderr
    // (errorLog) so it always lands in the same stream as success entries.
    const failureLogCall = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-task-classifier-failure]"
    );
    expect(failureLogCall).toBeDefined();
    const payload = JSON.parse(String(failureLogCall![1]));
    expect(payload).toMatchObject({
      message: "boom",
      classifierModel: "gpt-5.4-mini",
      provider: "openai",
    });
  });

  it("triggers fallback when classifier exceeds the timeout budget", async () => {
    mocks.createChatCompletion.mockImplementation(
      () => new Promise(() => undefined) // never resolves
    );

    const start = Date.now();
    const result = await classifyTask("never resolves", { timeoutMs: 80 });
    const elapsed = Date.now() - start;

    expect(result.tier).toBe("medium");
    expect(result.fallbackUsed).toBe(true);
    expect(result.reasoning).toMatch(/timeout/);
    expect(elapsed).toBeLessThan(1500);
  });

  it("does not cache fallback responses produced by API errors", async () => {
    mocks.createChatCompletion
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(
        buildResponse(
          JSON.stringify({
            tier: "complex",
            estimatedFiles: 12,
            estimatedIterations: 30,
            needsSubagent: true,
            confidence: 0.8,
          })
        )
      );

    const description = "first call fails";
    const firstResult = await classifyTask(description);
    const secondResult = await classifyTask(description);

    expect(firstResult.fallbackUsed).toBe(true);
    expect(secondResult.tier).toBe("complex");
    expect(mocks.createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("system prompt includes breaking-change and cross-cutting heuristics", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 10,
          estimatedIterations: 30,
          needsSubagent: true,
          confidence: 0.9,
          reasoning: "breaking change across callers",
        })
      )
    );

    await classifyTask("Change a function signature to break all callers");

    const call = mocks.createChatCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = call.messages.find((m) => m.role === "system")?.content ?? "";
    expect(systemMsg).toContain("breaking change");
    expect(systemMsg).toContain("callers");
    expect(systemMsg).toContain("all instances");
    expect(systemMsg).toContain("cross-cutting");
  });

  it("classifies find-N-callers + signature-break task as complex (not simple)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 10,
          estimatedIterations: 30,
          needsSubagent: true,
          confidence: 0.92,
          reasoning: "find-and-modify across multiple callers — cross-cutting",
        })
      )
    );

    const result = await classifyTask(
      "Find any existing exported function in src/core/ called from at least 2 other files. Change its signature to break callers."
    );

    expect(result.tier).not.toBe("simple");
    expect(["medium", "complex"]).toContain(result.tier);
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("classifies 'all instances across the codebase' task as complex", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 15,
          estimatedIterations: 35,
          needsSubagent: true,
          confidence: 0.88,
          reasoning: "all instances across codebase — complex scope",
        })
      )
    );

    const result = await classifyTask(
      "Find and update all instances of the deprecated renderComponent call across the codebase"
    );

    expect(result.tier).toBe("complex");
    expect(result.fallbackUsed).toBeUndefined();
  });
});
