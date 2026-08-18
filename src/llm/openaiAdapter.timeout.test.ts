/**
 * Request-duration configuration for the OpenAI adapter (ledger item 57).
 *
 * Mirrors `anthropicAdapter.timeout.test.ts`, because the two adapters now share one derivation and
 * one dispatcher. Two things must hold together, and neither is sufficient alone:
 *
 *   1. The SDK's per-request timeout is derived from the call's own output budget. A non-streaming
 *      request holds one connection for the whole generation, so its deadline has to scale with how
 *      much output it may produce — `gpt-5.x` carries a 128,000-token ceiling.
 *   2. The transport's timers sit above every value that derivation can produce. This is the half
 *      that was actually broken: the SDK clears its own timer as soon as `fetch` resolves, so
 *      undici's `headersTimeout` is what really bounds a non-streaming call. With no dispatcher
 *      that was the global Agent's 300s default — half the SDK's own configured value, and the
 *      operative ceiling on every OpenAI request Zone made.
 *
 * The streaming and embedding paths are deliberately left on the constructor floor; see the
 * comments at those call sites. No assertion here pins a derived per-request value onto them,
 * because doing so would encode a choice the adapter deliberately does not make.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIAdapter } from "./openaiAdapter.js";
import {
  deriveRequestTimeoutMs,
  TRANSPORT_TIMEOUT_MS,
  zoneDispatcher,
} from "./requestTimeouts.js";

// ── Hoisted SDK mock ──────────────────────────────────────────────────────────

const mockCreate = vi.hoisted(() => vi.fn());
const mockResponsesCreate = vi.hoisted(() => vi.fn());
const mockCtor = vi.hoisted(() =>
  vi.fn(() => ({
    chat: { completions: { create: mockCreate } },
    responses: { create: mockResponsesCreate },
    embeddings: { create: vi.fn() },
  }))
);

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai")>();
  return { ...actual, default: mockCtor };
});

function okCompletion() {
  return {
    id: "x",
    model: "m",
    choices: [{ message: { content: "ok", tool_calls: null }, finish_reason: "stop", index: 0 }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function okResponsesPayload() {
  return {
    id: "resp_x",
    model: "gpt-5.5-2026-04-23",
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

/** Options bag from the Nth recorded call to a mocked `create`. */
function optsOf(mock: { mock: { calls: unknown[][] } }, n = 0): { timeout?: number } {
  return (mock.mock.calls[n] as [unknown, { timeout?: number }])[1];
}

beforeEach(() => {
  mockCreate.mockReset();
  mockResponsesCreate.mockReset();
  mockCtor.mockClear();
});

describe("client construction", () => {
  it("constructor pins a dispatcher, without which the timers stay at undici's 300s", () => {
    new OpenAIAdapter("sk-test");
    const opts = mockCtor.mock.calls[0]?.[0] as Record<string, unknown>;
    const fetchOptions = opts.fetchOptions as { dispatcher?: unknown } | undefined;
    expect(fetchOptions?.dispatcher).toBeDefined();
    // Identity, not merely presence: both adapters must share one connection pool, so a second
    // Agent constructed here would be a different defect wearing this test's passing result.
    expect(fetchOptions?.dispatcher).toBe(zoneDispatcher);
  });

  it("constructor keeps a positive numeric timeout as the floor for paths with no derived value", () => {
    new OpenAIAdapter("sk-test");
    const opts = mockCtor.mock.calls[0]?.[0] as { timeout?: unknown };
    expect(typeof opts.timeout).toBe("number");
    expect(opts.timeout as number).toBeGreaterThan(0);
  });
});

describe("dispatcher timers exceed every derivable request timeout", () => {
  it("holds across the whole input domain, not just at hand-picked constants", () => {
    // Swept rather than compared literal-to-literal so the relationship survives a change to
    // either constant. This ordering is what makes the SDK's abort the single authority.
    const budgets = [0, 1, 4_096, 16_384, 32_000, 64_000, 128_000, 200_000, 1_000_000];
    const maxDerived = Math.max(...budgets.map(deriveRequestTimeoutMs));
    expect(TRANSPORT_TIMEOUT_MS).toBeGreaterThan(maxDerived);
  });
});

describe("per-request timeout reaches the SDK", () => {
  it("derives the per-request timeout from its own budget on the chat-completions path", async () => {
    mockCreate.mockResolvedValue(okCompletion());
    const adapter = new OpenAIAdapter("sk-test");
    await adapter.createChatCompletion({
      model: "gpt-4o-2024-08-06",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 32_000,
    });
    expect(optsOf(mockCreate).timeout).toBe(deriveRequestTimeoutMs(32_000));
  });

  it("a larger budget produces a larger timeout on the same path", async () => {
    mockCreate.mockResolvedValue(okCompletion());
    const adapter = new OpenAIAdapter("sk-test");
    const base = { model: "gpt-4o-2024-08-06", messages: [{ role: "user" as const, content: "hi" }] };
    await adapter.createChatCompletion({ ...base, max_tokens: 16_384 });
    await adapter.createChatCompletion({ ...base, max_tokens: 64_000 });
    const first = optsOf(mockCreate, 0).timeout!;
    const second = optsOf(mockCreate, 1).timeout!;
    expect(second).toBeGreaterThan(first);
  });

  it("the gpt-5.x responses path derives too, from the budget it actually puts on the wire", async () => {
    mockResponsesCreate.mockResolvedValue(okResponsesPayload());
    const adapter = new OpenAIAdapter("sk-test");
    await adapter.createChatCompletion({
      model: "gpt-5.5-2026-04-23",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 32_000,
    });
    // responsesConvertParams renames the budget to max_output_tokens; the timeout must follow the
    // renamed field, not the original spelling.
    const [body, opts] = mockResponsesCreate.mock.calls[0] as [
      { max_output_tokens?: number },
      { timeout?: number },
    ];
    expect(body.max_output_tokens).toBe(32_000);
    expect(opts.timeout).toBe(deriveRequestTimeoutMs(32_000));
  });
});
