import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadDiskKeys = vi.hoisted(() => vi.fn());
const mockCreateLLMClient = vi.hoisted(() => vi.fn());

vi.mock("../api/diskKeys.js", () => ({ loadDiskKeys: mockLoadDiskKeys }));
vi.mock("../llm/factory.js", () => ({ createLLMClient: mockCreateLLMClient }));

import { embedText, _resetEmbedStateForTest } from "./embedFile.js";

const EMPTY_DISK = { version: 1 as const, keys: [] };

function mockOpenAIClient() {
  return {
    provider: "openai",
    createEmbedding: vi.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }] }),
  };
}

describe("embedFile — BYOK key resolution", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    _resetEmbedStateForTest();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("no key anywhere → null + exactly one [zone-embed-skipped]{reason:no_openai_key}, dedup holds across calls", async () => {
    mockLoadDiskKeys.mockResolvedValue(EMPTY_DISK);

    const r1 = await embedText("hello");
    const r2 = await embedText("world");

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("[zone-embed-skipped]", {
      reason: "no_openai_key",
      detail: expect.any(String),
    });
    expect(mockCreateLLMClient).not.toHaveBeenCalled();
  });

  it("OpenAI key in diskKeys → createLLMClient called with { provider:'openai', apiKey:'sk-disk' }, not the ambient provider", async () => {
    mockLoadDiskKeys.mockResolvedValue({
      version: 1 as const,
      keys: [{ provider: "openai" as const, key: "sk-disk", addedAt: "2026-01-01T00:00:00.000Z" }],
    });
    mockCreateLLMClient.mockReturnValue(mockOpenAIClient());

    await embedText("hello");

    expect(mockCreateLLMClient).toHaveBeenCalledWith({ provider: "openai", apiKey: "sk-disk" });
    expect(mockCreateLLMClient).not.toHaveBeenCalledWith(expect.not.objectContaining({ provider: "openai" }));
  });

  it("OPENAI_API_KEY env set + empty diskKeys → falls back to env key", async () => {
    process.env.OPENAI_API_KEY = "sk-env";
    mockLoadDiskKeys.mockResolvedValue(EMPTY_DISK);
    mockCreateLLMClient.mockReturnValue(mockOpenAIClient());

    await embedText("hello");

    expect(mockCreateLLMClient).toHaveBeenCalledWith({ provider: "openai", apiKey: "sk-env" });
  });
});
