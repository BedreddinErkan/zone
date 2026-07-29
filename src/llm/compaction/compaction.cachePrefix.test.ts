import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { ContextCompactor } from "./ContextCompactor.js";
import { convertParams } from "../anthropicAdapter/convertParams.js";
import type { LLMClient } from "../types.js";

/**
 * Compaction must not rewrite cache breakpoint #1.
 *
 * `extractSystem` (convertParams.ts) hoists EVERY `role:"system"` message into
 * the top-level system prompt regardless of where it sits in the array. So a
 * mid-array synthetic system turn — which is what compaction used to emit —
 * lands inside the cached system+tools prefix and invalidates it. That prefix is
 * ~3,879 tokens of static content; re-writing it at 1.25x instead of reading it
 * at 0.1x costs ~4,500 token-equivalents per compaction, up to MAX_COMPACTIONS.
 *
 * Breakpoint #2 busts either way — compaction deletes history by design. #1 is
 * the avoidable half, and this is the test that keeps it avoided.
 */

const MODEL = "claude-opus-5";
// Cache eligibility needs system+tools over the model's minimum, or the
// breakpoint is a no-op and this measures nothing.
const SYSTEM = "You are a coding agent. Follow the patch rules exactly. ".repeat(400);
const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file from disk. ".repeat(20),
      parameters: { type: "object", properties: { filePath: { type: "string" } } },
    },
  },
];

function assistant(i: number): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: `c${i}`, type: "function", function: { name: "read_file", arguments: `{"filePath":"f${i}.ts"}` } },
    ],
  } as ChatCompletionMessageParam;
}

function toolResult(i: number): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: `c${i}`, content: "x".repeat(20_000) } as ChatCompletionMessageParam;
}

function buildHistory(): ChatCompletionMessageParam[] {
  const h: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: "make the flush atomic" },
  ];
  for (let i = 1; i <= 8; i++) h.push(assistant(i), toolResult(i));
  return h;
}

/** The top-level system prompt as it goes on the wire — breakpoint #1's content. */
function wireSystem(messages: ChatCompletionMessageParam[]): string {
  const { params } = convertParams({ model: MODEL, messages, max_tokens: 1024, tools: TOOLS });
  return JSON.stringify(params.system);
}

const stubClient = {
  createChatCompletion: async () => ({
    choices: [{ message: { content: "## Task\nmake the flush atomic\n## Progress\nread 8 files" } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }),
} as unknown as LLMClient;

async function compact(history: ChatCompletionMessageParam[]) {
  const compactor = new ContextCompactor();
  return compactor.checkAndMaybeCompact({
    responseInput: history,
    toolCallLog: Array.from({ length: 8 }, (_, i) => ({
      id: `c${i + 1}`,
      tool: "read_file",
      args: { filePath: `f${i + 1}.ts` },
      result: "ok",
      success: true,
    })) as never,
    // Force the threshold: tier token caps bind first, so compaction may never
    // fire naturally. The structural result does not depend on the trigger.
    currentContextTokens: 999_999,
    contextWindowLimit: 200_000,
    client: stubClient,
    runId: "r1",
  });
}

describe("compaction leaves cache breakpoint #1 intact", () => {
  it("does not change the top-level system prompt", async () => {
    const history = buildHistory();
    const before = wireSystem(history);

    const result = await compact(history);
    expect(result.compacted).toBe(true);

    const after = wireSystem(result.newResponseInput!);
    expect(after).toBe(before);
  });

  it("does not hoist the summary into the system prompt", async () => {
    const history = buildHistory();
    const result = await compact(history);
    expect(wireSystem(result.newResponseInput!)).not.toContain("compacted_history");
  });

  it("still places the summary in the conversation, in position", async () => {
    const history = buildHistory();
    const result = await compact(history);
    const nr = result.newResponseInput!;

    const summaryIdx = nr.findIndex(
      (m) => typeof m.content === "string" && m.content.includes("[compacted_history]")
    );
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(nr[summaryIdx]!.role).toBe("user");
    // Ahead of the surviving recency turns, not appended at the end.
    expect(summaryIdx).toBeLessThan(nr.length - 1);
  });

  it("keeps exactly one system message — the original", async () => {
    const history = buildHistory();
    const result = await compact(history);
    const systemTurns = result.newResponseInput!.filter((m) => m.role === "system");
    expect(systemTurns).toHaveLength(1);
    expect(systemTurns[0]!.content).toBe(SYSTEM);
  });
});
