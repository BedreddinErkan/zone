import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyTask, clearClassificationCache } from "./taskClassifier.js";

/**
 * Tier and archetype arrive in one classifier response but are two independent
 * judgements — the prompt itself calls them "orthogonal to tier". The code used
 * to couple them in two places, and both turned a run the classifier had
 * correctly called read-only into a patch run:
 *
 *   1. tier was validated first and threw, discarding the archetype with it;
 *   2. low *tier* confidence replaced the archetype with ZONE_FALLBACK_ARCHETYPE
 *      (default `refactor`) — no parse error required.
 *
 * Observed as `invalid tier: investigation` → tier medium / archetype refactor,
 * which then ran 10 iterations in patch mode on a read-only trace task.
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

function respond(payload: Record<string, unknown>) {
  return {
    model: "claude-haiku-4-5",
    choices: [{ message: { content: JSON.stringify(payload) } }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  };
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearClassificationCache();
  delete process.env.ZONE_FALLBACK_ARCHETYPE;
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
});

describe("an unusable tier no longer destroys the archetype", () => {
  it("keeps `investigation` when the model puts it in the tier field", async () => {
    // The exact shape behind the dogfood cascade.
    mocks.createChatCompletion.mockResolvedValue(
      respond({
        tier: "investigation",
        estimatedFiles: 4,
        estimatedIterations: 8,
        confidence: 0.75,
        archetype: "investigation",
        archetypeConfidence: 0.9,
      })
    );

    const r = await classifyTask("Trace how a tool result reaches the message history");

    // The archetype survives. This is the whole point: it selects
    // QUESTION_PIPELINE downstream, which is read-only.
    expect(r.archetype).toBe("investigation");
    expect(r.archetypeConfidence).toBe(0.9);
    // ...and specifically is no longer the patch archetype it used to become.
    expect(r.archetype).not.toBe("refactor");

    // The tier still degrades exactly as it did before, and still says so.
    expect(r.tier).toBe("medium");
    expect(r.confidence).toBe(0);
    expect(r.fallbackUsed).toBe(true);
  });

  it("degrades an unrecognised tier that is not archetype vocabulary either", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      respond({
        tier: "enormous",
        estimatedFiles: 2,
        estimatedIterations: 5,
        confidence: 0.9,
        archetype: "targeted_fix",
        archetypeConfidence: 0.88,
      })
    );

    const r = await classifyTask("Fix the off-by-one in src/pager.ts");

    expect(r.tier).toBe("medium");
    expect(r.confidence).toBe(0);
    expect(r.archetype).toBe("targeted_fix");
  });

  it("adopts the misplaced value when the archetype field is unusable", async () => {
    // No archetype field at all — the misplaced tier value is then the only
    // archetype signal in the response.
    mocks.createChatCompletion.mockResolvedValue(
      respond({
        tier: "question",
        estimatedFiles: 1,
        estimatedIterations: 2,
        confidence: 0.9,
        archetypeConfidence: 0.9,
      })
    );

    const r = await classifyTask("What files define the tier limits?");

    expect(r.archetype).toBe("question");
  });

  it("adoption recovers a signal, it does not manufacture confidence in one", async () => {
    // Same shape, but the model was not confident in the archetype. An adopted
    // archetype is gated exactly like a correctly-placed one, so it does not
    // survive: the confidence gate forces complex_multi_file, and the zeroed tier
    // confidence then routes through the untrusted-classification fallback.
    mocks.createChatCompletion.mockResolvedValue(
      respond({
        tier: "investigation",
        estimatedFiles: 1,
        estimatedIterations: 2,
        confidence: 0.9,
        archetypeConfidence: 0.2,
      })
    );

    const r = await classifyTask("Something ambiguous about the loop");

    expect(r.archetype).not.toBe("investigation");
    expect(r.archetype).toBe("refactor");
    expect(r.archetypeConfidence).toBe(0);
  });
});

describe("tier confidence governs tier, not archetype", () => {
  it("keeps a confident archetype when the tier confidence is low", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      respond({
        tier: "complex",
        estimatedFiles: 9,
        estimatedIterations: 30,
        confidence: 0.4, // below threshold — tier is not trustworthy
        archetype: "investigation",
        archetypeConfidence: 0.95, // ...but the archetype is
      })
    );

    const r = await classifyTask("Walk me through the compaction gates");

    expect(r.archetype).toBe("investigation");
    expect(r.archetypeConfidence).toBe(0.95);
    // The tier fallback itself is unchanged.
    expect(r.tier).toBe("medium");
    expect(r.fallbackUsed).toBe(true);
  });

  it("still falls back to the configured archetype when neither is trustworthy", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      respond({
        tier: "complex",
        estimatedFiles: 9,
        estimatedIterations: 30,
        confidence: 0.3,
        archetype: "investigation",
        archetypeConfidence: 0.1,
      })
    );

    const r = await classifyTask("Do the thing with the stuff");

    expect(r.archetype).toBe("refactor");
    expect(r.archetypeConfidence).toBe(0);
  });

  it("a real transport failure still has no archetype signal to keep", async () => {
    // The catch path is untouched: when the call itself fails there is genuinely
    // nothing to preserve, and ZONE_FALLBACK_ARCHETYPE remains correct there.
    mocks.createChatCompletion.mockRejectedValue(new Error("connection reset"));

    const r = await classifyTask("Anything at all");

    expect(r.archetype).toBe("refactor");
    expect(r.fallbackUsed).toBe(true);
    expect(r.confidence).toBe(0);
  });
});

describe("the healthy path is unchanged", () => {
  it("passes a well-formed classification through untouched", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      respond({
        tier: "complex",
        estimatedFiles: 12,
        estimatedIterations: 30,
        confidence: 0.9,
        reasoning: "cross-cutting rename",
        archetype: "refactor",
        archetypeConfidence: 0.85,
      })
    );

    const r = await classifyTask("Rename createThing to buildThing across the repo");

    expect(r.tier).toBe("complex");
    expect(r.confidence).toBe(0.9);
    expect(r.archetype).toBe("refactor");
    expect(r.fallbackUsed).toBe(false);
  });

  it("does not leak the diagnostic field into the classification", async () => {
    // `rejectedTier` is for telemetry. Every consumer of TaskClassification
    // reads a fixed shape; a field that appears only on the degraded path is
    // exactly the kind of thing that grows a dependency by accident.
    mocks.createChatCompletion.mockResolvedValue(
      respond({
        tier: "simple",
        estimatedFiles: 1,
        estimatedIterations: 3,
        confidence: 0.95,
        archetype: "simple_add",
        archetypeConfidence: 0.9,
      })
    );

    const r = await classifyTask("Add a named export to src/index.ts");

    expect(r).not.toHaveProperty("rejectedTier");
  });
});
