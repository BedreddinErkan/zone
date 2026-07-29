import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

/**
 * Tier grants a subagent quota; the archetype's pipeline decides the toolset.
 * Nothing reconciles them. A complex-tier read-only run is budgeted 4 subagent
 * calls while `Task` is not in its toolset at all — the quota is unreachable.
 *
 * Harmless on its own, and deliberately not reconciled here. The point is that
 * it stops being silent: this is the third place tier and archetype disagree,
 * after the mismatch detector gating on forceTier and isReadOnlyMode being
 * structurally unreachable.
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

/** Complex tier is the only one granting subagent calls (maxSubagentCalls: 4). */
function complexClassification(over: Record<string, unknown> = {}) {
  return {
    tier: "complex" as const,
    // >= 15 iterations and > 3 files, so `taskIsSmall` does not fire and Task's
    // absence is attributable to the pipeline rather than the size heuristic.
    estimatedFiles: 12,
    estimatedIterations: 30,
    confidence: 0.9,
    classifierCostUsd: 0.002,
    classifierLatencyMs: 1800,
    archetype: "investigation" as const,
    archetypeConfidence: 0.92,
    ...over,
  };
}

function events(): Array<Record<string, unknown>> {
  return mocks.log.mock.calls
    .filter((c: unknown[]) => c[0] === "[zone-tier-grant-unusable]")
    .map((c: unknown[]) => JSON.parse(c[1] as string) as Record<string, unknown>);
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-tier-grant-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
  mocks.createChatCompletion.mockResolvedValue(doneResponse());
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("[zone-tier-grant-unusable]", () => {
  it("fires when a read-only pipeline removes the tool tier budgeted for", async () => {
    await runAgentLoop({
      task: "trace how a tool result reaches the message history",
      repoPath,
      runId: "test-grant-1",
      taskClassification: complexClassification(),
      capabilityFilter: buildDispatcherCapabilityFilter(INVESTIGATION_PIPELINE),
    });

    const [evt] = events();
    expect(evt).toBeDefined();
    expect(evt.grantedSubagentCalls).toBe(4);
    expect(evt.removedBy).toBe("capability_filter");
    expect(evt.tier).toBe("complex");
    expect(evt.archetype).toBe("investigation");
  });

  it("distinguishes a deliberate removal from a disagreement", async () => {
    // Dropping Task on a small task is a Zone decision, not a mismatch
    // (iteration-inflation.md Fix A). A marker that conflated the two would be
    // noise on every small complex-tier run.
    await runAgentLoop({
      task: "fix the off-by-one",
      repoPath,
      runId: "test-grant-2",
      taskClassification: complexClassification({
        archetype: "targeted_fix",
        estimatedFiles: 2,
        estimatedIterations: 4,
      }),
    });

    const [evt] = events();
    expect(evt).toBeDefined();
    expect(evt.removedBy).toBe("task_too_small");
  });

  it("stays silent when the granted quota is actually usable", async () => {
    await runAgentLoop({
      task: "implement the new export pipeline across the repo",
      repoPath,
      runId: "test-grant-3",
      taskClassification: complexClassification({ archetype: "complex_multi_file" }),
    });

    expect(events()).toHaveLength(0);
  });

  it("stays silent when the tier granted no quota to begin with", async () => {
    // simple/medium set maxSubagentCalls: 0, so there is no grant to be unusable
    // — the tool's absence is the tier's own decision, already consistent.
    await runAgentLoop({
      task: "walk me through the compaction gates",
      repoPath,
      runId: "test-grant-4",
      taskClassification: complexClassification({ tier: "medium" }),
      capabilityFilter: buildDispatcherCapabilityFilter(INVESTIGATION_PIPELINE),
    });

    expect(events()).toHaveLength(0);
  });
});
