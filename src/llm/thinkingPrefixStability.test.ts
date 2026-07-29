import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { convertParams } from "./anthropicAdapter/convertParams.js";
import { hashCachedPrefix, MANIFEST_CONTENT_PREFIX } from "./anthropicAdapter/cacheControlHelpers.js";
import { summarize } from "./compaction/summarizer.js";
import {
  ZONE_PROVIDER_FIELD,
  selectThinkingReplayIndices,
  type ProviderThinkingBlock,
} from "./anthropicAdapter/thinkingBlocks.js";

const MODEL = "claude-opus-5";
const SIGNATURE = "ErUBCkYIAxgCIkDx7f2vQ9k1mZ0nR8sT4uV6wX2yZ0aB3cD5eF7gH9iJ==";
const THINKING = "The regression is in the reducer's terminal arm.";

// Cache eligibility needs a system prompt over the model's minimum, or the
// breakpoint is a no-op and this test measures nothing.
const BIG_SYSTEM = "You are a coding agent. ".repeat(600);

function block(text = THINKING): ProviderThinkingBlock {
  return { type: "thinking", thinking: text, signature: SIGNATURE };
}

function assistant(callId: string, thinking: ProviderThinkingBlock[] | null): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: callId, type: "function", function: { name: "read_file", arguments: '{"filePath":"a.ts"}' } },
    ],
    ...(thinking ? { [ZONE_PROVIDER_FIELD]: { blocks: thinking, model: MODEL } } : {}),
  } as unknown as ChatCompletionMessageParam;
}

function tool(callId: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: callId, content: "contents" } as ChatCompletionMessageParam;
}

function markerIdxOf(messages: Anthropic.MessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const c = messages[i]!.content;
    if (!Array.isArray(c)) continue;
    if (c.some((b) => (b as { cache_control?: unknown }).cache_control)) return i;
  }
  return -1;
}

function translated(history: ChatCompletionMessageParam[]): Anthropic.MessageParam[] {
  return convertParams({
    model: MODEL,
    messages: [{ role: "system", content: BIG_SYSTEM }, ...history],
    max_tokens: 1024,
  }).params.messages;
}

