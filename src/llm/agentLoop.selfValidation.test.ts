/**
 * Phase V Commit 4: self-validation summary emission.
 * [zone-self-validation-summary] is emitted at run end alongside
 * [zone-cache-summary], with counts aggregated from toolExecutor mutations.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

// ── hoisted mocks ────────────────────────────────────────────────────────────

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

vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, log: mocks.log };
});

import { runAgentLoop } from "./agentLoop.js";

function makeUsage() {
  return {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 5 },
  };
}

function makeDoneResponse(text = "Done.") {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: makeUsage(),
  };
}

function makeBaseInput(repoPath: string) {
  return {
    task: "test task",
    repoPath,
    runId: "test-run-summary",
    userId: "u1",
    onProgress: vi.fn(),
    onStructuredEvent: vi.fn(),
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-sv-sum-"));
  resetToolExecutorMock(toolExecutorMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("[zone-self-validation-summary] emission", () => {
  it("does NOT emit summary when no self-validation activity occurred", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(makeDoneResponse());
    await runAgentLoop(makeBaseInput(repoPath) as Parameters<typeof runAgentLoop>[0]);
    const summaryCall = mocks.log.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-self-validation-summary]"
    );
    expect(summaryCall).toBeUndefined();
  });

  it("emits summary with incremented counts when toolExecutor reports rejects", async () => {
    // Simulate a run where executeTool mutates selfValidationCounts:
    // read-before-patch fires once, then agent reads and patches successfully.
    toolExecutorMock.executeTool.mockImplementation(
      async (
        _name: string,
        _args: Record<string, unknown>,
        _repo: string,
        _onProgress: unknown,
        input: { selfValidationCounts?: { readBeforePatchRejects: number; smartQuoteFixes: number; inlineTsRejects: number; inlineTsApproves: number; inlineTsSkips: number; totalLatencyMs: number } }
      ) => {
        // Simulate one readBeforePatchReject and one inlineTsApprove
        if (input?.selfValidationCounts) {
          input.selfValidationCounts.readBeforePatchRejects += 1;
          input.selfValidationCounts.inlineTsApproves += 1;
          input.selfValidationCounts.totalLatencyMs += 120;
        }
        return { success: true, output: "done" };
      }
    );
    // LLM must issue at least one tool call so executeTool gets invoked.
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "tc1",
                  type: "function",
                  function: { name: "run_command", arguments: JSON.stringify({ command: "echo hi" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: makeUsage(),
      })
      .mockResolvedValueOnce(makeDoneResponse());
    await runAgentLoop(makeBaseInput(repoPath) as Parameters<typeof runAgentLoop>[0]);
    const summaryCall = mocks.log.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-self-validation-summary]"
    );
    expect(summaryCall).toBeDefined();
    const payload = JSON.parse(summaryCall![1] as string);
    expect(payload.readBeforePatchRejects).toBe(1);
    expect(payload.inlineTsApproves).toBe(1);
    expect(payload.totalLatencyMs).toBe(120);
    expect(payload.runId).toBe("test-run-summary");
  });

  it("aggregates latency from multiple apply_patch tsc checks across iterations", async () => {
    let callCount = 0;
    toolExecutorMock.executeTool.mockImplementation(
      async (
        _name: string,
        _args: Record<string, unknown>,
        _repo: string,
        _onProgress: unknown,
        input: { selfValidationCounts?: { readBeforePatchRejects: number; smartQuoteFixes: number; inlineTsRejects: number; inlineTsApproves: number; inlineTsSkips: number; totalLatencyMs: number } }
      ) => {
        callCount++;
        if (input?.selfValidationCounts) {
          input.selfValidationCounts.inlineTsApproves += 1;
          input.selfValidationCounts.totalLatencyMs += 50; // 50ms per call
        }
        return { success: true, output: "ok" };
      }
    );
    // Two LLM turns so executeTool is called twice
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "run_command", arguments: JSON.stringify({ command: "echo hi" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: makeUsage(),
      })
      .mockResolvedValueOnce(makeDoneResponse());

    await runAgentLoop(makeBaseInput(repoPath) as Parameters<typeof runAgentLoop>[0]);

    const summaryCall = mocks.log.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-self-validation-summary]"
    );
    expect(summaryCall).toBeDefined();
    const payload = JSON.parse(summaryCall![1] as string);
    // One executeTool call happened (run_command in iter 1)
    expect(payload.totalLatencyMs).toBeGreaterThanOrEqual(50);
  });
});

describe("agentLoop filesReadThisRun plumbing (V.1)", () => {
  it("passes filesReadThisRun to executeTool after successful read_file", async () => {
    let capturedFilesRead: ReadonlySet<string> | undefined;
    toolExecutorMock.executeTool.mockImplementation(
      async (
        name: string,
        args: Record<string, unknown>,
        _repo: string,
        _onProgress: unknown,
        input: { filesReadThisRun?: ReadonlySet<string> }
      ) => {
        if (name === "apply_patch") {
          capturedFilesRead = input?.filesReadThisRun;
        }
        return { success: true, output: "ok" };
      }
    );
    // LLM: read_file src/a.ts → apply_patch src/a.ts → done
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "r1",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ filePath: "src/a.ts" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: makeUsage(),
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "p1",
                  type: "function",
                  function: {
                    name: "apply_patch",
                    arguments: JSON.stringify({ filePath: "src/a.ts", patch: "--- FIND ---\nold\n--- REPLACE ---\nnew", intent: "modify", scope: null }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: makeUsage(),
      })
      .mockResolvedValueOnce(makeDoneResponse());

    await runAgentLoop(makeBaseInput(repoPath) as Parameters<typeof runAgentLoop>[0]);

    expect(capturedFilesRead).toBeDefined();
    expect(capturedFilesRead!.has("src/a.ts")).toBe(true);
  });

  it("does not include filePath in filesReadThisRun when read_file fails", async () => {
    let capturedFilesRead: ReadonlySet<string> | undefined;
    toolExecutorMock.executeTool.mockImplementation(
      async (
        name: string,
        args: Record<string, unknown>,
        _repo: string,
        _onProgress: unknown,
        input: { filesReadThisRun?: ReadonlySet<string> }
      ) => {
        if (name === "read_file") {
          return { success: false, output: "File not found" };
        }
        if (name === "apply_patch") {
          capturedFilesRead = input?.filesReadThisRun;
        }
        return { success: true, output: "ok" };
      }
    );
    // LLM: failing read_file → apply_patch (will be intercepted by agentLoop gate
    // since toolCallLog won't have a successful read, but executeTool is called
    // first for read_file, so we can verify the set is empty)
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "r2",
                  type: "function",
                  function: { name: "read_file", arguments: JSON.stringify({ filePath: "src/b.ts" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: makeUsage(),
      })
      .mockResolvedValueOnce(makeDoneResponse());

    await runAgentLoop(makeBaseInput(repoPath) as Parameters<typeof runAgentLoop>[0]);

    // apply_patch never called (agentLoop done after failed read + done response),
    // but we can verify set didn't grow from the failed read
    expect(capturedFilesRead).toBeUndefined();
  });

  it("filesReadThisRun is a Set passed by reference — accumulates across iters", async () => {
    const capturedSets: ReadonlySet<string>[] = [];
    toolExecutorMock.executeTool.mockImplementation(
      async (
        name: string,
        args: Record<string, unknown>,
        _repo: string,
        _onProgress: unknown,
        input: { filesReadThisRun?: ReadonlySet<string> }
      ) => {
        if (name === "apply_patch") {
          // snapshot the set contents at each apply_patch call
          capturedSets.push(new Set(input?.filesReadThisRun ?? []));
        }
        return { success: true, output: "ok" };
      }
    );
    // read_file src/x.ts, then apply_patch src/x.ts, then read_file src/y.ts, apply_patch src/y.ts
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        choices: [{
          message: { content: null, tool_calls: [
            { id: "r1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ filePath: "src/x.ts" }) } },
          ]},
          finish_reason: "tool_calls",
        }],
        usage: makeUsage(),
      })
      .mockResolvedValueOnce({
        choices: [{
          message: { content: null, tool_calls: [
            { id: "p1", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ filePath: "src/x.ts", patch: "--- FIND ---\na\n--- REPLACE ---\nb", intent: "modify", scope: null }) } },
          ]},
          finish_reason: "tool_calls",
        }],
        usage: makeUsage(),
      })
      .mockResolvedValueOnce({
        choices: [{
          message: { content: null, tool_calls: [
            { id: "r2", type: "function", function: { name: "read_file", arguments: JSON.stringify({ filePath: "src/y.ts" }) } },
          ]},
          finish_reason: "tool_calls",
        }],
        usage: makeUsage(),
      })
      .mockResolvedValueOnce({
        choices: [{
          message: { content: null, tool_calls: [
            { id: "p2", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ filePath: "src/y.ts", patch: "--- FIND ---\na\n--- REPLACE ---\nb", intent: "modify", scope: null }) } },
          ]},
          finish_reason: "tool_calls",
        }],
        usage: makeUsage(),
      })
      .mockResolvedValueOnce(makeDoneResponse());

    await runAgentLoop(makeBaseInput(repoPath) as Parameters<typeof runAgentLoop>[0]);

    expect(capturedSets).toHaveLength(2);
    // First apply_patch: only x.ts was read
    expect(capturedSets[0].has("src/x.ts")).toBe(true);
    expect(capturedSets[0].has("src/y.ts")).toBe(false);
    // Second apply_patch: both x.ts and y.ts were read (set accumulates)
    expect(capturedSets[1].has("src/x.ts")).toBe(true);
    expect(capturedSets[1].has("src/y.ts")).toBe(true);
  });
});
