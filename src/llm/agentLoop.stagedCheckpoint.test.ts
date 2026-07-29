/**
 * Stage 1 R3 checkpoint: inert-layer integration tests for agentLoop.
 * Tests restageSeed injection and that the new fields/types are wired correctly.
 * The beforeFlush callback behavior is covered in staging.checkpoint.test.ts.
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
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-staged-checkpoint-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("R3 agentLoop — restageSeed injection", () => {
  it("restageSeed content appears in the first user message, not in system prompt", async () => {
    const capturedParams: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    mocks.createChatCompletion.mockImplementation(async (params: typeof capturedParams[0]) => {
      capturedParams.push(params);
      return makeDoneResponse("[ZONE_VERIFICATION: no_verification_attempted]");
    });

    // restageSeed: absolute path pointing to a non-existent file (ENOENT → new-file diff)
    const seedFilePath = path.join(repoPath, "src/module.ts");
    const restageSeed = new Map([[seedFilePath, "export function hello() {}"]]);

    await runAgentLoop({
      task: "improve the hello function",
      repoPath,
      maxIterationsOverride: 1,
      restageSeed,
    });

    expect(capturedParams.length).toBeGreaterThanOrEqual(1);
    const firstCall = capturedParams[0]!;

    // System prompt must NOT contain PRIOR STAGING ATTEMPT
    const systemMsg = firstCall.messages.find((m) => m.role === "system");
    expect(typeof systemMsg?.content === "string" ? systemMsg.content : "").not.toContain("PRIOR STAGING ATTEMPT");

    // First user message MUST contain PRIOR STAGING ATTEMPT
    const userMsg = firstCall.messages.find((m) => m.role === "user");
    expect(typeof userMsg?.content === "string" ? userMsg.content : "").toContain("PRIOR STAGING ATTEMPT");
    expect(typeof userMsg?.content === "string" ? userMsg.content : "").toContain("module.ts");
  });

  it("absent restageSeed → no PRIOR STAGING ATTEMPT in user message", async () => {
    const capturedParams: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    mocks.createChatCompletion.mockImplementation(async (params: typeof capturedParams[0]) => {
      capturedParams.push(params);
      return makeDoneResponse("[ZONE_VERIFICATION: no_verification_attempted]");
    });

    await runAgentLoop({
      task: "do something",
      repoPath,
      maxIterationsOverride: 1,
    });

    const firstCall = capturedParams[0]!;
    const userMsg = firstCall.messages.find((m) => m.role === "user");
    expect(typeof userMsg?.content === "string" ? userMsg.content : "").not.toContain("PRIOR STAGING ATTEMPT");
  });
});

describe("R3 agentLoop — stagedCheckpoint flag (inert with no staged files)", () => {
  it("stagedCheckpoint:false → run completes as natural_completion, no staged_diffs events", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      makeDoneResponse("[ZONE_VERIFICATION: no_verification_attempted]")
    );
    const events: unknown[] = [];

    const result = await runAgentLoop({
      task: "read the readme",
      repoPath,
      maxIterationsOverride: 1,
      stagedCheckpoint: false,
      onStructuredEvent: (evt) => { events.push(evt); },
    });

    expect(result.terminationReason).toBe("natural_completion");
    const stagedEvents = events.filter(
      (e): e is { type: string } =>
        typeof e === "object" && e !== null && (e as Record<string, unknown>)["type"] === "staged_diffs_ready_for_approval"
    );
    expect(stagedEvents).toHaveLength(0);
  });

  it("stagedCheckpoint:true with autoApprove:true → run completes (no deadlock, no staged files → beforeFlush not reached)", async () => {
    mocks.createChatCompletion.mockResolvedValue(
      makeDoneResponse("[ZONE_VERIFICATION: no_verification_attempted]")
    );

    const result = await runAgentLoop({
      task: "read the readme",
      repoPath,
      maxIterationsOverride: 1,
      stagedCheckpoint: true,
      autoApprove: true,
    });

    // No staged files → finalizeStaging skips → beforeFlush never called → natural_completion
    expect(result.terminationReason).toBe("natural_completion");
  });

  it("AgentLoopResult terminationReason union includes staged_rejected and staged_refine_requested", () => {
    // Compile-time type check: these values must be assignable to the terminationReason union.
    const tr1: typeof import("./agentLoop.js").runAgentLoop extends (...args: never[]) => Promise<infer R>
      ? R["terminationReason"]
      : never = "staged_rejected";
    const tr2: typeof import("./agentLoop.js").runAgentLoop extends (...args: never[]) => Promise<infer R>
      ? R["terminationReason"]
      : never = "staged_refine_requested";
    // Both must be assignable (TypeScript check at compile time; this line is just a runtime no-op)
    expect(tr1).toBe("staged_rejected");
    expect(tr2).toBe("staged_refine_requested");
  });
});
