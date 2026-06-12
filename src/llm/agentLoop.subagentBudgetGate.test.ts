/**
 * Subagent budget gate tests (Phase Q.3 fix).
 *
 * T.1: Task tool absent from LLM toolset when tier=simple (maxSubagentCalls=0).
 * T.2: Task tool present in LLM toolset when tier=complex (maxSubagentCalls=4).
 * T.3: [zone-subagent-dispatched] not emitted when executeTool blocks Task (success:false).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

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

function makeDoneResponse(text: string) {
  return {
    choices: [
      { message: { content: text, tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

function makeTaskResponse(id: string) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: "Task",
                arguments: JSON.stringify({
                  description: "explore: check something",
                  repoPath: "/tmp",
                }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  };
}

// ── fixture ───────────────────────────────────────────────────────────────────

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-subagent-budget-gate-"));
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
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Subagent budget gate — toolset exclusion and log timing (Q.3)", () => {
  it("T.1: Task tool absent from LLM toolset when forceTier=simple", async () => {
    let capturedTools: Array<{ function: { name: string } }> | undefined;
    mocks.createChatCompletion.mockImplementation(
      async (params: { tools?: Array<{ function: { name: string } }> }) => {
        capturedTools = params.tools;
        return makeDoneResponse("[ZONE_VERIFICATION: no_verification_attempted]");
      }
    );

    await runAgentLoop({ task: "add a constant", repoPath, forceTier: "simple" });

    expect(capturedTools).toBeDefined();
    expect(capturedTools!.some((t) => t.function.name === "Task")).toBe(false);
  });

  it("T.2: Task tool present in LLM toolset when forceTier=complex", async () => {
    let capturedTools: Array<{ function: { name: string } }> | undefined;
    mocks.createChatCompletion.mockImplementation(
      async (params: { tools?: Array<{ function: { name: string } }> }) => {
        capturedTools = params.tools;
        return makeDoneResponse("[ZONE_VERIFICATION: no_verification_attempted]");
      }
    );

    await runAgentLoop({ task: "complex refactor", repoPath, forceTier: "complex" });

    expect(capturedTools).toBeDefined();
    expect(capturedTools!.some((t) => t.function.name === "Task")).toBe(true);
  });

  it("T.4: Task tool absent from LLM toolset when forceTier=medium", async () => {
    let capturedTools: Array<{ function: { name: string } }> | undefined;
    mocks.createChatCompletion.mockImplementation(
      async (params: { tools?: Array<{ function: { name: string } }> }) => {
        capturedTools = params.tools;
        return makeDoneResponse("[ZONE_VERIFICATION: no_verification_attempted]");
      }
    );

    await runAgentLoop({ task: "add a helper", repoPath, forceTier: "medium" });

    expect(capturedTools).toBeDefined();
    expect(capturedTools!.some((t) => t.function.name === "Task")).toBe(false);
  });

  it("T.3: [zone-subagent-dispatched] not logged when executeTool blocks Task (success:false)", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return makeTaskResponse("tc-1");
      return makeDoneResponse("[ZONE_VERIFICATION: no_verification_attempted]");
    });
    toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
      if (name === "Task")
        return { success: false, output: "Subagent call limit reached (0/0 used)" };
      return { success: true, output: "" };
    });

    // forceTier=complex so Task IS in the toolset; budget gate fires at executeTool runtime.
    await runAgentLoop({ task: "complex task", repoPath, forceTier: "complex" });

    const logCalls = mocks.log.mock.calls as Array<[string, ...unknown[]]>;
    expect(logCalls.filter((c) => c[0] === "[zone-subagent-dispatched]")).toHaveLength(0);
  });

  it("T.5: Task absent when forceTier=complex but estimatedIterations < 15", async () => {
    let capturedTools: Array<{ function: { name: string } }> | undefined;
    mocks.createChatCompletion.mockImplementation(
      async (params: { tools?: Array<{ function: { name: string } }> }) => {
        capturedTools = params.tools;
        return makeDoneResponse("[ZONE_VERIFICATION: no_verification_attempted]");
      }
    );

    await runAgentLoop({
      task: "add guard to 2 files",
      repoPath,
      forceTier: "complex",
      taskClassification: {
        tier: "complex", archetype: "complex_multi_file", archetypeConfidence: 0.8,
        estimatedIterations: 10, estimatedFiles: 2, confidence: 0.7, fallbackUsed: false,
        classifierCostUsd: 0, classifierLatencyMs: 0, classifierModel: "gpt-4o-mini",
      },
    });

    expect(capturedTools).toBeDefined();
    expect(capturedTools!.some((t) => t.function.name === "Task")).toBe(false);
  });

  it("T.6: Task present when forceTier=complex and estimatedIterations >= 15", async () => {
    let capturedTools: Array<{ function: { name: string } }> | undefined;
    mocks.createChatCompletion.mockImplementation(
      async (params: { tools?: Array<{ function: { name: string } }> }) => {
        capturedTools = params.tools;
        return makeDoneResponse("[ZONE_VERIFICATION: no_verification_attempted]");
      }
    );

    await runAgentLoop({
      task: "complex multi-file refactor",
      repoPath,
      forceTier: "complex",
      taskClassification: {
        tier: "complex", archetype: "complex_multi_file", archetypeConfidence: 0.9,
        estimatedIterations: 20, estimatedFiles: 5, confidence: 0.8, fallbackUsed: false,
        classifierCostUsd: 0, classifierLatencyMs: 0, classifierModel: "gpt-4o-mini",
      },
    });

    expect(capturedTools).toBeDefined();
    expect(capturedTools!.some((t) => t.function.name === "Task")).toBe(true);
  });
});
