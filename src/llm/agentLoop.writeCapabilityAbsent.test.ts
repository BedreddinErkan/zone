import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

/**
 * Execution can start with a patch task and mode:"patch" while holding a
 * capability filter that grants no write-capable tool — the archetype
 * dispatcher can re-classify an approved-plan execution as "investigation"
 * and apply its read-only pipeline. Silent except when tier separately trips
 * the unrelated [zone-tier-grant-unusable] subagent-quota gate (only at
 * complex tier). This marker names the condition directly, at every tier.
 */

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
import { INVESTIGATION_PIPELINE, buildDispatcherCapabilityFilter } from "./archetypeDispatcher.js";

function doneResponse() {
  return {
    choices: [{ message: { content: "Done.", tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function events(): Array<Record<string, unknown>> {
  return mocks.log.mock.calls
    .filter((c: unknown[]) => c[0] === "[zone-write-capability-absent]")
    .map((c: unknown[]) => JSON.parse(c[1] as string) as Record<string, unknown>);
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-write-cap-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
  mocks.createChatCompletion.mockResolvedValue(doneResponse());
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("[zone-write-capability-absent]", () => {
  it("fires when a read-only capability filter leaves no write-capable tool, naming the arm that produced it", async () => {
    await runAgentLoop({
      task: "trace how a tool result reaches the message history",
      repoPath,
      runId: "test-write-cap-1",
      capabilityFilter: buildDispatcherCapabilityFilter(INVESTIGATION_PIPELINE),
    });

    const [evt] = events();
    expect(evt).toBeDefined();
    expect(evt.filterSource).toBe("capabilityFilter");
    expect(evt.toolSubsetSize).toBe(5);
    expect(evt.mode).toBe("patch");
    expect(evt.hasApprovedPlan).toBe(false);
  });

  it("stays silent on a normal patch run with the default, write-capable toolset", async () => {
    await runAgentLoop({
      task: "add a helper function",
      repoPath,
      runId: "test-write-cap-2",
    });

    expect(events()).toHaveLength(0);
  });
});
