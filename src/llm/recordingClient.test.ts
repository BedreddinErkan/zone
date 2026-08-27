import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../usage/usageTracker.js", () => ({
  recordExecution: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./openaiContext.js", () => ({
  getRequestContext: vi.fn().mockReturnValue(undefined),
}));

import { vi as viMock } from "vitest";
import { recordExecution } from "../usage/usageTracker.js";
import { RecordingLLMClient, extractUsage, _resetUsagePartitionWarningForTest } from "./recordingClient.js";
import { totalCost } from "../usage/pricing.js";
import type { LLMClient } from "./types.js";

function makeFakeStream(usage: unknown): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { choices: [], model: "m", usage };
    },
  };
}

function makeFakeInner(provider: "openai" | "anthropic", streamFn?: ReturnType<typeof vi.fn>) {
  return {
    provider,
    createChatCompletionStream: streamFn ?? vi.fn().mockResolvedValue(
      makeFakeStream({ prompt_tokens: 100, completion_tokens: 50 })
    ),
    createChatCompletion: vi.fn(),
    createEmbedding: vi.fn(),
  } as unknown as LLMClient;
}

describe("toProviderName — provider billing", () => {
  beforeEach(() => { vi.mocked(recordExecution).mockClear(); });

  it("openai provider → recordExecution called with provider='openai'", async () => {
    const client = new RecordingLLMClient(makeFakeInner("openai"));
    const stream = await client.createChatCompletionStream(
      { model: "gpt-5.4", messages: [], stream: true }
    );
    for await (const _ of stream) {}
    expect(vi.mocked(recordExecution)).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" })
    );
  });

  it("anthropic provider → recordExecution called with provider='anthropic'", async () => {
    const client = new RecordingLLMClient(makeFakeInner("anthropic"));
    const stream = await client.createChatCompletionStream(
      { model: "claude-sonnet-4-6", messages: [], stream: true }
    );
    for await (const _ of stream) {}
    expect(vi.mocked(recordExecution)).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic" })
    );
  });
});

describe("stream_options.include_usage — set for openai, not anthropic", () => {
  it("openai: include_usage:true injected", async () => {
    const streamFn = vi.fn().mockResolvedValue(makeFakeStream(null));
    const client = new RecordingLLMClient(makeFakeInner("openai", streamFn));
    await client.createChatCompletionStream(
      { model: "gpt-5.4", messages: [], stream: true }
    );
    expect(streamFn).toHaveBeenCalledWith(
      expect.objectContaining({ stream_options: { include_usage: true } }),
      expect.anything()
    );
  });

  it("anthropic: include_usage NOT injected", async () => {
    const streamFn = vi.fn().mockResolvedValue(makeFakeStream(null));
    const client = new RecordingLLMClient(makeFakeInner("anthropic", streamFn));
    await client.createChatCompletionStream(
      { model: "claude-sonnet-4-6", messages: [], stream: true }
    );
    const calledWith = streamFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(calledWith?.stream_options).toBeUndefined();
  });
});

// ── extractUsage: the OpenAI cache-write bucket ──────────────────────────────
//
// OpenAI reports its cache buckets inside prompt_tokens_details and its
// input_tokens is a TOTAL containing them. Anthropic reports them as top-level
// fields and its input_tokens already excludes them. extractUsage has to serve
// both without double-counting either.

describe("extractUsage — OpenAI cache buckets", () => {
  beforeEach(() => { _resetUsagePartitionWarningForTest(); });

  it("first call: cache_write > 0 with cache_read = 0 is carved out of input_uncached", () => {
    // THE boundary case. Before the fix the subtraction was gated on cache_read > 0,
    // so a pure cache-write call took the no-subtract branch and the written tokens
    // were counted twice: once inside input_uncached, once as cache_write.
    const usage = extractUsage({
      prompt_tokens: 10_000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 8_000 },
    });
    expect(usage).not.toBeNull();
    expect(usage!.cache_write).toBe(8_000);
    expect(usage!.cache_read).toBe(0);
    expect(usage!.input_uncached).toBe(2_000); // 10_000 − 8_000, NOT 10_000
    expect(usage!.input_uncached + usage!.cache_read + usage!.cache_write).toBe(10_000);
  });

  it("that same call prices as one bucket of writes, not writes plus full input", () => {
    // Where the double-count would have become dollars. gpt-5.6-luna: input $1,
    // cache_write $1.25 per MTok. Correct: 2_000×$1 + 8_000×$1.25 = $0.012.
    // Double-counted it would have been 10_000×$1 + 8_000×$1.25 = $0.020.
    const usage = extractUsage({
      prompt_tokens: 10_000,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 8_000 },
    })!;
    const cost = totalCost("openai", "gpt-5.6-luna", {
      input_uncached: usage.input_uncached,
      cache_write: usage.cache_write,
      cache_read: usage.cache_read,
      output: usage.output,
    });
    expect(cost).toBeCloseTo(0.012, 10);
    expect(cost).not.toBeCloseTo(0.020, 10);
  });

  it("reads and writes together both come out of input_uncached", () => {
    const usage = extractUsage({
      prompt_tokens: 50_000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 30_000, cache_write_tokens: 15_000 },
    })!;
    expect(usage.cache_read).toBe(30_000);
    expect(usage.cache_write).toBe(15_000);
    expect(usage.input_uncached).toBe(5_000);
    expect(usage.input_uncached + usage.cache_read + usage.cache_write).toBe(50_000);
  });

  it("no cache activity → byte-identical to the pre-change behaviour", () => {
    const usage = extractUsage({
      prompt_tokens: 1_234,
      completion_tokens: 56,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    })!;
    expect(usage.input_uncached).toBe(1_234);
    expect(usage.cache_read).toBe(0);
    expect(usage.cache_write).toBe(0);
  });

  it("Anthropic shape is untouched: its input_tokens already excludes the buckets", () => {
    // Anthropic must NOT subtract — 10_000 uncached stays 10_000 even with large
    // cache buckets alongside it.
    const usage = extractUsage({
      prompt_tokens: 10_000,
      completion_tokens: 500,
      cache_creation_input_tokens: 8_000,
      cache_read_input_tokens: 20_000,
    })!;
    expect(usage.input_uncached).toBe(10_000);
    expect(usage.cache_write).toBe(8_000);
    expect(usage.cache_read).toBe(20_000);
  });
});

