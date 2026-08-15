/**
 * Item 166 stage one. Mutation-testing gap found and closed: toolAbsenceNotice.test.ts
 * only calls buildToolAbsenceBlock directly with explicit allowToolRequest values — it
 * never exercises agentLoop.ts's actual wiring decision (`allowToolRequest:
 * isInvestigationMode`). A mutation that hardcodes that call to `true` unconditionally
 * survived every existing test file (agentLoop.prompts.test.ts, .tierToolSubset.test.ts,
 * .writeCapabilityAbsent.test.ts) — none of them capture the real system prompt text
 * from a live runAgentLoop call. This file closes that gap: real runAgentLoop, mocked
 * LLM client, captures the actual system message content per mode.
 */

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

import { runAgentLoop } from "./agentLoop.js";

function makeDoneResponse() {
  return {
    choices: [
      { message: { content: "[ZONE_VERIFICATION: no_verification_attempted]", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-notice-wiring-"));
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

function captureSystemContent(): { get: () => string | undefined } {
  let captured: string | undefined;
  mocks.createChatCompletion.mockImplementation(
    async (params: { messages?: Array<{ role: string; content: unknown }> }) => {
      const sys = params.messages?.find((m) => m.role === "system");
      captured = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content);
      return makeDoneResponse();
    }
  );
  return { get: () => captured };
}

const REDIRECTION = "name it in requestedTools in your plan JSON";

describe("item 166 stage one — allowToolRequest wiring at the real runAgentLoop call site", () => {
  it("execution mode (default): the assembled system prompt's notice has NO redirection", async () => {
    const capture = captureSystemContent();

    await runAgentLoop({
      task: "add a comment",
      repoPath,
      capabilityFilter: { allowToolNames: new Set(["read_file"]) },
    });

    const content = capture.get();
    expect(content).toBeDefined();
    expect(content).toContain("TOOLS NOT AVAILABLE THIS RUN");
    expect(content).not.toContain(REDIRECTION);
  });

  it("investigation mode: the assembled system prompt's notice DOES contain the redirection", async () => {
    const capture = captureSystemContent();

    await runAgentLoop({
      task: "investigate how X works",
      repoPath,
      mode: "investigate",
      capabilityFilter: { allowToolNames: new Set(["read_file"]) },
    });

    const content = capture.get();
    expect(content).toBeDefined();
    expect(content).toContain("TOOLS NOT AVAILABLE THIS RUN");
    expect(content).toContain(REDIRECTION);
  });
});
