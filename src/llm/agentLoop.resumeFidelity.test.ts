/**
 * The cold path: what a resumed run gets back, and what it silently didn't.
 *
 * Three defects, one theme — the conversation was restored but everything
 * derived from it was not, so a resumed run looked continuous while behaving
 * like a cold start in three separate ways.
 *
 * FORWARD COMPATIBILITY: every transform here filters or passes messages by
 * reference and never rebuilds one field by field. Thinking blocks do not enter
 * the history yet; when they do, a rebuild would drop them silently, and these
 * identity assertions are what will catch it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const mocks = vi.hoisted(() => ({ createChatCompletion: vi.fn() }));
vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({ provider: "openai", createChatCompletion: mocks.createChatCompletion })),
}));
vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

import { pruneStaleReads, isPrunedPlaceholder } from "./contextPruner.js";
import { stripTrailingManifests, rehydrateFileAccess, runAgentLoop } from "./agentLoop.js";
import { MANIFEST_CONTENT_PREFIX } from "./anthropicAdapter/cacheControlHelpers.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

function assistantRead(id: string, filePath: string): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{
      id,
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ filePath, lineRange: null }) },
    }],
  } as ChatCompletionMessageParam;
}

function toolResult(id: string, content: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: id, content } as ChatCompletionMessageParam;
}

const manifestMsg = (): ChatCompletionMessageParam => ({
  role: "user",
  content: `${MANIFEST_CONTENT_PREFIX}\nsrc/a.ts\n\nRe-read ONLY if the file was modified.`,
});

// ── defect 4 ─────────────────────────────────────────────────────────────────

describe("pruneStaleReads is idempotent", () => {
  /** Enough groups that the first read is well outside the fresh window. */
  function historyWithStaleRead(): ChatCompletionMessageParam[] {
    const msgs: ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      assistantRead("c1", "src/big.ts"),
      toolResult("c1", "x".repeat(5000)),
    ];
    for (let i = 2; i <= 6; i++) {
      msgs.push(assistantRead(`c${i}`, `src/other${i}.ts`));
      msgs.push(toolResult(`c${i}`, "small"));
    }
    return msgs;
  }

  it("re-pruning a restored history does not summarize the summary", () => {
    // The killer detail: the original content is already gone by the second
    // pass, so a second elision would record the PLACEHOLDER's byte count as
    // though it were the file's — wrong, and unrecoverable.
    const first = pruneStaleReads(historyWithStaleRead(), 2);
    expect(first.stats.blocksReplaced).toBeGreaterThan(0);

    const placeholder = (first.pruned[3] as { content?: string }).content ?? "";
    expect(isPrunedPlaceholder(placeholder)).toBe(true);
    expect(placeholder).toContain("src/big.ts");
    expect(placeholder).toContain("5000 bytes");

    const second = pruneStaleReads(first.pruned, 2);
    expect(second.stats.blocksReplaced).toBe(0);
    expect((second.pruned[3] as { content?: string }).content).toBe(placeholder);

    // Third pass, in case idempotence only held once.
    const third = pruneStaleReads(second.pruned, 2);
    expect((third.pruned[3] as { content?: string }).content).toBe(placeholder);
  });

  it("passes an already-pruned message through by reference", () => {
    const first = pruneStaleReads(historyWithStaleRead(), 2);
    const second = pruneStaleReads(first.pruned, 2);
    // Identity, not equality: a rebuilt object would satisfy toEqual while
    // having dropped every field this module does not know about.
    expect(second.pruned[3]).toBe(first.pruned[3]);
  });
});

// ── defect 5 ─────────────────────────────────────────────────────────────────