describe("extractUsage — partition violation is announced, not silently clamped", () => {
  beforeEach(() => { _resetUsagePartitionWarningForTest(); });

  it("buckets exceeding input_tokens warn before the clamp", () => {
    // If OpenAI ever reports the cache buckets ADDITIVELY rather than as a subset,
    // the subtraction above is wrong. Math.max(0, …) alone would bury that; the
    // warning is what makes the wrong assumption discoverable.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const usage = extractUsage({
      prompt_tokens: 5_000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 4_000, cache_write_tokens: 3_000 },
    })!;

    expect(usage.input_uncached).toBe(0); // clamp still applies as a safety net
    expect(warn).toHaveBeenCalledTimes(1);
    const [marker, payload] = warn.mock.calls[0] as [string, string];
    expect(marker).toBe("[zone-usage-partition-violated]");
    const parsed = JSON.parse(payload) as { shortfall: number; cacheWrite: number };
    expect(parsed.shortfall).toBe(2_000); // 4_000 + 3_000 − 5_000
    expect(parsed.cacheWrite).toBe(3_000);
  });

  it("warns once per process, not once per request", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = {
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 },
    };
    extractUsage(bad);
    extractUsage(bad);
    extractUsage(bad);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the buckets fit inside input_tokens", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    extractUsage({
      prompt_tokens: 10_000,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 4_000, cache_write_tokens: 3_000 },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("pricing a gateway profile through the ledger (items 396/399)", () => {
  beforeEach(() => { vi.mocked(recordExecution).mockClear(); });

  /** A gateway as `gatewayProfilesFrom` builds one: inline rates, and NO named table. */
  const PRICED_GATEWAY = {
    id: "lab",
    protocol: "openai-chat" as const,
    adapterProvider: "openai" as const,
    baseUrl: "http://localhost:4000/v1",
    keyRef: { envVar: "ZONE_GATEWAY_KEY_LAB", keyExample: "x" },
    pricing: {
      rates: {
        "openai/gpt-4o-mini": { input: 0.15, output: 0.6, cache_read: 0, cache_write: 0 },
      },
    },
  };

  async function runStream(profile: unknown, model: string, usage: unknown) {
    const inner = makeFakeInner("openai", vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () { yield { choices: [], model, usage }; },
    }));
    const client = new RecordingLLMClient(inner, profile as never);
    const stream = await client.createChatCompletionStream(
      { model, messages: [], stream: true } as never
    );
    for await (const _ of stream as AsyncIterable<unknown>) { /* drain */ }
    return vi.mocked(recordExecution).mock.calls[0]?.[0];
  }

  it("prices a gateway model from the profile's OWN inline rates, which no global table knows", async () => {
    const rec = await runStream(PRICED_GATEWAY, "openai/gpt-4o-mini", {
      prompt_tokens: 1_000_000, completion_tokens: 1_000_000,
    });
    // 1M input at $0.15 + 1M output at $0.60. totalCost() could never produce this: the model id
    // is absent from PRICING_USD_PER_MTOK entirely, so the global lookup returns 0.
    expect(rec?.est_cost_usd).toBeCloseTo(0.75, 10);
    expect(rec?.unpriceable).toBeUndefined();
    expect(totalCost("openai", "openai/gpt-4o-mini", {
      input_uncached: 1_000_000, cache_write: 0, cache_read: 0, output: 1_000_000,
    })).toBe(0);
  });

  it("THE REGRESSION THIS PASS EXISTS TO AVOID: rates that do not cover THIS model stay unknown, not 0", async () => {
    // Before the fix, `unpriceable` keyed on `profile.pricing` merely being PRESENT. A profile with
    // rates for some other model would therefore drop the flag, fall through to the adapter's
    // vendor table, miss, and record a confident `0` — which the daily cap sums as real spend,
    // where a null is correctly skipped. Strictly worse than recording nothing.
    const rec = await runStream(PRICED_GATEWAY, "some-other-model", {
      prompt_tokens: 1_000_000, completion_tokens: 1_000_000,
    });
    expect(rec?.unpriceable).toBe(true);
    expect(rec?.est_cost_usd).toBeUndefined();
  });

  it("an unpriced gateway is unchanged — still unknown, never zero", async () => {
    const { pricing: _dropped, ...unpriced } = PRICED_GATEWAY;
    const rec = await runStream(unpriced, "openai/gpt-4o-mini", {
      prompt_tokens: 1000, completion_tokens: 1000,
    });
    expect(rec?.unpriceable).toBe(true);
    expect(rec?.est_cost_usd).toBeUndefined();
  });

  it("a built-in profile still prices through its named table, byte-identical", async () => {
    const rec = await runStream(undefined, "gpt-4o", {
      prompt_tokens: 1_000_000, completion_tokens: 1_000_000,
    });
    const expected = totalCost("openai", "gpt-4o", {
      input_uncached: 1_000_000, cache_write: 0, cache_read: 0, output: 1_000_000,
    });
    expect(rec?.est_cost_usd).toBeCloseTo(expected, 10);
    expect(rec?.unpriceable).toBeUndefined();
  });
});
