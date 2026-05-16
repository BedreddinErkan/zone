/**
 * Phase K.2 — classifier determinism + cache stability.
 *
 * These tests verify the properties that predictability-bounding relies on:
 *   1. Same task description → same hash → same cached result (no PRNG in path).
 *   2. CLASSIFIER_CONFIDENCE_THRESHOLD is a stable constant (not runtime-configurable).
 *   3. Fallback tier is always "medium" regardless of how the classifier fails.
 *   4. Cache is keyed on normalized (trimmed) task string — leading/trailing
 *      whitespace must not produce different classifications.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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

function buildResponse(jsonContent: string) {
  return {
    model: "gpt-5.4-mini",
    choices: [{ message: { content: jsonContent } }],
    usage: { prompt_tokens: 80, completion_tokens: 25 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearClassificationCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("K.2 — classifier determinism", () => {
  it("repeated calls with the same description return the identical object (cache hit)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "complex",
          estimatedFiles: 10,
          estimatedIterations: 30,
          needsSubagent: true,
          confidence: 0.88,
        })
      )
    );

    const task = "Rename the exported symbol across all 6 files";
    const r1 = await classifyTask(task);
    const r2 = await classifyTask(task);
    const r3 = await classifyTask(task);

    // All three must be reference-equal (same cached object, not a new copy).
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    // Underlying LLM was called exactly once.
    expect(mocks.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("leading/trailing whitespace is normalised — same cache slot as trimmed variant", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "simple",
          estimatedFiles: 1,
          estimatedIterations: 3,
          needsSubagent: false,
          confidence: 0.9,
        })
      )
    );

    const trimmed = "Add a comment above the export";
    const padded = `   ${trimmed}   `;

    const r1 = await classifyTask(trimmed);
    const r2 = await classifyTask(padded);

    expect(r1).toBe(r2);
    expect(mocks.createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("CLASSIFIER_CONFIDENCE_THRESHOLD is exactly 0.5 — the gate boundary is stable", () => {
    expect(CLASSIFIER_CONFIDENCE_THRESHOLD).toBe(0.5);
  });

  it("fallback tier is always 'medium' regardless of failure mode (timeout, parse, API error)", async () => {
    const failureModes = [
      // API error
      async () => {
        mocks.createChatCompletion.mockRejectedValueOnce(new Error("api_error"));
        return classifyTask(`api error ${Math.random()}`, { skipCache: true });
      },
      // Parse failure
      async () => {
        mocks.createChatCompletion.mockResolvedValueOnce(buildResponse("not json"));
        return classifyTask(`parse fail ${Math.random()}`, { skipCache: true });
      },
      // Timeout
      async () => {
        mocks.createChatCompletion.mockImplementationOnce(
          () => new Promise(() => undefined)
        );
        return classifyTask(`timeout ${Math.random()}`, {
          skipCache: true,
          timeoutMs: 60,
        });
      },
      // Invalid tier
      async () => {
        mocks.createChatCompletion.mockResolvedValueOnce(
          buildResponse(JSON.stringify({ tier: "ultra", confidence: 0.9 }))
        );
        return classifyTask(`bad tier ${Math.random()}`, { skipCache: true });
      },
    ];

    for (const invoke of failureModes) {
      const result = await invoke();
      expect(result.tier).toBe("medium");
      expect(result.fallbackUsed).toBe(true);
    }
  });

  it("clearClassificationCache causes subsequent call to re-invoke the LLM", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      buildResponse(
        JSON.stringify({
          tier: "medium",
          estimatedFiles: 4,
          estimatedIterations: 12,
          needsSubagent: false,
          confidence: 0.75,
        })
      )
    );

    const task = "stable cache clear task";
    await classifyTask(task);
    clearClassificationCache();
    await classifyTask(task);

    expect(mocks.createChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("different task descriptions produce different results (no hash collision on short inputs)", async () => {
    const responseA = buildResponse(
      JSON.stringify({
        tier: "simple",
        estimatedFiles: 1,
        estimatedIterations: 3,
        needsSubagent: false,
        confidence: 0.9,
      })
    );
    const responseB = buildResponse(
      JSON.stringify({
        tier: "complex",
        estimatedFiles: 12,
        estimatedIterations: 35,
        needsSubagent: true,
        confidence: 0.87,
      })
    );

    mocks.createChatCompletion
      .mockResolvedValueOnce(responseA)
      .mockResolvedValueOnce(responseB);

    const rA = await classifyTask("Add a comment to foo.ts");
    const rB = await classifyTask("Rename the exported type across all 8 consumers");

    expect(rA.tier).toBe("simple");
    expect(rB.tier).toBe("complex");
    expect(mocks.createChatCompletion).toHaveBeenCalledTimes(2);
  });
});