describe("stripTrailingManifests", () => {
  it("drops a trailing manifest so it is never persisted as conversation", () => {
    // The manifest is a per-iteration cache notice wearing a user message's
    // clothes. Persisted, a resumed run opens with a stale file list that reads
    // as something the user said.
    const msgs = [
      { role: "user", content: "task" },
      assistantRead("c1", "src/a.ts"),
      toolResult("c1", "contents"),
      manifestMsg(),
    ];
    const out = stripTrailingManifests(msgs);
    expect(out).toHaveLength(3);
    expect((out[2] as { role?: string }).role).toBe("tool");
  });

  it("drops several, if several accumulated", () => {
    const msgs = [{ role: "user", content: "task" }, manifestMsg(), manifestMsg()];
    expect(stripTrailingManifests(msgs)).toHaveLength(1);
  });

  it("keeps a real trailing user message", () => {
    const msgs = [assistantRead("c1", "src/a.ts"), { role: "user", content: "also do X" }];
    expect(stripTrailingManifests(msgs)).toHaveLength(2);
  });

  it("keeps a manifest that is not at the tail — history is not rewritten", () => {
    const msgs = [manifestMsg(), assistantRead("c1", "src/a.ts")];
    expect(stripTrailingManifests(msgs)).toHaveLength(2);
  });

  it("returns the same array when there is nothing to strip", () => {
    const msgs = [{ role: "user", content: "task" }];
    expect(stripTrailingManifests(msgs)).toBe(msgs);
  });

  it("survivors are the same objects", () => {
    const kept = assistantRead("c1", "src/a.ts");
    const out = stripTrailingManifests([kept, manifestMsg()]);
    expect(out[0]).toBe(kept);
  });
});

// ── defect 6 ─────────────────────────────────────────────────────────────────

describe("rehydrateFileAccess", () => {
  it("recovers reads so the first post-resume patch is not rejected", () => {
    // Without this the loop tells the model it has not read a file that is
    // visibly present in its own restored context, and the model re-reads to
    // satisfy a gate that is simply misinformed.
    const { entries, filesRead } = rehydrateFileAccess([
      { role: "system", content: "sys" },
      assistantRead("c1", "src/auth.ts"),
      toolResult("c1", "contents"),
    ]);
    expect(filesRead.has("src/auth.ts")).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tool: "read_file", success: true });
  });

  it("recovers writes and patches too — both satisfy the same gate", () => {
    const write: ChatCompletionMessageParam = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "w1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ filePath: "src/new.ts", content: "x" }) } },
        { id: "p1", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ filePath: "src/old.ts" }) } },
      ],
    } as ChatCompletionMessageParam;
    const { entries } = rehydrateFileAccess([write]);
    expect(entries.map((e) => e.tool).sort()).toEqual(["apply_patch", "write_file"]);
  });

  it("ignores tools the read gate does not consult", () => {
    const other: ChatCompletionMessageParam = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "s1", type: "function", function: { name: "search_in_files", arguments: JSON.stringify({ query: "x" }) } }],
    } as ChatCompletionMessageParam;
    expect(rehydrateFileAccess([other]).entries).toHaveLength(0);
  });

  it("skips unparseable arguments instead of inventing a path", () => {
    const broken: ChatCompletionMessageParam = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "b1", type: "function", function: { name: "read_file", arguments: "{not json" } }],
    } as ChatCompletionMessageParam;
    const { entries, filesRead } = rehydrateFileAccess([broken]);
    expect(entries).toHaveLength(0);
    expect(filesRead.size).toBe(0);
  });

  it("tolerates a history with no assistant turns at all", () => {
    expect(rehydrateFileAccess([{ role: "user", content: "hi" }]).entries).toHaveLength(0);
    expect(rehydrateFileAccess([]).entries).toHaveLength(0);
  });

  it("does not mutate the messages it reads", () => {
    const msg = assistantRead("c1", "src/a.ts");
    const before = JSON.stringify(msg);
    rehydrateFileAccess([msg]);
    expect(JSON.stringify(msg)).toBe(before);
  });
});

// ── defect 6, at the loop level ──────────────────────────────────────────────

