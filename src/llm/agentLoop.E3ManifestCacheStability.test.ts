/**
 * E.3 file-read manifest: cache-stability regression tests.
 *
 * Verifies that the manifest is concat'd into the last role:"tool" of
 * prunedMessages (Pattern A) rather than pushed as a trailing role:"user"
 * (Pattern B). Pattern B caused Anthropic cache breakpoint #2 to drift
 * every iter a new file was read, collapsing cache_read to the system+tools
 * floor (~3879 tok). Fixed in Phase E extension, 2026-05-21.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  pruneStaleReads: vi.fn(),
  emitContextPruned: vi.fn(),
  buildFileReadManifest: vi.fn(),
  ContextCompactor: vi.fn(),
  classifyTurns: vi.fn(),
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

vi.mock("./contextPruner.js", () => ({
  pruneStaleReads: mocks.pruneStaleReads,
  emitContextPruned: mocks.emitContextPruned,
}));

vi.mock("./compaction/ContextCompactor.js", () => ({
  buildFileReadManifest: mocks.buildFileReadManifest,
  ContextCompactor: mocks.ContextCompactor,
}));

vi.mock("./compaction/classifyTurns.js", () => ({
  classifyTurns: mocks.classifyTurns,
}));

import { runAgentLoop } from "./agentLoop.js";

function makeRunCommandResponse(id: string) {
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
                name: "run_command",
                arguments: JSON.stringify({ command: "npm test" }),
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

function makeDoneResponse() {
  return {
    choices: [
      {
        message: {
          content: "[ZONE_VERIFICATION: tests_inconclusive]",
          tool_calls: null,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

function makeManifestEntry() {
  return {
    manifest: "- src/foo.ts (1 read, lines 1–50)",
    entryCount: 1,
    structuredEntries: [{ filePath: "src/foo.ts", readCount: 1, lineRange: "1–50" }],
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "zone-e3-manifest-stability-")
  );

  mocks.createChatCompletion.mockReset();
  mocks.executeTool.mockReset();
  mocks.withStagingTempFlush.mockReset();
  mocks.pruneStaleReads.mockReset();
  mocks.emitContextPruned.mockReset();
  mocks.buildFileReadManifest.mockReset();
  mocks.ContextCompactor.mockReset();
  mocks.classifyTurns.mockReset();

  mocks.withStagingTempFlush.mockImplementation(
    async (fn: () => Promise<void>) => fn()
  );
  mocks.pruneStaleReads.mockImplementation((msgs: unknown[]) => ({
    pruned: msgs,
    stats: {
      blocksReplaced: 0,
      charsSaved: 0,
      blocksKept: (msgs as unknown[]).length,
    },
  }));
  mocks.emitContextPruned.mockImplementation(() => {});
  mocks.classifyTurns.mockReturnValue([]);
  mocks.buildFileReadManifest.mockReturnValue({
    manifest: "",
    entryCount: 0,
    structuredEntries: [],
  });
  mocks.ContextCompactor.mockImplementation(() => ({
    checkAndMaybeCompact: vi.fn(async () => ({
      compacted: false,
      newResponseInput: null,
    })),
    getCompactionCount: vi.fn(() => 0),
  }));
  mocks.executeTool.mockImplementation(async () => ({
    success: true,
    exitCode: 0,
    output: "ok",
  }));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

const MANIFEST_MARKER = "Files already read this run";

describe("E.3 manifest injection — Pattern A cache stability", () => {
  it("T.1: manifest text lands in role:tool, NOT as standalone role:user", async () => {
    // Iter 1: no manifest (entryCount=0). LLM returns a tool call.
    // Iter 2: manifest fires (entryCount=1). LLM returns done.
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return makeRunCommandResponse("rc-1");
      return makeDoneResponse();
    });

    // First buildFileReadManifest call (start of iter 1) → no manifest.
    // Second call (start of iter 2) → manifest fires.
    mocks.buildFileReadManifest
      .mockReturnValueOnce({ manifest: "", entryCount: 0, structuredEntries: [] })
      .mockReturnValue(makeManifestEntry());

    await runAgentLoop({
      task: "run tests",
      repoPath,
      maxIterationsOverride: 5,
    });

    const calls = mocks.createChatCompletion.mock.calls as Array<
      [{ messages: Array<{ role: string; content: unknown }> }]
    >;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // Iter 2 receives the manifest-injected prunedMessages.
    const msgs = calls[1]![0].messages;

    // No standalone role:"user" message carrying manifest text.
    const userWithManifest = msgs.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes(MANIFEST_MARKER)
    );
    expect(
      userWithManifest,
      "manifest must NOT be a standalone role:user message (Pattern B anti-pattern)"
    ).toBeUndefined();

    // Manifest IS present inside a role:"tool" message.
    const toolWithManifest = msgs.find(
      (m) =>
        m.role === "tool" &&
        typeof m.content === "string" &&
        m.content.includes(MANIFEST_MARKER)
    );
    expect(
      toolWithManifest,
      "manifest must be concat'd into a role:tool message (Pattern A)"
    ).toBeDefined();
  });

  it("T.2: fallback push fires when no role:tool exists yet (iter-1 edge)", async () => {
    // Manifest fires on iter 1 even though no tool result exists.
    // Backward-scan finds nothing → fallback push role:"user".
    mocks.buildFileReadManifest.mockReturnValue(makeManifestEntry());
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    await runAgentLoop({
      task: "quick task",
      repoPath,
      maxIterationsOverride: 3,
    });

    const calls = mocks.createChatCompletion.mock.calls as Array<
      [{ messages: Array<{ role: string; content: unknown }> }]
    >;
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // Iter 1 prunedMessages: [user_task] → no role:"tool" → fallback pushes user.
    const msgs = calls[0]![0].messages;
    const userWithManifest = msgs.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes(MANIFEST_MARKER)
    );
    expect(
      userWithManifest,
      "fallback push to role:user is acceptable when no tool result exists"
    ).toBeDefined();
  });

  it("T.3: message count delta is +2 per iter when manifest appended (not +3)", async () => {
    // Iter 1: no manifest. LLM → tool call → execute. Iter 2: manifest fires,
    // LLM → done. Delta from iter 1 to iter 2 should be exactly 2
    // (new asst_call + new tool_result with manifest inside it).
    const snapshots: number[] = [];
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(
      async (params: { messages: unknown[] }) => {
        snapshots.push(params.messages.length);
        callCount++;
        if (callCount === 1) return makeRunCommandResponse("rc-t3");
        return makeDoneResponse();
      }
    );

    mocks.buildFileReadManifest
      .mockReturnValueOnce({ manifest: "", entryCount: 0, structuredEntries: [] })
      .mockReturnValue(makeManifestEntry());

    await runAgentLoop({
      task: "run tests",
      repoPath,
      maxIterationsOverride: 5,
    });

    expect(snapshots.length).toBeGreaterThanOrEqual(2);

    // Pattern A: manifest rides inside the existing tool_result — no new message.
    // Delta = asst_call (1) + tool_result (1) = 2.
    // Pattern B would be 3 (asst + tool + standalone user manifest).
    expect(
      snapshots[1]! - snapshots[0]!,
      "manifest must not add an extra message (Pattern A appends into tool result)"
    ).toBe(2);
  });
});
