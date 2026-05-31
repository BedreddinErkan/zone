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

describe("Gemini gate (ZONE_GEMINI_ENABLE)", () => {
  beforeEach(() => {
    vi.resetModules();
    openaiCtorMock.mockClear();
    anthropicCtorMock.mockClear();
    process.env.GEMINI_API_KEY = "gk-test-gemini-key";
  });

  afterEach(() => {
    delete process.env.ZONE_GEMINI_ENABLE;
    delete process.env.GEMINI_API_KEY;
  });

  it("gate ON: constructs OpenAIAdapter with Gemini base_url and 'gemini' provider", async () => {
    process.env.ZONE_GEMINI_ENABLE = "1";
    const { createLLMClient } = await import("./factory.js");
    createLLMClient({ provider: "gemini" });
    expect(openaiCtorMock).toHaveBeenCalledWith("gk-test-gemini-key", GEMINI_BASE_URL, "gemini");
    expect(anthropicCtorMock).not.toHaveBeenCalled();
  });

  it("gate OFF: throws on provider=gemini", async () => {
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "gemini" })).toThrow("Unsupported provider: gemini");
    expect(openaiCtorMock).not.toHaveBeenCalled();
  });

  it("gate ON without GEMINI_API_KEY: throws missing key error", async () => {
    process.env.ZONE_GEMINI_ENABLE = "1";
    delete process.env.GEMINI_API_KEY;
    const { createLLMClient } = await import("./factory.js");
    expect(() => createLLMClient({ provider: "gemini" })).toThrow("GEMINI_API_KEY is missing");
  });
});
