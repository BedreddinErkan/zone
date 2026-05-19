import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyTask,
  clearClassificationCache,
  CLASSIFIER_CONFIDENCE_THRESHOLD,
} from "./taskClassifier.js";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

function buildResponse(jsonContent: string, model = "claude-haiku-4-5") {
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
    expect(result.estimatedFiles).toBe(1);
    expect(result.confidence).toBe(0.9);
    expect(result.fallbackUsed).toBeUndefined();
    expect(result.classifierModel).toBe("claude-haiku-4-5");
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
    // Q.8: estimatedFiles dropped from 4 to 3 so the new
    // "medium + estimatedFiles >= 4 → needsSubagent=true" rule doesn't
    // flip needsSubagent and obscure this test's intent (log emission).
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 3,
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
      estimatedFiles: 3,
      classifierModel: "claude-haiku-4-5",
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
      classifierModel: "claude-haiku-4-5",
      provider: "anthropic",
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

describe("Phase Q.8 — complex-tier triggers for multi-file rename", () => {
  it("rename across 5 files → complex", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 5,
          estimatedIterations: 20,
          confidence: 0.85,
          reasoning: "rename across 5 files — def + imports + call sites",
        })
      )
    );

    const result = await classifyTask(
      "Rename `detectFramework` to `identifyFramework` across all 5 files where it's defined or used"
    );

    expect(result.tier).toBe("complex");
    expect(result.estimatedFiles).toBe(5);
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("rename across 3 explicitly-listed files → complex", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 3,
          estimatedIterations: 15,
          confidence: 0.8,
          reasoning: "explicit 3-file rename with coordinated edits",
        })
      )
    );

    const result = await classifyTask(
      "Rename helperA to helperB in src/a.ts, src/b.ts, and src/c.ts"
    );

    expect(result.tier).toBe("complex");
  });

  it("rename in only 2 files → stays medium (count below threshold)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 2,
          estimatedIterations: 8,
          confidence: 0.85,
          reasoning: "small-scope 2-file rename",
        })
      )
    );

    const result = await classifyTask("Rename foo to bar in 2 files");

    expect(result.tier).toBe("medium");
  });

  it("add new export to 5 files (pure additions, no rename) → medium", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 5,
          estimatedIterations: 15,
          confidence: 0.78,
          reasoning: "pure additions to 5 modules, no rename coordination",
        })
      )
    );

    const result = await classifyTask(
      "Add a new helper export to 5 files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts"
    );

    expect(result.tier).toBe("medium");
  });

  it("system prompt includes Q.8 rename / multi-file complex triggers (openai path)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 5,
          estimatedIterations: 20,
          needsSubagent: true,
          confidence: 0.9,
        }),
        "gpt-5.4-mini"
      )
    );

    await classifyTask("prompt-content audit task", { provider: "openai" });

    const call = mocks.createChatCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = call.messages.find((m) => m.role === "system")?.content ?? "";
    // Anchors for the Q.8 additions.
    expect(systemMsg).toContain("COMPLEX tier triggers");
    expect(systemMsg).toContain("Rename / refactor");
    expect(systemMsg).toContain("across all N files");
    expect(systemMsg).toContain("3+ file paths");
    expect(systemMsg).toContain("Counter-examples");
  });
});

describe("Phase BYOM.1.1 — classifier provider routing", () => {
  it("no provider passed → defaults to anthropic → model claude-haiku-4-5", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "simple",
          estimatedFiles: 1,
          estimatedIterations: 5,
          needsSubagent: false,
          confidence: 0.9,
        })
      )
    );

    const result = await classifyTask("simple comment add");

    expect(result.classifierModel).toBe("claude-haiku-4-5");
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("provider=anthropic explicit → model claude-haiku-4-5", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 3,
          estimatedIterations: 12,
          needsSubagent: false,
          confidence: 0.8,
        })
      )
    );

    const result = await classifyTask("refactor helpers", { provider: "anthropic" });

    expect(result.classifierModel).toBe("claude-haiku-4-5");
  });

  it("provider=openai explicit → model gpt-5.4-mini", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 3,
          estimatedIterations: 10,
          needsSubagent: false,
          confidence: 0.8,
        }),
        "gpt-5.4-mini"
      )
    );

    const result = await classifyTask("refactor helpers", { provider: "openai" });

    expect(result.classifierModel).toBe("gpt-5.4-mini");
  });

  it("explicit provider param wins over request context", async () => {
    // Even if ctx.provider were openai, explicit options.provider=anthropic takes precedence.
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

    // Pass anthropic explicitly — should pick claude-haiku-4-5 regardless of any ctx
    const result = await classifyTask("explicit override task", { provider: "anthropic" });

    expect(result.classifierModel).toBe("claude-haiku-4-5");
  });

  it("anthropic failure → fallback emits provider=anthropic in log", async () => {
    mocks.createChatCompletion.mockRejectedValue(new Error("quota exceeded"));

    await classifyTask("anthropic-only user task");

    const failureLogCall = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-task-classifier-failure]"
    );
    expect(failureLogCall).toBeDefined();
    const payload = JSON.parse(String(failureLogCall![1]));
    expect(payload).toMatchObject({
      classifierModel: "claude-haiku-4-5",
      provider: "anthropic",
    });
  });
});

