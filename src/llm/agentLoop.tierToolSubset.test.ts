/**
 * Phase 5 B.2 — tier-derived tool subset integration tests.
 *
 * T.1: simple classification → 4 tools in toolsForLLM
 * T.2: medium classification → 8 tools in toolsForLLM
 * T.3: complex classification → full 17 tools (no filter)
 * T.4: subagent loop → no tier-subset filter (isSubagentLoop guard)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import type { TaskClassification } from "./taskClassifier.js";
import { SIMPLE_TIER_TOOLS, MEDIUM_TIER_TOOLS } from "../tools/tierToolSubsets.js";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

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
  pruneStaleReads: vi.fn(),
  emitContextPruned: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("./contextPruner.js", () => ({
  pruneStaleReads: mocks.pruneStaleReads,
  emitContextPruned: mocks.emitContextPruned,
}));

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

// ── import under test ─────────────────────────────────────────────────────────

import { runAgentLoop } from "./agentLoop.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDoneResponse() {
  return {
    choices: [
      { message: { content: "[ZONE_VERIFICATION: no_verification_attempted]", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

function makeClassification(tier: "simple" | "medium" | "complex"): TaskClassification {
  return {
    tier,
    confidence: 0.99,
    fallbackUsed: false,
    archetype: tier === "simple" ? "simple_add" : tier === "medium" ? "targeted_fix" : "complex_multi_file",
    archetypeConfidence: 0.99,
    estimatedFiles: tier === "simple" ? 1 : tier === "medium" ? 2 : 5,
    estimatedIterations: tier === "simple" ? 3 : tier === "medium" ? 8 : 15,
    classifierCostUsd: 0,
    classifierLatencyMs: 0,
    classifierModel: "test",
  };
}

// ── fixture ───────────────────────────────────────────────────────────────────

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-tier-tool-subset-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.pruneStaleReads.mockReset();
  mocks.emitContextPruned.mockReset();
  mocks.log.mockReset();

  mocks.pruneStaleReads.mockImplementation((msgs: unknown[]) => ({
    pruned: msgs,
    stats: { blocksReplaced: 0, charsSaved: 0, blocksKept: (msgs as unknown[]).length },
  }));
  mocks.emitContextPruned.mockImplementation(() => {});
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Tier-derived tool subset (Phase 5 B.2)", () => {
  it("T.1: simple classification → exactly 4 tools (SIMPLE_TIER_TOOLS)", async () => {
    let capturedToolNames: string[] | undefined;
    mocks.createChatCompletion.mockImplementation(
      async (params: { tools?: Array<{ function: { name: string } }> }) => {
        capturedToolNames = params.tools?.map((t) => t.function.name);
        return makeDoneResponse();
      }
    );

    await runAgentLoop({
      task: "add a comment",
      repoPath,
      taskClassification: makeClassification("simple"),
    });

    expect(capturedToolNames).toBeDefined();
    expect(capturedToolNames!.length).toBe(SIMPLE_TIER_TOOLS.size);
    for (const name of SIMPLE_TIER_TOOLS) {
      expect(capturedToolNames!).toContain(name);
    }
    // Exploration and management tools excluded
    expect(capturedToolNames!).not.toContain("search_in_files");
    expect(capturedToolNames!).not.toContain("Task");
    expect(capturedToolNames!).not.toContain("TodoWrite");
  });

  it("T.2: medium classification → exactly 8 tools (MEDIUM_TIER_TOOLS)", async () => {
    let capturedToolNames: string[] | undefined;
    mocks.createChatCompletion.mockImplementation(
      async (params: { tools?: Array<{ function: { name: string } }> }) => {
        capturedToolNames = params.tools?.map((t) => t.function.name);
        return makeDoneResponse();
      }
    );

    await runAgentLoop({
      task: "rename a function across two files",
      repoPath,
      taskClassification: makeClassification("medium"),
    });

    expect(capturedToolNames).toBeDefined();
    expect(capturedToolNames!.length).toBe(MEDIUM_TIER_TOOLS.size);
    for (const name of MEDIUM_TIER_TOOLS) {
      expect(capturedToolNames!).toContain(name);
    }
    // Heavy management tools still excluded for medium
    expect(capturedToolNames!).not.toContain("Task");
    expect(capturedToolNames!).not.toContain("suggest_scope_change");
  });

  it("T.3: complex classification → full toolset (no filter, includes Task + suggest_scope_change)", async () => {
    let capturedToolNames: string[] | undefined;
    mocks.createChatCompletion.mockImplementation(
      async (params: { tools?: Array<{ function: { name: string } }> }) => {
        capturedToolNames = params.tools?.map((t) => t.function.name);
        return makeDoneResponse();
      }
    );

    await runAgentLoop({
      task: "large multi-file refactor",
      repoPath,
      taskClassification: makeClassification("complex"),
    });

    expect(capturedToolNames).toBeDefined();
    // All 20 ZONE_TOOLS present — no filter applied for complex
    expect(capturedToolNames!.length).toBe(20);
    expect(capturedToolNames!).toContain("search_in_files");
    expect(capturedToolNames!).toContain("Task");
    expect(capturedToolNames!).toContain("suggest_scope_change");
    expect(capturedToolNames!).toContain("TodoWrite");
  });

  it("T.4: subagent loop → tier filter skipped, full toolset exposed", async () => {
    let capturedToolNames: string[] | undefined;
    mocks.createChatCompletion.mockImplementation(
      async (params: { tools?: Array<{ function: { name: string } }> }) => {
        capturedToolNames = params.tools?.map((t) => t.function.name);
        return makeDoneResponse();
      }
    );

    // Subagent with simple classification — isSubagentLoop guard must prevent filter
    await runAgentLoop({
      task: "explore: find all usages of the function",
      repoPath,
      taskClassification: makeClassification("simple"),
      subagent: { id: "sub-1", type: "explore", parentRunId: "parent-run-1" },
    });

    expect(capturedToolNames).toBeDefined();
    // Subagent gets full toolset (explore subagent needs search_in_files etc.)
    expect(capturedToolNames!).toContain("search_in_files");
    expect(capturedToolNames!).toContain("list_files");
    expect(capturedToolNames!).toContain("find_references");
    // Not restricted to 4 tools
    expect(capturedToolNames!.length).toBeGreaterThan(SIMPLE_TIER_TOOLS.size);
  });
});
