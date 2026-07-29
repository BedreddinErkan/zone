import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyTask, clearClassificationCache } from "./taskClassifier.js";
import { getMaxOutputTokens } from "./models.js";

/**
 * The classifier's output cap used to be a bare 300, and it was not a safety net
 * — it was the operating point. 6 of 14 measured calls on read-only tasks hit
 * it. The classification survived those only because the JSON happened to
 * precede the prose the model appended, which is luck, not a property.
 *
 * Two things changed. The prompt now asks for JSON only, which is what actually
 * bounds the response (measured: 248 -> 111 average output tokens, 3/6 -> 0/6
 * truncated, 3.83s -> 1.75s mean latency). And the cap became model-aware, so it
 * stops being the only thing between the classifier and a silent truncation.
 */

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

function goodResponse() {
  return {
    model: "claude-haiku-4-5",
    choices: [
      {
        message: {
          content: JSON.stringify({
            tier: "medium",
            estimatedFiles: 3,
            estimatedIterations: 10,
            confidence: 0.9,
            archetype: "refactor",
            archetypeConfidence: 0.9,
          }),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  };
}

/** The request body the classifier actually sent. */
function sentRequest(): Record<string, unknown> {
  return mocks.createChatCompletion.mock.calls[0][0] as Record<string, unknown>;
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearClassificationCache();
  delete process.env.ZONE_CLASSIFIER_MODEL_ANTHROPIC;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.createChatCompletion.mockResolvedValue(goodResponse());
});

afterEach(() => {
  delete process.env.ZONE_CLASSIFIER_MODEL_ANTHROPIC;
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("the output cap is a safety net, not the operating point", () => {
  it("no longer sends the 300-token literal that was binding", async () => {
    await classifyTask("Rename a symbol across the repo");

    const budget = sentRequest().max_completion_tokens as number;
    expect(budget).toBeGreaterThan(300);
    // ~8x headroom over the measured 111-token operating point (max 120).
    expect(budget).toBe(1024);
  });

  it("never exceeds the model's own ceiling", async () => {
    // The invariant that makes this model-aware rather than another literal.
    // Every model in the catalog today has a ceiling well above 1024, so the
    // clamp is protective rather than active — it exists so a model with a
    // smaller ceiling than the classifier's budget cannot 400 by over-asking.
    for (const model of ["claude-haiku-4-5", "gpt-4o-mini", "claude-opus-5"]) {
      vi.clearAllMocks();
      clearClassificationCache();
      mocks.createChatCompletion.mockResolvedValue(goodResponse());
      process.env.ZONE_CLASSIFIER_MODEL_ANTHROPIC = model;

      await classifyTask(`Task for ${model}`);

      const budget = sentRequest().max_completion_tokens as number;
      expect(budget).toBeLessThanOrEqual(getMaxOutputTokens(model));
    }
  });
});

describe("the prompt is what bounds the response", () => {
  it("asks for the JSON object and nothing else", async () => {
    await classifyTask("Trace something");

    const messages = sentRequest().messages as Array<{ role: string; content: string }>;
    const system = messages.find((m) => m.role === "system")!.content;

    expect(system).toContain("nothing else");
    expect(system).toContain("no prose");
    expect(system).toContain("no markdown fences");
  });

  it("still asks for every field the parser reads", async () => {
    // The instruction is appended, not a rewrite — the schema above it is what
    // makes the response parseable at all.
    await classifyTask("Trace something else");

    const messages = sentRequest().messages as Array<{ role: string; content: string }>;
    const system = messages.find((m) => m.role === "system")!.content;

    for (const field of [
      "tier", "estimatedFiles", "estimatedIterations",
      "confidence", "archetype", "archetypeConfidence",
    ]) {
      expect(system).toContain(`"${field}"`);
    }
  });
});