describe("Phase K.2 — confidence gate", () => {
  it("high confidence (0.92) + complex tier → tier stays complex, no fallback telemetry", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 12,
          estimatedIterations: 35,
          needsSubagent: true,
          confidence: 0.92,
          reasoning: "cross-cutting refactor",
        })
      )
    );

    const result = await classifyTask("high-confidence complex task");

    expect(result.tier).toBe("complex");
    expect(result.fallbackUsed).toBeUndefined();
    const fallbackLogCall = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-low-confidence-fallback]"
    );
    expect(fallbackLogCall).toBeUndefined();
  });

  it("low confidence (0.3) + complex tier → forced to medium + [zone-tier-low-confidence-fallback] emitted", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 10,
          estimatedIterations: 30,
          needsSubagent: true,
          confidence: 0.3,
          reasoning: "uncertain scope",
        })
      )
    );

    const result = await classifyTask("low-confidence complex task");

    expect(result.tier).toBe("medium");
    expect(result.fallbackUsed).toBe(true);

    const fallbackLogCall = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-low-confidence-fallback]"
    );
    expect(fallbackLogCall).toBeDefined();
    const payload = JSON.parse(String(fallbackLogCall![1]));
    expect(payload).toMatchObject({
      classifierTier: "complex",
      forcedTier: "medium",
      confidence: 0.3,
      threshold: CLASSIFIER_CONFIDENCE_THRESHOLD,
    });
  });

  it("low confidence (0.3) + medium tier → stays medium, no [zone-tier-low-confidence-fallback]", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 5,
          estimatedIterations: 15,
          needsSubagent: false,
          confidence: 0.3,
          reasoning: "uncertain, but medium is already the safe default",
        })
      )
    );

    const result = await classifyTask("low-confidence medium task");

    expect(result.tier).toBe("medium");
    expect(result.fallbackUsed).toBe(true);
    // No noise log when falling back to an already-safe tier
    const fallbackLogCall = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-low-confidence-fallback]"
    );
    expect(fallbackLogCall).toBeUndefined();
  });

  it("confidence exactly at threshold (0.5) → not below threshold, no override", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "simple",
          estimatedFiles: 1,
          estimatedIterations: 5,
          needsSubagent: false,
          confidence: 0.5,
          reasoning: "borderline simple",
        })
      )
    );

    const result = await classifyTask("threshold-edge task");

    // 0.5 is NOT below the threshold (< 0.5 is the gate condition), so no fallback
    expect(result.tier).toBe("simple");
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("low confidence (0.3) + simple tier → forced to medium + fallback telemetry emitted", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "simple",
          estimatedFiles: 1,
          estimatedIterations: 4,
          needsSubagent: false,
          confidence: 0.3,
          reasoning: "uncertain simple classification",
        })
      )
    );

    const result = await classifyTask("low-confidence simple task");

    expect(result.tier).toBe("medium");
    expect(result.fallbackUsed).toBe(true);

    const fallbackLogCall = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-low-confidence-fallback]"
    );
    expect(fallbackLogCall).toBeDefined();
    const payload = JSON.parse(String(fallbackLogCall![1]));
    expect(payload).toMatchObject({
      classifierTier: "simple",
      forcedTier: "medium",
      confidence: 0.3,
    });
  });
});

