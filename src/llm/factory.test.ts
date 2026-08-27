import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withRequestContext } from "./openaiContext.js";

const openaiCtorMock = vi.fn();
const anthropicCtorMock = vi.fn();
const recordingCtorMock = vi.fn();

vi.mock("./openaiAdapter.js", () => ({
  OpenAIAdapter: class {
    constructor(...args: unknown[]) { openaiCtorMock(...args); }
    chat() { return Promise.resolve({ content: "", usage: {} }); }
  },
}));

vi.mock("./anthropicAdapter.js", () => ({
  AnthropicAdapter: class {
    constructor(...args: unknown[]) { anthropicCtorMock(...args); }
    chat() { return Promise.resolve({ content: "", usage: {} }); }
  },
}));

vi.mock("./recordingClient.js", () => ({
  RecordingLLMClient: class {
    constructor(inner: unknown, profile?: unknown) {
      recordingCtorMock(inner, profile);
      return inner;
    }
  },
}));


describe("resolveProvider — 3-level precedence", () => {
  beforeEach(() => {
    vi.resetModules();
    openaiCtorMock.mockClear();
    anthropicCtorMock.mockClear();
    recordingCtorMock.mockClear();
    process.env.OPENAI_API_KEY = "sk-openai-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  it("explicit wins: options.provider=openai beats ctx.provider=anthropic", async () => {
    const { createLLMClient } = await import("./factory.js");
    await withRequestContext({ provider: "anthropic" }, async () => {
      createLLMClient({ provider: "openai" });
    });
    expect(openaiCtorMock).toHaveBeenCalledOnce();
    expect(anthropicCtorMock).not.toHaveBeenCalled();
  });

  it("context wins: ctx.provider=anthropic used when no explicit override", async () => {
    const { createLLMClient } = await import("./factory.js");
    await withRequestContext({ provider: "anthropic" }, async () => {
      createLLMClient();
    });
    expect(anthropicCtorMock).toHaveBeenCalledOnce();
    expect(openaiCtorMock).not.toHaveBeenCalled();
  });

  it("fallback default: no explicit + no ctx → anthropic", async () => {
    const { createLLMClient } = await import("./factory.js");
    createLLMClient();
    expect(anthropicCtorMock).toHaveBeenCalledOnce();
    expect(openaiCtorMock).not.toHaveBeenCalled();
  });
});

describe("API key charset validation", () => {
  beforeEach(() => {
    vi.resetModules();
    openaiCtorMock.mockClear();
    anthropicCtorMock.mockClear();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("openai: throws on em-dash in key", async () => {
    process.env.OPENAI_API_KEY = "sk-real-looks-ok—but-has-em-dash";
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "openai" })).toThrow(/non-ASCII character at byte/);
  });

  it("openai: throws on placeholder key (<…>)", async () => {
    process.env.OPENAI_API_KEY = "<your openai key here>";
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "openai" })).toThrow(/placeholder/);
  });

  it("openai: valid ASCII key passes", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "openai" })).not.toThrow();
  });

  it("anthropic: throws on em-dash in key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-—invalid";
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "anthropic" })).toThrow(/non-ASCII character at byte/);
  });

  it("anthropic: throws on placeholder key (<…>)", async () => {
    process.env.ANTHROPIC_API_KEY = "<sk-ant-placeholder>";
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "anthropic" })).toThrow(/placeholder/);
  });

  it("anthropic: valid ASCII key passes", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "anthropic" })).not.toThrow();
  });

});

/**
 * Two tripwires this refactor newly makes load-bearing (item 387).
 *
 * Neither was covered before: `toHaveBeenCalledWith` appeared zero times in this file, so nothing
 * pinned what actually reaches the adapter, and the RecordingLLMClient mock discarded its argument
 * entirely, so deleting the wrap in factory.ts kept every test green while all usage and cost
 * recording died. Under the profile refactor the wrapper is also where the pricing table arrives,
 * which makes both gaps sharper than they were.
 */
describe("what actually reaches the adapter and the recorder (item 387)", () => {
  beforeEach(() => {
    vi.resetModules();
    openaiCtorMock.mockClear();
    anthropicCtorMock.mockClear();
    recordingCtorMock.mockClear();
    process.env.OPENAI_API_KEY = "sk-openai-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  });

  it("the openai profile constructs the adapter with (key, baseUrl, protocol selector)", async () => {
    const { createLLMClient } = await import("./factory.js");
    createLLMClient({ provider: "openai" });
    // The third argument is the protocol selector — passing the wrong one here silently flips the
    // Responses branch off for gpt-5 models, which no other test would notice.
    expect(openaiCtorMock).toHaveBeenCalledWith("sk-openai-test", undefined, "openai");
  });

  it("the anthropic profile constructs its adapter with the key alone", async () => {
    const { createLLMClient } = await import("./factory.js");
    createLLMClient({ provider: "anthropic" });
    expect(anthropicCtorMock).toHaveBeenCalledWith("sk-ant-test");
  });

  it("every client is wrapped in RecordingLLMClient, and the wrapper receives the run's profile", async () => {
    const { createLLMClient } = await import("./factory.js");
    createLLMClient({ provider: "openai" });
    expect(recordingCtorMock).toHaveBeenCalledOnce();
    const [, profile] = recordingCtorMock.mock.calls[0] as [unknown, { id?: string; pricing?: unknown }];
    expect(profile?.id).toBe("openai");
    // The pricing table now arrives through this wrapper — an unwrapped client records nothing.
    expect(profile?.pricing).toEqual({ table: "openai" });
  });
});