describe("what a warm resume actually hands the model", () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-resume-"));
    resetToolExecutorMock(toolExecutorMock);
    mocks.createChatCompletion.mockReset();
    toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "ok" });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(repoPath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const doneResponse = {
    choices: [{
      message: { content: "done [ZONE_VERIFICATION: tests_skipped_no_infra]", tool_calls: null },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };

  /** A prior run that read one file, as the envelope would have stored it. */
  const priorConversation = (): unknown[] => [
    { role: "system", content: "OLD system prompt that must be replaced" },
    { role: "user", content: "the original task" },
    assistantRead("c1", "src/auth.ts"),
    toolResult("c1", "export const auth = 1;"),
  ];

  it("patches a file read before the interruption without re-reading it", async () => {
    // The regression: toolCallLog starts empty on resume, so the read-before-
    // patch gate rejected the first patch against a file the model had read and
    // could still see in its restored context.
    mocks.createChatCompletion
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "p1",
              type: "function",
              function: {
                name: "apply_patch",
                arguments: JSON.stringify({
                  filePath: "src/auth.ts",
                  patch: "--- FIND ---\nold\n--- REPLACE ---\nnew",
                  intent: "modify",
                }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce(doneResponse);

    await runAgentLoop({
      task: "finish it",
      repoPath,
      runId: "run-warm",
      resumeMessages: priorConversation(),
    });

    const replies = mocks.createChatCompletion.mock.calls
      .flatMap((c) => ((c[0] as { messages?: Array<{ role: string; content?: unknown }> })?.messages ?? []))
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content ?? ""));
    expect(replies.some((r) => r.includes("You haven't read"))).toBe(false);
    // The patch reached the executor rather than being intercepted by the gate.
    expect(toolExecutorMock.executeTool).toHaveBeenCalled();
  });

  it("replaces the stored system prompt instead of carrying a stale one", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(doneResponse);
    await runAgentLoop({
      task: "finish it",
      repoPath,
      runId: "run-warm-sys",
      resumeMessages: priorConversation(),
    });
    const sent = (mocks.createChatCompletion.mock.calls[0]![0] as { messages: Array<{ role: string; content?: unknown }> }).messages;
    expect(String(sent[0]!.content)).not.toContain("OLD system prompt");
    expect(sent[0]!.role).toBe("system");
  });

  it("delivers the reconciliation context, which the warm branch used to drop", async () => {
    // buildResumeContextBlock's output — dropped staged edits, files already on
    // disk, and whether the conversation itself survived — was built and then
    // discarded on this branch, making warm resume the one path where the model
    // was never told what changed underneath it.
    mocks.createChatCompletion.mockResolvedValueOnce(doneResponse);
    await runAgentLoop({
      task: "finish it",
      repoPath,
      runId: "run-warm-ctx",
      resumeMessages: priorConversation(),
      resumeContextBlock: "RESUMED RUN — Dropped staged changes (conflicts): src/x.ts",
    });
    const sent = (mocks.createChatCompletion.mock.calls[0]![0] as { messages: Array<{ role: string; content?: unknown }> }).messages;
    const last = sent[sent.length - 1]!;
    expect(last.role).toBe("user");
    expect(String(last.content)).toContain("Dropped staged changes");
  });

  it("re-announces the restored plan so the checklist is not blank", async () => {
    const events: Array<{ type?: string; todos?: unknown[] }> = [];
    mocks.createChatCompletion.mockResolvedValueOnce(doneResponse);
    await runAgentLoop({
      task: "finish it",
      repoPath,
      runId: "run-warm-todos",
      resumeMessages: priorConversation(),
      resumeTodos: [{ id: "t1", text: "wire the adapter", status: "in_progress" }],
      onStructuredEvent: (e: unknown) => events.push(e as { type?: string; todos?: unknown[] }),
    });
    const initialized = events.find((e) => e.type === "todos_initialized");
    expect(initialized).toBeDefined();
    expect(initialized!.todos).toHaveLength(1);
  });
});
