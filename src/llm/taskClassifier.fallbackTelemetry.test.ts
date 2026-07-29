import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyTask, clearClassificationCache } from "./taskClassifier.js";

/**
 * A classification that failed used to look like a normal run.
 *
 * The dogfood cascade logged `invalid tier: investigation` inside a free-text
 * error message, and `fallbackUsed:true` with `confidence:0` alongside it — but
 * nothing said what was rejected, what replaced it, or that the response had
 * been cut off at the output cap. When the log was lost, the evidence was gone
 * and the failure had to be re-derived against a live classifier.
 *
 * `[zone-classifier-fallback]` is that evidence, emitted at the moment of loss.
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

function respond(
  payload: Record<string, unknown> | string,
  finishReason: string = "stop"
) {
  return {
    model: "claude-haiku-4-5",
    choices: [
      {
        message: {
          content: typeof payload === "string" ? payload : JSON.stringify(payload),
        },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  };
}

const GOOD = {
  tier: "medium",
  estimatedFiles: 4,
  estimatedIterations: 12,
  confidence: 0.9,
  archetype: "refactor",
  archetypeConfidence: 0.85,
};

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

/** Every [zone-classifier-fallback] payload emitted during the test. */
function events(): Array<Record<string, unknown>> {
  return warnSpy.mock.calls
    .filter((c) => c[0] === "[zone-classifier-fallback]")
    .map((c) => JSON.parse(c[1] as string) as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearClassificationCache();
  delete process.env.ZONE_FALLBACK_ARCHETYPE;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("truncation is detected, not inferred", () => {
  it("reports a truncated response that parsed anyway", async () => {
    // The measured majority case: 6 of 14 calls hit the cap, and the JSON
    // survived only because it preceded the prose the model appended. Inferring
    // truncation from a parse failure would report none of these.
    mocks.createChatCompletion.mockResolvedValue(respond(GOOD, "length"));

    const r = await classifyTask("Trace the tool result path");

    const [evt] = events();
    expect(evt).toBeDefined();
    expect(evt.reason).toBe("truncated");
    expect(evt.classificationSurvived).toBe(true);
    // The classification itself is untouched — this is a warning, not a fallback.
    expect(r.tier).toBe("medium");
    expect(r.fallbackUsed).toBe(false);
  });

  it("carries the model's own output, which is the evidence that was missing", async () => {
    mocks.createChatCompletion.mockResolvedValue(respond(GOOD, "length"));

    await classifyTask("Trace something else");

    const [evt] = events();
    expect(typeof evt.rawResponse).toBe("string");
    expect(evt.rawResponse as string).toContain("\"archetype\"");
  });

  it("reports a truncated response that destroyed the classification", async () => {
    // Rationale-first ordering: the cut lands inside the JSON.
    mocks.createChatCompletion.mockResolvedValue(
      respond('Rationale: this is a read-only task.\n\n{"tier": "med', "length")
    );

    await classifyTask("Trace a third thing");

    const truncated = events().find((e) => e.reason === "truncated");
    expect(truncated).toBeDefined();
    expect(truncated!.classificationSurvived).toBe(false);
    // Both facts are recorded: the response was cut AND the call fell back.
    expect(events().map((e) => e.reason)).toContain("error");
  });

  it("stays silent when the model finished on its own", async () => {
    mocks.createChatCompletion.mockResolvedValue(respond(GOOD, "stop"));

    await classifyTask("A perfectly normal task");

    expect(events()).toHaveLength(0);
  });
});

describe("the other three reasons name what was rejected and what replaced it", () => {
  it("invalid_tier records the rejected value and that the archetype was kept", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      respond({ ...GOOD, tier: "investigation", archetype: "investigation", archetypeConfidence: 0.9 })
    );

    await classifyTask("Trace how a tool result reaches the message history");

    const evt = events().find((e) => e.reason === "invalid_tier");
    expect(evt).toBeDefined();
    expect(evt!.rejectedField).toBe("tier");
    expect(evt!.rejectedValue).toBe("investigation");
    expect(evt!.archetypeSource).toBe("model");
    expect(evt!.fellBackTo).toEqual({ tier: "medium", archetype: "investigation" });
  });

  it("low_tier_confidence distinguishes a kept archetype from a configured one", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      respond({ ...GOOD, confidence: 0.4, archetype: "investigation", archetypeConfidence: 0.95 })
    );

    await classifyTask("Walk me through the gates");

    const evt = events().find((e) => e.reason === "low_tier_confidence");
    expect(evt!.archetypeSource).toBe("model");
    expect(evt!.fellBackTo).toEqual({ tier: "medium", archetype: "investigation" });
  });

  it("says plainly when the archetype is configuration rather than judgement", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      respond({ ...GOOD, confidence: 0.3, archetypeConfidence: 0.1 })
    );

    await classifyTask("Do the thing");

    const evt = events().find((e) => e.reason === "low_tier_confidence");
    expect(evt!.archetypeSource).toBe("fallback");
    expect(evt!.impact as string).toContain("ZONE_FALLBACK_ARCHETYPE");
  });

  it("error records the transport failure and the archetype's provenance", async () => {
    mocks.createChatCompletion.mockRejectedValue(new Error("connection reset"));

    await classifyTask("Anything");

    const evt = events().find((e) => e.reason === "error");
    expect(evt!.rejectedValue).toBe("connection reset");
    expect(evt!.archetypeSource).toBe("fallback");
    expect(evt!.fellBackTo).toEqual({ tier: "medium", archetype: "refactor" });
  });
});

describe("loud enough to survive the TUI", () => {
  it("goes to stderr, where the stdout shield cannot swallow it", async () => {
    // stdoutShield drops every line matching /^\[[a-z_][a-z0-9_-]*\]\s/, so a
    // `log()` here would be invisible in the one place a user would look.
    // stderr passes through under ZONE_TUI_DEBUG=1 / ZONE_VERBOSE_LOGS=1.
    mocks.createChatCompletion.mockResolvedValue(respond(GOOD, "length"));

    await classifyTask("Trace yet another thing");

    expect(events()).toHaveLength(1);
    const onStdout = logSpy.mock.calls.filter((c) => c[0] === "[zone-classifier-fallback]");
    expect(onStdout).toHaveLength(0);
  });
});
