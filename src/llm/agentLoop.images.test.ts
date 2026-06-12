/**
 * T-MSG: verifies that images passed via AgentLoopInput.images appear as
 * image_url content parts in the initial user message sent to the adapter.
 *
 * T-REGEX: verifies the data-URL format matches the Anthropic adapter's
 * consume-regex /^data:([^;]+);base64,(.+)$/ — the adapter SILENTLY DROPS
 * the image block if the url doesn't match, so this assertion is essential.
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
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("./contextPruner.js", () => ({
  pruneStaleReads: mocks.pruneStaleReads,
  emitContextPruned: mocks.emitContextPruned,
}));

vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

import { runAgentLoop } from "./agentLoop.js";
import type { ImageAttachment } from "../api/imageUpload.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const ADAPTER_REGEX = /^data:([^;]+);base64,(.+)$/s;

function makeDoneResponse() {
  return {
    choices: [{ message: { content: "[ZONE_VERIFICATION: no_verification_attempted]", tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

const TEST_IMAGE: ImageAttachment = {
  mediaType: "image/png",
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
};

// ── fixture ───────────────────────────────────────────────────────────────────

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-images-test-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.pruneStaleReads.mockReset();
  mocks.emitContextPruned.mockReset();

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

describe("AgentLoopInput.images — message construction", () => {
  it("T-MSG: images appear as image_url content parts in the initial user message", async () => {
    let capturedMessages: Array<{ role: string; content: unknown }> | undefined;

    mocks.createChatCompletion.mockImplementation(
      async (params: { messages?: Array<{ role: string; content: unknown }> }) => {
        capturedMessages = params.messages;
        return makeDoneResponse();
      }
    );

    await runAgentLoop({
      task: "what does this image show?",
      repoPath,
      forceTier: "simple",
      images: [TEST_IMAGE],
    });

    expect(capturedMessages).toBeDefined();
    const userMsg = capturedMessages!.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(Array.isArray(userMsg!.content)).toBe(true);

    const parts = userMsg!.content as Array<{ type: string; image_url?: { url: string }; text?: string }>;
    const textPart = parts.find((p) => p.type === "text");
    const imagePart = parts.find((p) => p.type === "image_url");

    expect(textPart).toBeDefined();
    expect(textPart!.text).toContain("what does this image show?");

    expect(imagePart).toBeDefined();
    expect(imagePart!.image_url?.url).toContain("image/png");
    expect(imagePart!.image_url?.url).toContain(TEST_IMAGE.base64);
  });

  it("T-REGEX: data-URL format matches the Anthropic adapter consume-regex", async () => {
    let capturedMessages: Array<{ role: string; content: unknown }> | undefined;

    mocks.createChatCompletion.mockImplementation(
      async (params: { messages?: Array<{ role: string; content: unknown }> }) => {
        capturedMessages = params.messages;
        return makeDoneResponse();
      }
    );

    await runAgentLoop({
      task: "describe the image",
      repoPath,
      forceTier: "simple",
      images: [TEST_IMAGE],
    });

    const userMsg = capturedMessages!.find((m) => m.role === "user");
    const parts = userMsg!.content as Array<{ type: string; image_url?: { url: string } }>;
    const imagePart = parts.find((p) => p.type === "image_url");

    expect(imagePart).toBeDefined();
    const url = imagePart!.image_url!.url;

    // This regex is the EXACT one used in the Anthropic adapter (convertParams.ts:276).
    // If it doesn't match, the adapter silently drops the image block.
    expect(ADAPTER_REGEX.test(url)).toBe(true);

    const match = url.match(ADAPTER_REGEX)!;
    expect(match[1]).toBe("image/png");
    expect(match[2]).toBe(TEST_IMAGE.base64);
  });

  it("no images → user message content is a plain string (existing path unchanged)", async () => {
    let capturedMessages: Array<{ role: string; content: unknown }> | undefined;

    mocks.createChatCompletion.mockImplementation(
      async (params: { messages?: Array<{ role: string; content: unknown }> }) => {
        capturedMessages = params.messages;
        return makeDoneResponse();
      }
    );

    await runAgentLoop({
      task: "no images here",
      repoPath,
      forceTier: "simple",
    });

    const userMsg = capturedMessages!.find((m) => m.role === "user");
    expect(typeof userMsg!.content).toBe("string");
  });
});
