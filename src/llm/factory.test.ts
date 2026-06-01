import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withRequestContext } from "./openaiContext.js";

const openaiCtorMock = vi.fn();
const anthropicCtorMock = vi.fn();

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
    constructor(inner: unknown) { return inner; }
  },
}));

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

describe("resolveProvider — 3-level precedence", () => {
  beforeEach(() => {
    vi.resetModules();
    openaiCtorMock.mockClear();
    anthropicCtorMock.mockClear();
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
    delete process.env.GEMINI_API_KEY;
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

  it("gemini: throws on em-dash in key (the original bug)", async () => {
    process.env.GEMINI_API_KEY = "AIzaSy—placeholderğı";
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "gemini" })).toThrow(/non-ASCII character at byte/);
  });

  it("gemini: throws on placeholder key (<…>)", async () => {
    process.env.GEMINI_API_KEY = "<Gemini key here>";
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "gemini" })).toThrow(/placeholder/);
  });

  it("gemini: valid ASCII key passes", async () => {
    process.env.GEMINI_API_KEY = "gk-test-gemini-key";
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "gemini" })).not.toThrow();
  });
});

describe("Gemini client creation", () => {
  beforeEach(() => {
    vi.resetModules();
    openaiCtorMock.mockClear();
    anthropicCtorMock.mockClear();
    process.env.GEMINI_API_KEY = "gk-test-gemini-key";
  });

  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  it("constructs OpenAIAdapter with Gemini base_url and 'gemini' provider", async () => {
    const { createLLMClient } = await import("./factory.js");
    createLLMClient({ provider: "gemini" });
    expect(openaiCtorMock).toHaveBeenCalledWith("gk-test-gemini-key", GEMINI_BASE_URL, "gemini");
    expect(anthropicCtorMock).not.toHaveBeenCalled();
  });

  it("without GEMINI_API_KEY: throws missing key error", async () => {
    delete process.env.GEMINI_API_KEY;
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "gemini" })).toThrow("GEMINI_API_KEY is missing");
  });
});
