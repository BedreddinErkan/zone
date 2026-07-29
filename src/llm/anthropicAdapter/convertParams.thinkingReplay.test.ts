import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { convertParams } from "./convertParams.js";
import {
  ZONE_PROVIDER_FIELD,
  selectThinkingReplayIndices,
  countThinkingDroppedForModel,
  THINKING_REPLAY_TURNS,
  type ProviderThinkingBlock,
} from "./thinkingBlocks.js";

const MODEL = "claude-opus-5";
const OTHER_MODEL = "claude-sonnet-5";
const SIGNATURE = "ErUBCkYIAxgCIkDx7f2vQ9k1mZ0nR8sT4uV6wX2yZ0aB3cD5eF7gH9iJ==";

function block(text: string): ProviderThinkingBlock {
  return { type: "thinking", thinking: text, signature: SIGNATURE };
}

function assistant(
  callId: string,
  thinking: ProviderThinkingBlock[] | null,
  model = MODEL,
  content: string | null = null
): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content,
    tool_calls: [
      { id: callId, type: "function", function: { name: "read_file", arguments: '{"filePath":"a.ts"}' } },
    ],
    ...(thinking ? { [ZONE_PROVIDER_FIELD]: { blocks: thinking, model } } : {}),
  } as unknown as ChatCompletionMessageParam;
}

function tool(callId: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: callId, content: "file contents" } as ChatCompletionMessageParam;
}

function translate(messages: ChatCompletionMessageParam[], model = MODEL): Anthropic.MessageParam[] {
  return convertParams({ model, messages, max_tokens: 1024 }).params.messages;
}

function assistantBlocks(msgs: Anthropic.MessageParam[], nth = 0): Anthropic.ContentBlockParam[] {
  const assistants = msgs.filter((m) => m.role === "assistant");
  const content = assistants[nth]?.content;
  return Array.isArray(content) ? (content as Anthropic.ContentBlockParam[]) : [];
}

describe("selectThinkingReplayIndices", () => {
  const history = [
    { role: "user" },
    assistant("c1", [block("one")]),
    tool("c1"),
    assistant("c2", [block("two")]),
    tool("c2"),
  ] as ChatCompletionMessageParam[];

  it("selects every turn by default — the window is unlimited", () => {
    // A bounded window makes an already-cached turn lose its thinking on the next
    // iteration, changing bytes Anthropic already matched. See
    // thinkingPrefixStability.test.ts for the measurement.
    expect(THINKING_REPLAY_TURNS).toBe(Number.POSITIVE_INFINITY);
    expect([...selectThinkingReplayIndices(history, MODEL)].sort()).toEqual([1, 3]);
  });

  it("selects nothing when the model differs", () => {
    expect([...selectThinkingReplayIndices(history, OTHER_MODEL)]).toEqual([]);
  });

  it("selects nothing when the request model is unknown", () => {
    expect([...selectThinkingReplayIndices(history, undefined)]).toEqual([]);
  });

  it("narrows with an explicit turn budget", () => {
    // The parameter still exists so the bounded behaviour stays testable — it is
    // what the append-only regression guard compares against.
    expect([...selectThinkingReplayIndices(history, MODEL, 1)]).toEqual([3]);
  });

  it("ignores assistant turns without tool_calls", () => {
    const withFinal = [
      ...history,
      { role: "assistant", content: "done", [ZONE_PROVIDER_FIELD]: { blocks: [block("final")], model: MODEL } },
    ] as unknown as ChatCompletionMessageParam[];
    // The trailing turn ends the exchange — no tool_result is coming back that
    // its reasoning has to survive to meet — so only tool-calling turns are
    // selected, and the final turn's own blocks are never replayed.
    expect([...selectThinkingReplayIndices(withFinal, MODEL)].sort()).toEqual([1, 3]);
  });
});

describe("replay into Anthropic params", () => {
  it("emits thinking ahead of text and tool_use", () => {
    const msgs = translate([
      { role: "user", content: "fix it" } as ChatCompletionMessageParam,
      assistant("c1", [block("Check the reducer.")], MODEL, "Looking now."),
      tool("c1"),
    ]);

    const types = assistantBlocks(msgs).map((b) => b.type);
    expect(types).toEqual(["thinking", "text", "tool_use"]);
  });

  it("re-emits the block byte-identically", () => {
    const original = block("Exact bytes matter — the signature is over them.");
    const msgs = translate([
      { role: "user", content: "task" } as ChatCompletionMessageParam,
      assistant("c1", [original]),
      tool("c1"),
    ]);

    const emitted = assistantBlocks(msgs)[0];
    expect(JSON.stringify(emitted)).toBe(JSON.stringify(original));
    expect(emitted).toBe(original as unknown as Anthropic.ContentBlockParam);
  });

  it("carries redacted_thinking without inspecting it", () => {
    const redacted = { type: "redacted_thinking", data: "encrypted-payload" } as ProviderThinkingBlock;
    const msgs = translate([
      { role: "user", content: "task" } as ChatCompletionMessageParam,
      assistant("c1", [redacted]),
      tool("c1"),
    ]);

    const emitted = assistantBlocks(msgs)[0];
    expect(JSON.stringify(emitted)).toBe(JSON.stringify(redacted));
  });

  it("replays every tool-calling turn that carries thinking", () => {
    const msgs = translate([
      { role: "user", content: "task" } as ChatCompletionMessageParam,
      assistant("c1", [block("older")]),
      tool("c1"),
      assistant("c2", [block("newest")]),
      tool("c2"),
    ]);

    expect(assistantBlocks(msgs, 0).map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    const newest = assistantBlocks(msgs, 1);
    expect(newest.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect((newest[0] as unknown as { thinking: string }).thinking).toBe("newest");
  });

  it("drops thinking when the request model differs from the signing model", () => {
    const msgs = translate(
      [
        { role: "user", content: "task" } as ChatCompletionMessageParam,
        assistant("c1", [block("signed by opus")], MODEL),
        tool("c1"),
      ],
      OTHER_MODEL
    );

    expect(assistantBlocks(msgs).map((b) => b.type)).toEqual(["tool_use"]);
  });

  it("leaves turns without captured thinking unchanged", () => {
    const msgs = translate([
      { role: "user", content: "task" } as ChatCompletionMessageParam,
      assistant("c1", null),
      tool("c1"),
    ]);
    expect(assistantBlocks(msgs).map((b) => b.type)).toEqual(["tool_use"]);
  });

  it("never mutates the caller's history", () => {
    // The R2 shim reuses its previous pruned array by reference; a translation
    // that stripped thinking by rewriting messages would corrupt a prefix another
    // iteration is still holding.
    const history = [
      { role: "user", content: "task" } as ChatCompletionMessageParam,
      assistant("c1", [block("older")]),
      tool("c1"),
      assistant("c2", [block("newest")]),
      tool("c2"),
    ];
    const before = JSON.stringify(history);
    translate(history, OTHER_MODEL);
    translate(history, MODEL);
    expect(JSON.stringify(history)).toBe(before);
  });
});

describe("countThinkingDroppedForModel", () => {
  it("counts turns whose thinking will not be replayed after a model change", () => {
    const history = [
      { role: "user", content: "task" } as ChatCompletionMessageParam,
      assistant("c1", [block("a")], MODEL),
      tool("c1"),
      assistant("c2", [block("b")], MODEL),
      tool("c2"),
    ];
    expect(countThinkingDroppedForModel(history, OTHER_MODEL)).toBe(2);
    expect(countThinkingDroppedForModel(history, MODEL)).toBe(0);
  });
});
