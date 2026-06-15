/**
 * Guard: when session memory is present but the full post-header content
 * (auditContextBlock + restageSeedBlock + task) is blank, the kickoff user
 * message must contain a fallback summarization instruction so the model
 * doesn't report "no task included" in its final summary.
 * Regression for fdbc8a90.
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
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

import { runAgentLoop } from "./agentLoop.js";

function makeDoneResponse(text: string) {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-empty-task-guard-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.createChatCompletion.mockResolvedValue(
    makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra]")
  );
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function kickoffContent(): string {
  const firstCall = mocks.createChatCompletion.mock.calls[0];
  const msg = firstCall?.[0]?.messages?.[1]?.content;
  return typeof msg === "string" ? msg : JSON.stringify(msg);
}

describe("agentLoop — empty-task kickoff guard", () => {
  it("degenerate path: session memory present + empty task → fallback instruction injected", async () => {
    await runAgentLoop({
      task: "",
      repoPath,
      runId: "test-empty-task-1",
      maxIterationsOverride: 3,
      priorSessionSummary: "Prior turn: added the auth middleware and tests passed.",
    });

    const content = kickoffContent();
    expect(content).toContain("SESSION MEMORY");
    expect(content).toContain("No explicit task text was included for this turn");
    expect(content).toContain("provide a concise summary");
  });

  it("normal path: session memory present + non-empty task → no fallback appended", async () => {
    await runAgentLoop({
      task: "fix the login bug in src/auth.ts",
      repoPath,
      runId: "test-normal-task-1",
      maxIterationsOverride: 3,
      priorSessionSummary: "Prior turn: added the auth middleware and tests passed.",
    });

    const content = kickoffContent();
    expect(content).toContain("SESSION MEMORY");
    expect(content).not.toContain("No explicit task text was included for this turn");
  });

  it("non-degenerate: session memory + empty task + restageSeed content → no fallback (substantive content present)", async () => {
    await runAgentLoop({
      task: "",
      repoPath,
      runId: "test-restage-1",
      maxIterationsOverride: 3,
      priorSessionSummary: "Prior turn: added the auth middleware and tests passed.",
      restageSeed: new Map([["src/foo.ts", "const x = 1;\n"]]),
    });

    const content = kickoffContent();
    expect(content).not.toContain("No explicit task text was included for this turn");
  });
});
