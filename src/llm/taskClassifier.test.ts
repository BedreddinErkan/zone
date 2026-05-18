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
    expect(result.needsSubagent).toBe(false);
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
      needsSubagent: false,
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
  it("Test 4 wording (rename across all 5 files where defined or used) → complex + needsSubagent", async () => {
    // This is the exact wording that production routed to medium/needsSubagent:false.
    // Q.8: when the LLM picks complex, needsSubagent is force-derived to true.
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 5,
          estimatedIterations: 20,
          needsSubagent: false, // LLM may still say false — override forces true
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
    expect(result.needsSubagent).toBe(true); // derived from tier === complex
    expect(result.fallbackUsed).toBeUndefined();
  });

  it("rename across 3 explicitly-listed files → complex", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 3,
          estimatedIterations: 15,
          needsSubagent: true,
          confidence: 0.8,
          reasoning: "explicit 3-file rename with coordinated edits",
        })
      )
    );

    const result = await classifyTask(
      "Rename helperA to helperB in src/a.ts, src/b.ts, and src/c.ts"
    );

    expect(result.tier).toBe("complex");
    expect(result.needsSubagent).toBe(true);
  });

  it("rename in only 2 files → stays medium (count below threshold)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 2,
          estimatedIterations: 8,
          needsSubagent: false,
          confidence: 0.85,
          reasoning: "small-scope 2-file rename",
        })
      )
    );

    const result = await classifyTask("Rename foo to bar in 2 files");

    expect(result.tier).toBe("medium");
    // medium + estimatedFiles < 4 → respect LLM's needsSubagent:false
    expect(result.needsSubagent).toBe(false);
  });

  it("add new export to 5 files (pure additions, no rename) → medium", async () => {
    // Pure additions don't require coordinated FIND/REPLACE.
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 5,
          estimatedIterations: 15,
          needsSubagent: false, // LLM said no, but override flips it (medium + 5 files)
          confidence: 0.78,
          reasoning: "pure additions to 5 modules, no rename coordination",
        })
      )
    );

    const result = await classifyTask(
      "Add a new helper export to 5 files: src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts"
    );

    expect(result.tier).toBe("medium");
    // Q.8: medium + estimatedFiles >= 4 → needsSubagent forced to true
    expect(result.needsSubagent).toBe(true);
  });

  it("needsSubagent auto-derives to true when tier === complex even if LLM says false", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 8,
          estimatedIterations: 30,
          needsSubagent: false, // intentionally wrong
          confidence: 0.9,
        })
      )
    );

    const result = await classifyTask("complex-but-llm-said-no task");

    expect(result.tier).toBe("complex");
    expect(result.needsSubagent).toBe(true);
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
    expect(result.needsSubagent).toBe(true);
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
    expect(result.needsSubagent).toBe(true);
    expect(result.fallbackUsed).toBeUndefined();
  });
});
