import { describe, expect, it, vi } from "vitest";
import { summarize } from "./summarizer.js";
import type { LLMClient } from "../types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * Item 254/255: summarize()'s own billed call previously discarded `response.usage` and the
 * resolved model after extracting only `inputTokens`/`outputTokens` from it — the compaction
 * call site was one of the four that never fed the loop's cost meter. This pins the two new
 * fields (`rawUsage`, `model`) that make that call recordable, testing the real implementation
 * (only the LLM client is mocked — compaction.test.ts mocks `summarize` itself, so this is the
 * one place the real extraction logic is exercised).
 */
describe("summarize() — carries the full usage and resolved model through (item 255)", () => {
  function makeClient(usage: unknown): LLMClient {
    return {
      provider: "anthropic",
      createChatCompletion: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "summary text", tool_calls: null }, finish_reason: "stop" }],
        model: "claude-sonnet-4-6",
        usage,
      }),
      createChatCompletionStream: vi.fn(),
      createEmbedding: vi.fn(),
    };
  }

  const turns: ChatCompletionMessageParam[] = [{ role: "assistant", content: "some turn" }];

  it("rawUsage is the exact response.usage object, not a narrowed subset", async () => {
    const usage = {
      prompt_tokens: 4000,
      completion_tokens: 300,
      cache_read_input_tokens: 1200,
      cache_creation_input_tokens: 0,
    };
    const output = await summarize({
      candidateTurns: turns,
      totalCandidates: 1,
      client: makeClient(usage),
      runId: "r1",
      compactionDepth: 1,
    });
    expect(output.rawUsage).toEqual(usage);
    // The narrowed fields still work — this is additive, not a replacement.
    expect(output.inputTokens).toBe(4000);
    expect(output.outputTokens).toBe(300);
  });

  it("model is populated, non-empty, and independent of inputTokens/outputTokens", async () => {
    const output = await summarize({
      candidateTurns: turns,
      totalCandidates: 1,
      client: makeClient({ prompt_tokens: 10, completion_tokens: 5 }),
      runId: "r1",
      compactionDepth: 1,
    });
    expect(typeof output.model).toBe("string");
    expect(output.model!.length).toBeGreaterThan(0);
  });

  it("rawUsage is present even when the narrowed prompt_tokens/completion_tokens are absent (OpenAI cache-bucket shape)", async () => {
    // Regression guard for the exact shape this fix must not narrow away: a usage object
    // whose cache buckets live under prompt_tokens_details rather than as top-level fields.
    const usage = {
      prompt_tokens: 500,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 100 },
    };
    const output = await summarize({
      candidateTurns: turns,
      totalCandidates: 1,
      client: makeClient(usage),
      runId: "r1",
      compactionDepth: 1,
    });
    expect(output.rawUsage).toEqual(usage);
  });
});