describe("Phase D4 — investigation-scope classifier tuning", () => {
  it("system prompt includes investigation-scope distinction and test-fix heuristics", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 2,
          estimatedIterations: 12,
          needsSubagent: false,
          confidence: 0.8,
          reasoning: "test fix requiring investigation",
        })
      )
    );

    await classifyTask("Fix stale tests in src/core/buildDecisionTrace.test.ts");

    const call = mocks.createChatCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMsg = call.messages.find((m) => m.role === "system")?.content ?? "";

    // Addition 1: investigation-scope distinction
    expect(systemMsg).toContain("Edit scope");
    expect(systemMsg).toContain("Investigation scope");
    expect(systemMsg).toContain("LARGER of the two");

    // Addition 2: test-fix few-shot examples
    expect(systemMsg).toContain("Test-fix examples");
    expect(systemMsg).toContain("Fix stale tests after Phase X refactor");

    // Addition 3: heuristics
    expect(systemMsg).toContain("*.test.ts");
    expect(systemMsg).toContain("stale");
    expect(systemMsg).toContain("implementation is correct, tests are stale");
  });

  // Dogfood regression: 3 real tasks that mis-classified as simple pre-D4
  it("cli-test-fix → medium (was simple, c=0.95 before D4)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 3,
          estimatedIterations: 14,
          needsSubagent: false,
          confidence: 0.8,
          reasoning: "test fix requires reading impl + routing logic",
        })
      )
    );

    const result = await classifyTask(
      "Fix the failing tests in src/cli/index.test.ts. Multiple tests reference outdated --format flag handling for json/trace/verbose modes. The implementation is correct; tests are stale."
    );

    expect(result.tier).toBe("medium");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("billing-test-fix → medium (was simple before D4)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 2,
          estimatedIterations: 12,
          needsSubagent: false,
          confidence: 0.75,
          reasoning: "test fix requires reading repository implementation",
        })
      )
    );

    const result = await classifyTask(
      "Fix 3 failing tests in src/billing/conversationRepository.test.ts"
    );

    expect(result.tier).toBe("medium");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("buildDecisionTrace-test-fix → medium (was simple before D4)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 3,
          estimatedIterations: 14,
          needsSubagent: false,
          confidence: 0.82,
          reasoning: "stale test fix — requires Phase J refactor investigation",
        })
      )
    );

    const result = await classifyTask(
      "Fix stale tests in src/core/buildDecisionTrace.test.ts"
    );

    expect(result.tier).toBe("medium");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.fallbackUsed).toBeUndefined();
  });

  // No-regress: trivially simple tasks must stay simple
  it("Fix typo in a single source file → simple", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "simple",
          estimatedFiles: 1,
          estimatedIterations: 3,
          needsSubagent: false,
          confidence: 0.95,
          reasoning: "single-file typo fix, no investigation needed",
        })
      )
    );

    const result = await classifyTask("Fix typo in src/utils/format.ts line 42");

    expect(result.tier).toBe("simple");
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("Single-occurrence rename in one file → simple", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "simple",
          estimatedFiles: 1,
          estimatedIterations: 4,
          needsSubagent: false,
          confidence: 0.92,
          reasoning: "single-file rename, one occurrence",
        })
      )
    );

    const result = await classifyTask(
      "Rename foo to bar in src/single.ts (single occurrence)"
    );

    expect(result.tier).toBe("simple");
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("Add JSDoc comment to one function → simple", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "simple",
          estimatedFiles: 1,
          estimatedIterations: 3,
          needsSubagent: false,
          confidence: 0.97,
          reasoning: "pure cosmetic addition, one file",
        })
      )
    );

    const result = await classifyTask(
      "Add JSDoc comment to publicFn in src/api/health.ts"
    );

    expect(result.tier).toBe("simple");
    expect(result.fallbackUsed).toBeUndefined();
  });

  // No-regress: complex tasks must stay complex
  it("Rename class across 8 modules → complex", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 8,
          estimatedIterations: 30,
          needsSubagent: true,
          confidence: 0.9,
          reasoning: "rename across 8 modules — coordinated definition + imports + call sites",
        })
      )
    );

    const result = await classifyTask(
      "Rename DBConnection class across all 8 modules in src/db/"
    );

    expect(result.tier).toBe("complex");
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("Refactor function signature affecting 5 callers → complex", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 6,
          estimatedIterations: 25,
          needsSubagent: true,
          confidence: 0.88,
          reasoning: "signature change rippling through 5 callers — cross-cutting",
        })
      )
    );

    const result = await classifyTask(
      "Refactor signature of getUserId() affecting 5 callers"
    );

    expect(result.tier).toBe("complex");
    expect(result.fallbackUsed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase Q.8 update — Large-file classifier trigger
// ---------------------------------------------------------------------------

describe("Phase Q.8 update — Large-file classifier trigger", () => {
  function simpleResponse() {
    return buildResponse(
      JSON.stringify({
        tier: "simple",
        estimatedFiles: 1,
        estimatedIterations: 5,
        confidence: 0.9,
        reasoning: "single file edit",
      })
    );
  }

  it("bumps simple → medium when target file > 2000 LOC", async () => {
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());

    const result = await classifyTask(
      "Add a /api/version endpoint to src/api/server.ts",
      { targetFiles: ["src/api/server.ts"], _fileLineCounter: () => 4910 }
    );

    expect(result.tier).toBe("medium");
  });

  it("does not downgrade complex → medium for large files (no downgrade)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 10,
          estimatedIterations: 30,
          confidence: 0.9,
          reasoning: "cross-cutting change",
        })
      )
    );

    const result = await classifyTask(
      "Refactor entire codebase architecture",
      { targetFiles: ["src/small.ts"], _fileLineCounter: () => 50 }
    );

    expect(result.tier).toBe("complex");
  });

  it("does not bump medium (bump is simple-only)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 3,
          estimatedIterations: 12,
          confidence: 0.9,
          reasoning: "multi-file feature",
        })
      )
    );

    const result = await classifyTask(
      "Add feature touching src/api/server.ts and two others",
      { targetFiles: ["src/api/server.ts"], _fileLineCounter: () => 4910 }
    );

    expect(result.tier).toBe("medium");  // already medium, not bumped further
  });

  it("handles non-existent file gracefully — no bump (new file creation)", async () => {
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());

    const result = await classifyTask(
      "Create src/new-feature.ts with a new class",
      { targetFiles: ["src/new-feature.ts"], _fileLineCounter: () => 0 }
    );

    expect(result.tier).toBe("simple");
  });

  it("does not bump when file is under threshold", async () => {
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());

    const result = await classifyTask(
      "Fix typo in src/utils/helper.ts",
      { targetFiles: ["src/utils/helper.ts"], _fileLineCounter: () => 500 }
    );

    expect(result.tier).toBe("simple");
  });

  it("bumps when exactly at threshold+1 (boundary check)", async () => {
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());

    const result = await classifyTask(
      "Edit src/boundary.ts",
      { targetFiles: ["src/boundary.ts"], _fileLineCounter: () => 2001, skipCache: true }
    );

    expect(result.tier).toBe("medium");
  });

  it("does not bump when exactly at threshold (boundary check)", async () => {
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());

    const result = await classifyTask(
      "Edit src/exact.ts",
      { targetFiles: ["src/exact.ts"], _fileLineCounter: () => 2000, skipCache: true }
    );

    expect(result.tier).toBe("simple");
  });

  it("respects ZONE_LARGE_FILE_LOC env override", async () => {
    process.env.ZONE_LARGE_FILE_LOC = "500";
    try {
      mocks.createChatCompletion.mockResolvedValue(simpleResponse());

      const result = await classifyTask(
        "Edit src/medium-size.ts with custom threshold",
        { targetFiles: ["src/medium-size.ts"], _fileLineCounter: () => 600, skipCache: true }
      );

      expect(result.tier).toBe("medium");  // 600 > custom threshold 500
    } finally {
      delete process.env.ZONE_LARGE_FILE_LOC;
    }
  });

  it("no bump below custom ZONE_LARGE_FILE_LOC", async () => {
    process.env.ZONE_LARGE_FILE_LOC = "500";
    try {
      mocks.createChatCompletion.mockResolvedValue(simpleResponse());

      const result = await classifyTask(
        "Edit src/under-custom-threshold.ts",
        { targetFiles: ["src/under-custom-threshold.ts"], _fileLineCounter: () => 499, skipCache: true }
      );

      expect(result.tier).toBe("simple");
    } finally {
      delete process.env.ZONE_LARGE_FILE_LOC;
    }
  });

  it("extracts file paths from task description when targetFiles not provided", async () => {
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());

    const result = await classifyTask(
      "Add an endpoint to src/api/server.ts that reads package.json",
      {
        // No targetFiles — extracted from description text
        _fileLineCounter: (path) => (path.includes("server.ts") ? 4910 : 0),
        skipCache: true,
      }
    );

    expect(result.tier).toBe("medium");
  });

  it("emits [zone-tier-bumped] telemetry when bump fires", async () => {
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());

    await classifyTask(
      "Edit the large file for tier-bumped telemetry test",
      { targetFiles: ["src/server.ts"], _fileLineCounter: () => 5000, skipCache: true }
    );

    const bumpLog = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-bumped]"
    );
    expect(bumpLog).toBeDefined();
    const payload = JSON.parse(bumpLog![1] as string) as Record<string, unknown>;
    expect(payload.fromTier).toBe("simple");
    expect(payload.toTier).toBe("medium");
    expect(payload.reason).toBe("large_file_threshold");
    expect(payload.lineCount).toBe(5000);
    expect(payload.filePath).toBe("src/server.ts");
  });

  it("does not emit [zone-tier-bumped] when no bump occurs", async () => {
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());

    await classifyTask(
      "Small edit to src/tiny.ts no-bump test",
      { targetFiles: ["src/tiny.ts"], _fileLineCounter: () => 100, skipCache: true }
    );

    const bumpLog = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-bumped]"
    );
    expect(bumpLog).toBeUndefined();
  });

  it("emits [zone-tier-bump-skipped] when candidate file returns 0 lines (not found on disk)", async () => {
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());

    await classifyTask(
      "Edit nonexistent src/api/ghost.ts file",
      { targetFiles: ["src/api/ghost.ts"], _fileLineCounter: () => 0, skipCache: true }
    );

    const skipLog = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-bump-skipped]"
    );
    expect(skipLog).toBeDefined();
    const payload = JSON.parse(skipLog![1] as string) as Record<string, unknown>;
    expect(payload.event).toBe("tier_bump_skipped");
    expect(payload.tier).toBe("simple");
    expect(payload.candidateCount).toBe(1);
    const candidates = payload.candidates as Array<{ path: string; lineCount: number; exists: boolean }>;
    expect(candidates[0].path).toBe("src/api/ghost.ts");
    expect(candidates[0].lineCount).toBe(0);
    expect(candidates[0].exists).toBe(false);
  });

  it("classifyTask cache hit re-runs bump and upgrades stale entries", async () => {
    const taskText = "Edit the caching-bump-test file src/api/cache-bump-test.ts (unique q8 cache_rerun)";

    // First call: file is small → caches tier=simple
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());
    const first = await classifyTask(taskText, {
      targetFiles: ["src/api/cache-bump-test.ts"],
      _fileLineCounter: () => 100,
    });
    expect(first.tier).toBe("simple");

    consoleLogSpy.mockClear();

    // Second call: same task description (cache hit), but file is now large
    const second = await classifyTask(taskText, {
      targetFiles: ["src/api/cache-bump-test.ts"],
      _fileLineCounter: () => 5000,
    });
    expect(second.tier).toBe("medium");

    const bumpLog = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-bumped]"
    );
    expect(bumpLog).toBeDefined();
    const payload = JSON.parse(bumpLog![1] as string) as Record<string, unknown>;
    expect(payload.source).toBe("cache_rerun");
    expect(payload.fromTier).toBe("simple");
    expect(payload.toTier).toBe("medium");

    // Cache must store the upgraded tier
    const third = await classifyTask(taskText, {
      targetFiles: ["src/api/cache-bump-test.ts"],
      _fileLineCounter: () => 5000,
    });
    expect(third.tier).toBe("medium");
  });

  it("fresh-path [zone-tier-bumped] emit includes source: 'fresh'", async () => {
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());

    await classifyTask(
      "Fresh bump source tag test src/api/fresh-source-unique.ts",
      { targetFiles: ["src/api/fresh-source-unique.ts"], _fileLineCounter: () => 5000, skipCache: true }
    );

    const bumpLog = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-bumped]"
    );
    expect(bumpLog).toBeDefined();
    const payload = JSON.parse(bumpLog![1] as string) as Record<string, unknown>;
    expect(payload.source).toBe("fresh");
  });

  it("bumpForLargeFiles does NOT emit skipped when targetFiles empty or tier non-simple", async () => {
    // tier=medium, non-empty targetFiles → no emit of either kind
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(JSON.stringify({ tier: "medium", estimatedFiles: 2, estimatedIterations: 10, confidence: 0.9 }))
    );
    await classifyTask(
      "Medium tier task no bump emit src/api/medium-gate-unique.ts",
      { targetFiles: ["src/api/medium-gate-unique.ts"], _fileLineCounter: () => 5000, skipCache: true }
    );
    const skipMedium = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-bump-skipped]"
    );
    expect(skipMedium).toBeUndefined();

    consoleLogSpy.mockClear();

    // tier=simple, empty targetFiles → no emit of either kind
    mocks.createChatCompletion.mockResolvedValue(simpleResponse());
    await classifyTask(
      "Simple tier no-files bump-gate unique task",
      { targetFiles: [], skipCache: true }
    );
    const skipEmpty = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-bump-skipped]"
    );
    expect(skipEmpty).toBeUndefined();
    const bumpEmpty = consoleLogSpy.mock.calls.find(
      (call) => String(call[0] ?? "") === "[zone-tier-bumped]"
    );
    expect(bumpEmpty).toBeUndefined();
  });
});
