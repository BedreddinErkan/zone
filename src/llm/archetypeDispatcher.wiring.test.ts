import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

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
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

import { runAgentLoop } from "./agentLoop.js";

function makeDoneResponse() {
  return {
    choices: [
      { message: { content: "Done.", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-dispatcher-wiring-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("L5.1b-1 excludeTools wiring", () => {
  it("removes Task and suggest_scope_change from the LLM tool list when both excluded", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      excludeTools: new Set(["Task", "suggest_scope_change"]),
    });
    const toolNames = (
      mocks.createChatCompletion.mock.calls[0][0].tools as Array<{
        function: { name: string };
      }>
    ).map((t) => t.function.name);
    expect(toolNames).not.toContain("Task");
    expect(toolNames).not.toContain("suggest_scope_change");
  });

  it("preserves Task and suggest_scope_change in legacy mode (no excludeTools)", async () => {
    await runAgentLoop({ task: "add a helper function", repoPath });
    const toolNames = (
      mocks.createChatCompletion.mock.calls[0][0].tools as Array<{
        function: { name: string };
      }>
    ).map((t) => t.function.name);
    expect(toolNames).toContain("Task");
    expect(toolNames).toContain("suggest_scope_change");
  });

  it("does not block read_file or apply_patch when only Task is excluded", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      excludeTools: new Set(["Task"]),
    });
    const toolNames = (
      mocks.createChatCompletion.mock.calls[0][0].tools as Array<{
        function: { name: string };
      }>
    ).map((t) => t.function.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("apply_patch");
    expect(toolNames).not.toContain("Task");
  });
});

describe("L5.1b-1 pipelineApplied telemetry", () => {
  it("emits pipelineApplied=true in [zone-archetype] when pipelineApplied is set", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-wiring-active",
      pipelineApplied: true,
    });
    const archetypeLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype]"
    );
    expect(archetypeLogs.length).toBe(1);
    const payload = JSON.parse(archetypeLogs[0][1] as string) as Record<string, unknown>;
    expect(payload.pipelineApplied).toBe(true);
  });

  it("emits pipelineApplied=false by default (legacy path, no pipelineApplied field)", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-wiring-legacy",
    });
    const archetypeLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype]"
    );
    expect(archetypeLogs.length).toBe(1);
    const payload = JSON.parse(archetypeLogs[0][1] as string) as Record<string, unknown>;
    expect(payload.pipelineApplied).toBe(false);
  });
});

describe("L5.1b-2 promotion telemetry propagation", () => {
  it("records promotedFrom=null in [zone-archetype] when run completes within pipeline cap", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-wiring-promo-null",
      pipelineApplied: true,
      originalArchetype: "simple_add",
      maxIterationsOverride: 5,
    });
    const archetypeLogs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-archetype]"
    );
    expect(archetypeLogs.length).toBe(1);
    const payload = JSON.parse(archetypeLogs[0][1] as string) as Record<string, unknown>;
    expect(payload.promotedFrom).toBeNull();
    expect(payload.promotionTrigger).toBeNull();
    expect(payload.promotedAtIter).toBeNull();
  });
});
