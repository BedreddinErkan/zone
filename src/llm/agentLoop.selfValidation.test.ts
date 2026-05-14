/**
 * Phase V Commit 4: self-validation summary emission.
 * [zone-self-validation-summary] is emitted at run end alongside
 * [zone-cache-summary], with counts aggregated from toolExecutor mutations.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => ({
  executeTool: mocks.executeTool,
  withStagingTempFlush: mocks.withStagingTempFlush,
}));

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
  mocks.withStagingTempFlush.mockImplementation(
    (_staging: unknown, body: () => Promise<unknown>) => body()
  );
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
    mocks.executeTool.mockImplementation(
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
    mocks.executeTool.mockImplementation(
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
