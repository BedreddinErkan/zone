/**
 * U.1 Commit 1: per-call [zone-cache-usage] and per-run [zone-cache-summary]
 * JSONL emission from agentLoop when Anthropic cache tokens are present.
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
    provider: "anthropic",
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

function makeToolCallResponse(id: string, toolName: string, args: Record<string, unknown>, usage?: Record<string, number>) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: usage?.prompt_tokens ?? 100,
      completion_tokens: usage?.completion_tokens ?? 10,
      total_tokens: (usage?.prompt_tokens ?? 100) + (usage?.completion_tokens ?? 10),
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    },
  };
}

function makeDoneResponse(text: string, usage?: Record<string, number>) {
  return {
    choices: [
      {
        message: { content: text, tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage?.prompt_tokens ?? 50,
      completion_tokens: usage?.completion_tokens ?? 20,
      total_tokens: (usage?.prompt_tokens ?? 50) + (usage?.completion_tokens ?? 20),
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-cache-usage-"));
  mocks.createChatCompletion.mockReset();
  mocks.executeTool.mockReset();
  mocks.withStagingTempFlush.mockReset();
  mocks.log.mockReset();
  mocks.withStagingTempFlush.mockImplementation(async (fn: () => Promise<void>) => fn());
  mocks.executeTool.mockResolvedValue({ success: true, output: "file content" });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("U.1 — [zone-cache-usage] per-call emission", () => {
  it("emits [zone-cache-usage] when cache tokens are non-zero", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return makeToolCallResponse(
          "tc-1",
          "read_file",
          { filePath: "src/foo.ts", lineRange: null },
          { prompt_tokens: 500, completion_tokens: 20, cache_creation_input_tokens: 480, cache_read_input_tokens: 0 }
        );
      }
      return makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra]", {
        prompt_tokens: 520,
        completion_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 490,
      });
    });

    await runAgentLoop({
      task: "check a file",
      repoPath,
      runId: "test-cache-run-1",
      maxIterationsOverride: 5,
    });

    const usageCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-cache-usage]"
    );
    expect(usageCalls.length).toBeGreaterThanOrEqual(1);

    const firstPayload = JSON.parse(usageCalls[0][1] as string);
    expect(firstPayload.event).toBe("cache_call_usage");
    expect(firstPayload.runId).toBe("test-cache-run-1");
    expect(typeof firstPayload.iter).toBe("number");
    expect(typeof firstPayload.write).toBe("number");
    expect(typeof firstPayload.read).toBe("number");
    expect(typeof firstPayload.cacheHitRatio).toBe("number");
  });

  it("does NOT emit [zone-cache-usage] when cache tokens are both zero", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra]", {
        prompt_tokens: 100,
        completion_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      })
    );

    await runAgentLoop({
      task: "simple task",
      repoPath,
      runId: "test-cache-run-0",
      maxIterationsOverride: 3,
    });

    const usageCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-cache-usage]"
    );
    expect(usageCalls.length).toBe(0);
  });
});

describe("U.1 — [zone-cache-summary] per-run emission", () => {
  it("emits [zone-cache-summary] at natural_completion when cache tokens exist", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return makeToolCallResponse(
          "tc-1",
          "read_file",
          { filePath: "a.ts", lineRange: null },
          { prompt_tokens: 200, completion_tokens: 10, cache_creation_input_tokens: 180, cache_read_input_tokens: 0 }
        );
      }
      return makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra]", {
        prompt_tokens: 220,
        completion_tokens: 15,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 170,
      });
    });

    await runAgentLoop({
      task: "read file",
      repoPath,
      runId: "test-summary-run",
      maxIterationsOverride: 5,
    });

    const summaryCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-cache-summary]"
    );
    expect(summaryCalls.length).toBeGreaterThanOrEqual(1);

    const payload = JSON.parse(summaryCalls[0][1] as string);
    expect(payload.event).toBe("cache_run_summary");
    expect(payload.runId).toBe("test-summary-run");
    expect(typeof payload.totalIters).toBe("number");
    expect(typeof payload.totalWrite).toBe("number");
    expect(typeof payload.totalRead).toBe("number");
    expect(typeof payload.cacheHitRatio).toBe("number");
    expect(typeof payload.totalCostUsd).toBe("number");
    expect(payload.cacheHitRatio).toBeGreaterThan(0);
  });

  it("does NOT emit [zone-cache-summary] when there are no cache tokens across the run", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      makeDoneResponse("[ZONE_VERIFICATION: tests_skipped_no_infra]", {
        prompt_tokens: 100,
        completion_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      })
    );

    await runAgentLoop({
      task: "no-cache task",
      repoPath,
      runId: "test-no-cache-run",
      maxIterationsOverride: 3,
    });

    const summaryCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-cache-summary]"
    );
    expect(summaryCalls.length).toBe(0);
  });

  it("emits [zone-cache-summary] at max_iterations termination", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      return makeToolCallResponse(
        `tc-${callCount}`,
        "read_file",
        { filePath: `src/f${callCount}.ts`, lineRange: null },
        { prompt_tokens: 300, completion_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 280 }
      );
    });

    await runAgentLoop({
      task: "loop task",
      repoPath,
      runId: "test-maxiter-cache",
      maxIterationsOverride: 3,
    });

    const summaryCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-cache-summary]"
    );
    expect(summaryCalls.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(summaryCalls[0][1] as string);
    expect(payload.event).toBe("cache_run_summary");
    expect(payload.totalRead).toBeGreaterThan(0);
  });
});
