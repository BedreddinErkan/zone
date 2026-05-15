import { describe, expect, it, vi, beforeEach } from "vitest";
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