describe("cached prefix stability across iterations", () => {
  // Each entry is one iteration's history, growing the way the agent loop grows it.
  const iter1: ChatCompletionMessageParam[] = [
    { role: "user", content: "fix the reducer" } as ChatCompletionMessageParam,
    assistant("c1", [block()]),
    tool("c1"),
  ];
  const iter2: ChatCompletionMessageParam[] = [
    ...iter1,
    assistant("c2", [block("Second thought.")]),
    tool("c2"),
  ];
  const iter3: ChatCompletionMessageParam[] = [
    ...iter2,
    assistant("c3", [block("Third thought.")]),
    tool("c3"),
  ];

  it("the marker lands on the last tool result and advances each iteration", () => {
    // translateMessages renders every role:"tool" as a role:"user" carrying a
    // tool_result block, so the marker is NOT pinned to the initial task — it
    // moves forward with the conversation, which is what puts replayed thinking
    // inside the cached prefix rather than in an uncached tail. The cost
    // argument at THINKING_REPLAY_TURNS depends on this; pinned here so a change
    // in translation surfaces as a failure rather than as a silent bill.
    const m2 = translated(iter2);
    const m3 = translated(iter3);
    expect(markerIdxOf(m2)).toBe(m2.length - 1);
    expect(markerIdxOf(m3)).toBe(m3.length - 1);
    expect(markerIdxOf(m3)).toBeGreaterThan(markerIdxOf(m2));
    expect(m3[markerIdxOf(m3)]!.role).toBe("user"); // a tool_result, in Anthropic terms
  });

  it("each iteration's cached prefix is a byte-identical extension of the previous one", () => {
    // The cache-hit condition. Not "the hash never changes" — the prefix grows
    // by design — but "the part that was already cached is unchanged", which is
    // what Anthropic matches on. A passthrough that reshaped an earlier block
    // would break this while leaving the marker exactly where it was.
    const snapshots = [iter1, iter2, iter3].map((h) => {
      const msgs = translated(h);
      const idx = markerIdxOf(msgs);
      return { msgs, idx, hash: hashCachedPrefix(msgs, idx) };
    });

    for (let i = 1; i < snapshots.length; i += 1) {
      const prev = snapshots[i - 1]!;
      const curr = snapshots[i]!;
      // Re-hash the current iteration truncated to the previous marker: it must
      // equal what the previous iteration actually cached.
      expect(hashCachedPrefix(curr.msgs, prev.idx)).toBe(prev.hash);
    }
  });

  it("a bounded replay window would break append-only — why the window is unlimited", () => {
    // Regression guard for a defect this increment introduced and then measured
    // out. With a finite window an assistant turn carries thinking while it is
    // newest and loses it once it is not, so already-cached bytes change
    // retroactively and every iteration misses from that turn onward. The saving
    // is ~600 tokens that would have been read at 0.1x; the cost is a full-price
    // re-read of the whole tail. If THINKING_REPLAY_TURNS ever becomes finite
    // again, this fails.
    const window1 = selectThinkingReplayIndices(iter2, MODEL, 1);
    const window1Next = selectThinkingReplayIndices(iter3, MODEL, 1);
    const lastAssistantOfIter2 = 3;
    expect(window1.has(lastAssistantOfIter2)).toBe(true);
    expect(window1Next.has(lastAssistantOfIter2)).toBe(false); // the retroactive change

    // Unlimited keeps it: a turn that once replayed its thinking always does.
    expect(selectThinkingReplayIndices(iter2, MODEL).has(lastAssistantOfIter2)).toBe(true);
    expect(selectThinkingReplayIndices(iter3, MODEL).has(lastAssistantOfIter2)).toBe(true);
  });

  it("replayed thinking sits inside the cached prefix, not after it", () => {
    const msgs = translated(iter3);
    const idx = markerIdxOf(msgs);
    const prefix = msgs.slice(0, idx + 1);
    const hasThinking = prefix.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "thinking")
    );
    expect(hasThinking).toBe(true);
  });

  it("stays stable when a Zone-internal field is added to a message that is not replayed", () => {
    // The distinction the agentLoop probe cannot make: an internal field on a
    // non-replayed turn changes that hash but must not change the wire prefix.
    const withField = [...iter3];
    withField[1] = {
      ...(withField[1] as object),
      _zoneInternalMarker: "irrelevant-to-the-api",
    } as unknown as ChatCompletionMessageParam;

    const a = translated(iter3);
    const b = translated(withField);
    expect(hashCachedPrefix(b, markerIdxOf(b))).toBe(hashCachedPrefix(a, markerIdxOf(a)));
  });

  it("a trailing manifest is skipped, leaving the marker on the last tool result", () => {
    const withManifest: ChatCompletionMessageParam[] = [
      ...iter2,
      { role: "user", content: `${MANIFEST_CONTENT_PREFIX}\n- a.ts` } as ChatCompletionMessageParam,
    ];
    const msgs = translated(withManifest);
    expect(markerIdxOf(msgs)).toBe(markerIdxOf(translated(iter2)));
  });
});

describe("compaction summaries exclude thinking", () => {
  it("nothing the summarizer sends carries a thinking block", async () => {
    // The summarizer is the one transform allowed to look inside a turn, so it
    // is the one place thinking could leak into a prompt. It reads content and
    // tool_calls only — excluded by construction, but only while the passthrough
    // lives in its own field rather than inside content. Asserted on what is
    // actually sent, not on the prompt builder, which never sees the turns.
    let sent = "";
    const client = {
      createChatCompletion: (params: unknown) => {
        sent = JSON.stringify(params);
        return Promise.resolve({
          choices: [{ message: { content: "## Task\nfix it" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
      },
    };

    await summarize({
      candidateTurns: [assistant("c1", [block()]), tool("c1")],
      totalCandidates: 2,
      client: client as unknown as Parameters<typeof summarize>[0]["client"],
      runId: "r1",
      compactionDepth: 1,
    });

    expect(sent).not.toContain(THINKING);
    expect(sent).not.toContain(SIGNATURE);
    expect(sent).toContain("read_file"); // the turns really were serialized
  });
});
