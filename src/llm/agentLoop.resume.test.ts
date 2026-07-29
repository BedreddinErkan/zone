/**
 * Inc-1 resume tests:
 *   B-integration — per-iteration checkpoint fires during read-only phase (before staging).
 *   B-cap         — over-cap messages are omitted from the checkpoint envelope.
 *   Seed          — resumeMessages replaces old system message, carries prior conversation.
 *
 * diskRunEnvelope is partially mocked so saveRunEnvelope captures what the checkpoint writer
 * actually stores, bypassing real I/O and eliminating the race window between the coalescing
 * writer and stampEnvelopeStatus.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

// ── Mocks (all hoisted before module imports) ────────────────────────────────

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

const adapterMocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));


const envelopeMocks = vi.hoisted(() => ({
  saveRunEnvelope: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  stampEnvelopeStatus: vi.fn().mockResolvedValue(undefined),
  deleteRunEnvelope: vi.fn().mockResolvedValue(undefined),
  loadRunEnvelope: vi.fn().mockResolvedValue(null),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: adapterMocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);


// Partial mock: keep createCoalescingWriter + other pure helpers real;
// replace disk-writing functions with spies.
vi.mock("../api/diskRunEnvelope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/diskRunEnvelope.js")>();
  return {
    ...actual,
    saveRunEnvelope: envelopeMocks.saveRunEnvelope,
    stampEnvelopeStatus: envelopeMocks.stampEnvelopeStatus,
    deleteRunEnvelope: envelopeMocks.deleteRunEnvelope,
    loadRunEnvelope: envelopeMocks.loadRunEnvelope,
  };
});

import { runAgentLoop } from "./agentLoop.js";

// ── Response builders ────────────────────────────────────────────────────────

function makeReadFileResponse(id: string, filePath: string) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id,
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ filePath }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeDoneResponse(text = "[ZONE_VERIFICATION: tests_inconclusive] Done.") {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// ── Shared setup ─────────────────────────────────────────────────────────────

const SESSION_ID = "inc1-resume-test-session";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-resume-inc1-"));

  resetToolExecutorMock(toolExecutorMock);
  toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
    if (name === "read_file") return { success: true, output: "// file content" };
    return { success: true, output: "" };
  });

  adapterMocks.createChatCompletion.mockReset();
  envelopeMocks.saveRunEnvelope.mockReset().mockResolvedValue(undefined);
  envelopeMocks.stampEnvelopeStatus.mockReset().mockResolvedValue(undefined);
  envelopeMocks.deleteRunEnvelope.mockReset().mockResolvedValue(undefined);
  envelopeMocks.loadRunEnvelope.mockReset().mockResolvedValue(null);

  // Default: pass-through pruner (preserves messages unchanged)
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ── B-integration: per-iter checkpoint during read-only phase ─────────────────

describe("Inc-1 checkpoint: per-iteration write fires before any staging", () => {
  it("B-integration: saveRunEnvelope is called with messages populated after read-only iters", async () => {
    // 3 read_file iterations, no writes. Per-iter checkpoint must fire at each iter start,
    // before staging exists. Proves ownsStagingFiles (= parentStagingFiles===undefined)
    // is true from the first iteration, not gated on first staging write.
    let callCount = 0;
    adapterMocks.createChatCompletion.mockImplementation(async () => {
      callCount++;
      if (callCount <= 3) return makeReadFileResponse(`rf-${callCount}`, `src/file${callCount}.ts`);
      return makeDoneResponse();
    });

    await runAgentLoop({
      task: "investigate the codebase",
      repoPath,
      sessionId: SESSION_ID,
      maxIterationsOverride: 10,
    });

    // Find saveRunEnvelope calls where messages is a non-empty array.
    // These come from the coalescing checkpoint writer (not stampEnvelopeStatus, which is mocked).
    const checkpointCalls = (envelopeMocks.saveRunEnvelope.mock.calls as unknown[][])
      .map((args) => args[0] as { messages?: unknown[]; status?: string })
      .filter((env) => env.status === "running" && Array.isArray(env.messages) && (env.messages as unknown[]).length > 0);

    expect(checkpointCalls.length).toBeGreaterThan(0);
    // messages[0] must be the system message
    const msgs = checkpointCalls[0]!.messages as { role: string }[];
    expect(msgs[0].role).toBe("system");
  });

  it("B-cap: over-cap messages are omitted (messages === undefined in checkpoint)", async () => {
    // Push the history over MAX_STAGED_CONTENT_BYTES (1MB) the way a real run
    // does — an oversized tool result — rather than by injecting a message
    // through a processor mock. buildEnvelopeSnapshot must omit `messages`.
    toolExecutorMock.executeTool.mockImplementation(async () => ({
      success: true,
      output: "X".repeat(1_100_000),
    }));

    adapterMocks.createChatCompletion
      .mockResolvedValueOnce(makeReadFileResponse("rf-cap", "src/big.ts"))
      .mockResolvedValue(makeDoneResponse());

    await runAgentLoop({
      task: "investigate",
      repoPath,
      sessionId: SESSION_ID,
      maxIterationsOverride: 5,
    });

    // All "running" checkpoint calls must have messages === undefined (over cap).
    const runningCalls = (envelopeMocks.saveRunEnvelope.mock.calls as unknown[][])
      .map((args) => args[0] as { messages?: unknown[]; status?: string })
      .filter((env) => env.status === "running");

    expect(runningCalls.length).toBeGreaterThan(0);

    // The earliest checkpoint fires before the oversized tool result exists, so
    // it legitimately carries a small history. The invariant is the one that
    // matters for resume: once the history is over cap it is omitted, and no
    // checkpoint ever carries an over-cap array.
    const omitted = runningCalls.filter((env) => env.messages === undefined);
    expect(omitted.length).toBeGreaterThan(0);
    for (const env of runningCalls) {
      if (env.messages === undefined) continue;
      expect(JSON.stringify(env.messages).length).toBeLessThanOrEqual(1_000_000);
    }
  });

});

// ── Seed-correctness: resumeMessages replaces system, carries history ─────────

describe("Inc-1 seed: resumeMessages seeds responseInput correctly", () => {
  it("first adapter call sees fresh system at [0] and carried conversation at [1+]", async () => {
    const OLD_SYS = "OLD SYSTEM PROMPT — must not survive into resumed run";
    const resumeMessages = [
      { role: "system", content: OLD_SYS },
      { role: "user", content: "original task from prior run" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "tc-prior-1",
          type: "function",
          function: { name: "read_file", arguments: '{"filePath":"src/foo.ts"}' },
        }],
      },
      { role: "tool", content: "// foo content", tool_call_id: "tc-prior-1" },
    ];

    const adapterCallMessages: { role: string; content: unknown }[][] = [];
    adapterMocks.createChatCompletion.mockImplementation(
      async (params: { messages: { role: string; content: unknown }[] }) => {
        adapterCallMessages.push(params.messages.slice());
        return makeDoneResponse();
      },
    );

    await runAgentLoop({
      task: "continue the task",
      repoPath,
      sessionId: SESSION_ID,
      maxIterationsOverride: 3,
      resumeMessages,
    });

    expect(adapterCallMessages.length).toBeGreaterThan(0);
    const first = adapterCallMessages[0]!;

    // [0] must be a fresh system message — NOT the old one ("OLD_SYS")
    expect(first[0].role).toBe("system");
    expect(String(first[0].content)).not.toContain(OLD_SYS);

    // [1] must be the carried user message
    expect(first[1].role).toBe("user");
    expect(String(first[1].content)).toContain("original task from prior run");

    // [2] and [3] must be the carried assistant + tool turns (order preserved)
    expect(first[2].role).toBe("assistant");
    expect(first[3].role).toBe("tool");
  });
});
