import { describe, it, expect } from "vitest";
import {
  ZONE_PROVIDER_FIELD,
  readProviderState,
  stripProviderState,
  type ProviderThinkingBlock,
} from "./anthropicAdapter/thinkingBlocks.js";

/**
 * The envelope degrades before it gives up.
 *
 * `serializeMessagesForEnvelope` drops the whole history above 1MB. At xhigh/max
 * effort the thinking floors are 32000/64000 tokens, so a single turn can carry
 * ~126-251KB and the cap arrives in 4-8 turns — on exactly the long runs, and
 * the parked runs, that most need resume. Stripping thinking first restores the
 * history to precisely its pre-passthrough shape, so the envelope can never be
 * larger than it was before that feature existed.
 */

const SIGNATURE = "ErUBCkYIAxgCIkDx7f2vQ9k1mZ0nR8sT4uV6wX2yZ0aB3cD5eF7gH9iJ==";

function block(sizeChars: number): ProviderThinkingBlock {
  return { type: "thinking", thinking: "t".repeat(sizeChars), signature: SIGNATURE };
}

function assistant(i: number, thinkingChars: number | null): Record<string, unknown> {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: `c${i}`, type: "function", function: { name: "read_file", arguments: `{"filePath":"f${i}.ts"}` } },
    ],
    ...(thinkingChars === null
      ? {}
      : { [ZONE_PROVIDER_FIELD]: { blocks: [block(thinkingChars)], model: "claude-opus-5" } }),
  };
}

function toolResult(i: number, chars: number): Record<string, unknown> {
  return { role: "tool", tool_call_id: `c${i}`, content: "x".repeat(chars) };
}

describe("stripProviderState", () => {
  it("removes the passthrough and leaves everything else identical", () => {
    const withThinking = assistant(1, 500);
    const [stripped] = stripProviderState([withThinking]);

    expect(readProviderState(stripped)).toBeNull();
    expect(stripped).not.toHaveProperty(ZONE_PROVIDER_FIELD);
    expect((stripped as { tool_calls: unknown }).tool_calls).toBe(withThinking.tool_calls);
    expect((stripped as { role: string }).role).toBe("assistant");
  });

  it("restores exactly the pre-passthrough shape", () => {
    // The property that makes this safe to ship: the envelope can never be
    // larger than it was before thinking capture existed.
    const withThinking = [assistant(1, 5000), toolResult(1, 100)];
    const never = [assistant(1, null), toolResult(1, 100)];
    expect(JSON.stringify(stripProviderState(withThinking))).toBe(JSON.stringify(never));
  });

  it("passes messages without the field through by reference", () => {
    // No needless copying, and no risk of dropping a field this helper does not
    // know about on a message it has no reason to touch.
    const plain = toolResult(1, 10);
    const out = stripProviderState([plain]);
    expect(out[0]).toBe(plain);
  });

  it("is a no-op on a history that never had thinking", () => {
    const history = [assistant(1, null), toolResult(1, 50)];
    expect(stripProviderState(history)).toEqual(history);
  });
});

describe("the size ladder the envelope walks", () => {
  const CAP = 1_000_000;

  it("thinking is what pushes a realistic history over the cap", () => {
    // xhigh floor: 32000 thinking tokens ~ 128000 chars per turn.
    const history: Record<string, unknown>[] = [];
    for (let i = 1; i <= 8; i++) history.push(assistant(i, 128_000), toolResult(i, 2_000));

    const full = JSON.stringify(history).length;
    const stripped = JSON.stringify(stripProviderState(history)).length;

    expect(full).toBeGreaterThan(CAP);
    expect(stripped).toBeLessThan(CAP);
    // The conversation itself is a rounding error next to the thinking.
    expect(stripped).toBeLessThan(full / 10);
  });

  it("a history that is oversized without thinking still has to be dropped", () => {
    // The ladder has a bottom rung, and the loud marker still means what it
    // meant: this one is not rescuable by stripping.
    const history: Record<string, unknown>[] = [];
    for (let i = 1; i <= 12; i++) history.push(assistant(i, 1_000), toolResult(i, 120_000));

    expect(JSON.stringify(history).length).toBeGreaterThan(CAP);
    expect(JSON.stringify(stripProviderState(history)).length).toBeGreaterThan(CAP);
  });
});

describe("which limit binds first — measured, because it decides reachability", () => {
  // Both limits measure the same serialized history, so they are directly
  // comparable: the envelope cap is 1,000,000 bytes and the compaction trigger
  // is 0.75 x contextWindow in chars/4. Crossover is a ~333k-token window.
  const ENVELOPE_CAP_BYTES = 1_000_000;
  const ENVELOPE_CAP_TRIGGER_TOKENS = ENVELOPE_CAP_BYTES / 4;
  const COMPACTION_RATIO = 0.75;

  const bindsFirst = (window: number) =>
    window * COMPACTION_RATIO < ENVELOPE_CAP_TRIGGER_TOKENS ? "compaction" : "envelope";

  it("compaction binds first on a 200k window, so the degrade rung never fires there", () => {
    // Haiku 4.5 is the only 200k model left in the catalog. Compaction shrinks
    // the history at ~600KB, well before the 1MB envelope cap — which is why an
    // end-to-end degrade test on a default-model run cannot reach this path, and
    // why the ladder is unit-tested instead.
    expect(bindsFirst(200_000)).toBe("compaction");
  });

  it("the envelope cap binds first on the 1M-window models, where the degrade rung earns its keep", () => {
    expect(bindsFirst(1_000_000)).toBe("envelope");
    expect(bindsFirst(400_000)).toBe("envelope");
  });

  it("the crossover is a ~333k-token window", () => {
    const crossover = ENVELOPE_CAP_TRIGGER_TOKENS / COMPACTION_RATIO;
    expect(Math.round(crossover)).toBe(333_333);
    expect(bindsFirst(crossover - 1)).toBe("compaction");
    expect(bindsFirst(crossover + 1)).toBe("envelope");
  });
});
