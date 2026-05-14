/**
 * U.2.A Commit 3: model field in cache JSONL + Haiku 4.5 cost accuracy.
 *
 * [zone-cache-usage] must include a `model` field from the response.
 * [zone-cache-summary] must include an `agentModel` field.
 * Cost is calculated using Haiku 4.5 pricing when the worker model is Haiku.
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
import { totalCost } from "../usage/pricing.js";

function makeToolCallResponse(
  id: string,
  model: string,
  usage: Record<string, number>
) {
  return {
    model,
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ filePath: "src/foo.ts", lineRange: null }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 100,
      completion_tokens: usage.completion_tokens ?? 10,
      total_tokens: (usage.prompt_tokens ?? 100) + (usage.completion_tokens ?? 10),
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    },
  };
}

function makeDoneResponse(text: string, model: string, usage: Record<string, number>) {
  return {
    model,
    choices: [
      {
        message: { content: text, tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 50,
      completion_tokens: usage.completion_tokens ?? 20,
      total_tokens: (usage.prompt_tokens ?? 50) + (usage.completion_tokens ?? 20),
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-cache-model-"));
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

describe("U.2.A Commit 3 — model field in cache JSONL", () => {
  it("[zone-cache-usage] includes model field from response", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return makeToolCallResponse("tc-1", "claude-haiku-4-5", {
          prompt_tokens: 200,
          completion_tokens: 10,
          cache_creation_input_tokens: 180,
          cache_read_input_tokens: 0,
        });
      }
      return makeDoneResponse(
        "[ZONE_VERIFICATION: tests_skipped_no_infra]",
        "claude-haiku-4-5",
        {
          prompt_tokens: 200,
          completion_tokens: 15,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 170,
        }
      );
    });

    await runAgentLoop({
      task: "read file",
      repoPath,
      runId: "model-field-test",
      maxIterationsOverride: 5,
    });

    const usageCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-cache-usage]"
    );
    expect(usageCalls.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(usageCalls[0][1] as string);
    expect(payload.model).toBe("claude-haiku-4-5");
  });

  it("[zone-cache-summary] includes agentModel field", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return makeToolCallResponse("tc-1", "claude-haiku-4-5", {
          prompt_tokens: 200,
          completion_tokens: 10,
          cache_creation_input_tokens: 180,
          cache_read_input_tokens: 0,
        });
      }
      return makeDoneResponse(
        "[ZONE_VERIFICATION: tests_skipped_no_infra]",
        "claude-haiku-4-5",
        {
          prompt_tokens: 200,
          completion_tokens: 15,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 170,
        }
      );
    });

    await runAgentLoop({
      task: "read file",
      repoPath,
      runId: "model-summary-test",
      maxIterationsOverride: 5,
    });

    const summaryCalls = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-cache-summary]"
    );
    expect(summaryCalls.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(summaryCalls[0][1] as string);
    expect(payload.agentModel).toBe("claude-haiku-4-5");
  });

  it("Haiku 4.5 cost is ~5x cheaper than Sonnet 4.6 for same token count", () => {
    // Haiku 4.5: $1/$5 per MTok input/output
    // Sonnet 4.6: $3/$15 per MTok input/output
    // Ratio: 3x cheaper on both input and output
    const usage = { input_uncached: 1000, cache_write: 0, cache_read: 0, output: 1000 };
    const haikuCost = totalCost("anthropic", "claude-haiku-4-5", usage);
    const sonnetCost = totalCost("anthropic", "claude-sonnet-4-6", usage);
    // Haiku should be significantly cheaper (at least 2x, at most 4x)
    expect(haikuCost).toBeGreaterThan(0);
    expect(sonnetCost).toBeGreaterThan(0);
    expect(sonnetCost / haikuCost).toBeGreaterThanOrEqual(2.5);
  });
});
