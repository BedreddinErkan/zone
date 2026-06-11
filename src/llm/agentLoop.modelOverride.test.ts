/**
 * Phase 2a: model-override fix for investigation mode.
 * Verifies that the collapsed `getModelName("high", ...)` arm:
 *   1. returns the same default as the removed `getModelForRole("investigator", ...)` arm
 *   2. honors requestCtx.modelOverride.high when present
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// --- unit: pure getModelName behavior ---

import { getModelName } from "./openaiClient.js";

describe("model-override fix — backward compat invariant", () => {
  it("getModelName('high','anthropic') matches former getModelForRole('investigator','anthropic') default", () => {
    // getModelForRole returned ANTHROPIC_DEFAULTS.investigator = "claude-sonnet-4-6"
    expect(getModelName("high", "anthropic", undefined)).toBe("claude-sonnet-4-6");
  });

  it("getModelName('high','openai') matches former getModelForRole('investigator','openai') default", () => {
    // getModelForRole returned OPENAI_DEFAULTS.investigator = "gpt-4o" (switched from gpt-5.4)
    expect(getModelName("high", "openai", undefined)).toBe("gpt-4o");
  });
});

describe("model-override fix — override is honored in investigation path", () => {
  it("anthropic: modelOverride.high overrides the default investigator model", () => {
    expect(getModelName("high", "anthropic", { high: "claude-opus-4-8" })).toBe("claude-opus-4-8");
  });

  it("openai: modelOverride.high overrides the default investigator model", () => {
    // gpt-4o-mini is a valid catalog entry that differs from the default gpt-4o
    expect(getModelName("high", "openai", { high: "gpt-4o-mini" })).toBe("gpt-4o-mini");
  });

  it("modelOverride.standard does not affect the high-tier investigator model", () => {
    // Ensure standard override doesn't bleed into high-tier selection
    expect(getModelName("high", "anthropic", { standard: "claude-haiku-4-5" })).toBe("claude-sonnet-4-6");
  });
});

// --- integration: investigation mode picks up requestCtx.modelOverride ---

const toolExecutorMock = vi.hoisted(() => ({
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  clearCommandCacheForRun: vi.fn(),
  clearCommandCacheForTest: vi.fn(),
  clearOutlineCacheForTest: vi.fn(),
  isMemoizableCommand: vi.fn(),
  computeCommandFingerprint: vi.fn(),
  truncateCommandOutput: vi.fn(),
  resolveAgentPath: vi.fn(),
  resolveRunCommandCwd: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn((opts: { provider?: string }) => ({
    provider: opts?.provider ?? "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);
vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

import { runAgentLoop } from "./agentLoop.js";
import { withRequestContext } from "./openaiContext.js";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

function makeDoneResponse() {
  return {
    choices: [{ message: { content: "Investigation complete.", tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
});

describe("investigation mode uses requestCtx.modelOverride", () => {
  it("no override: uses the high-tier default (claude-sonnet-4-6 for anthropic)", async () => {
    await withRequestContext({ provider: "anthropic" }, () =>
      runAgentLoop({
        task: "investigate the repo",
        repoPath: "/tmp",
        runId: "inv-test-1",
        mode: "investigation",
        maxIterationsOverride: 1,
      })
    );
    const firstCall = mocks.createChatCompletion.mock.calls[0]?.[0];
    expect(firstCall?.model).toBe("claude-sonnet-4-6");
  });

  it("with override: uses modelOverride.high instead of default", async () => {
    // claude-opus-4-8 is a valid catalog entry that differs from the default claude-sonnet-4-6
    await withRequestContext(
      { provider: "anthropic", modelOverride: { high: "claude-opus-4-8" } },
      () =>
        runAgentLoop({
          task: "investigate the repo",
          repoPath: "/tmp",
          runId: "inv-test-2",
          mode: "investigation",
          maxIterationsOverride: 1,
        })
    );
    const firstCall = mocks.createChatCompletion.mock.calls[0]?.[0];
    expect(firstCall?.model).toBe("claude-opus-4-8");
  });
});
