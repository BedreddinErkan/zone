import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadCliConfig = vi.hoisted(() => vi.fn());
const mockApplyDiskKeyFallbacks = vi.hoisted(() => vi.fn());
const mockRunInvestigationFlow = vi.hoisted(() => vi.fn());

vi.mock("../../cli/config.js", () => ({
  loadCliConfig: mockLoadCliConfig,
  applyDiskKeyFallbacks: mockApplyDiskKeyFallbacks,
}));
vi.mock("../../llm/investigationFlow.js", () => ({ runInvestigationFlow: mockRunInvestigationFlow }));

import { runInitFlow } from "../initFlow.js";

const FAKE_RESULT = {
  ok: true,
  decisionMode: "investigation" as const,
  chatResponse: "## Project\nTest project.\n\n## Stack\nTypeScript.\n\n## Layout\nsrc/ — source.\n\n## Commands\nnpm test.\n\n## Conventions\nVitest.\n\n## Entry points\nsrc/index.ts.",
  responseHtml: "",
  contextFiles: [],
  applyPatches: [] as [],
  fileDiffs: [] as [],
  toolCallLog: [],
  costUsd: 42,
};

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-init-test-"));
  mockRunInvestigationFlow.mockResolvedValue(FAKE_RESULT);
  mockApplyDiskKeyFallbacks.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe("runInitFlow — provider threading", () => {
  it("disk provider=openai → runInvestigationFlow called with provider:'openai'", async () => {
    mockLoadCliConfig.mockReturnValue({
      provider: "openai",
      model: "gpt-5.5",
      openaiApiKey: "sk-openai-test",
      anthropicApiKey: undefined,
    });

    await runInitFlow(tempDir);

    expect(mockRunInvestigationFlow).toHaveBeenCalledOnce();
    const call = mockRunInvestigationFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["provider"]).toBe("openai");
    expect(call["userApiKey"]).toBe("sk-openai-test");
  });

  it("disk provider=anthropic → runInvestigationFlow called with provider:'anthropic'", async () => {
    mockLoadCliConfig.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      openaiApiKey: undefined,
      anthropicApiKey: "sk-ant-test",
    });

    await runInitFlow(tempDir);

    expect(mockRunInvestigationFlow).toHaveBeenCalledOnce();
    const call = mockRunInvestigationFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["provider"]).toBe("anthropic");
    expect(call["userApiKey"]).toBe("sk-ant-test");
  });

  it("no disk config (loadCliConfig defaults) → provider passed through, no hardcoded anthropic fallback in initFlow", async () => {
    mockLoadCliConfig.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      openaiApiKey: undefined,
      anthropicApiKey: "sk-ant-default",
    });

    const result = await runInitFlow(tempDir);

    expect(result.ok).toBe(true);
    const call = mockRunInvestigationFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["provider"]).toBe("anthropic");
  });

  it("loadCliConfig called with repo=cwd", async () => {
    mockLoadCliConfig.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      openaiApiKey: undefined,
      anthropicApiKey: "sk-ant-test",
    });

    await runInitFlow(tempDir);

    expect(mockLoadCliConfig).toHaveBeenCalledWith({ repo: tempDir });
  });

  it("threads costUsd from runInvestigationFlow result through to the return value", async () => {
    mockLoadCliConfig.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      openaiApiKey: undefined,
      anthropicApiKey: "sk-ant-test",
    });

    const result = await runInitFlow(tempDir);

    expect(result.costUsd).toBe(42); // matches FAKE_RESULT.costUsd
  });

  it("R2: passes suppressOutputFormat:true to runInvestigationFlow", async () => {
    mockLoadCliConfig.mockReturnValue({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      openaiApiKey: undefined,
      anthropicApiKey: "sk-ant-test",
    });

    await runInitFlow(tempDir);

    const call = mockRunInvestigationFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["suppressOutputFormat"]).toBe(true);
  });

  it("BYOK: applyDiskKeyFallbacks fills missing key → runInvestigationFlow receives correct key and model", async () => {
    const configObj: Record<string, unknown> = {
      provider: "openai",
      model: "gpt-5.5",
      openaiApiKey: undefined,
      anthropicApiKey: undefined,
    };
    mockLoadCliConfig.mockReturnValue(configObj);
    mockApplyDiskKeyFallbacks.mockImplementation(async (cfg: Record<string, unknown>) => {
      cfg["openaiApiKey"] = "sk-byok-test";
    });

    await runInitFlow(tempDir);

    expect(mockApplyDiskKeyFallbacks).toHaveBeenCalledOnce();
    expect(mockRunInvestigationFlow).toHaveBeenCalledOnce();
    const call = mockRunInvestigationFlow.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["provider"]).toBe("openai");
    expect(call["userApiKey"]).toBe("sk-byok-test");
  });
});

describe("runInitFlow — memory.md already exists guard", () => {
  it("returns error when .zone/memory.md already exists and is non-empty", async () => {
    fs.mkdirSync(path.join(tempDir, ".zone"));
    fs.writeFileSync(path.join(tempDir, ".zone", "memory.md"), "existing content");

    const result = await runInitFlow(tempDir);

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already exists/);
    expect(mockRunInvestigationFlow).not.toHaveBeenCalled();
  });
});
