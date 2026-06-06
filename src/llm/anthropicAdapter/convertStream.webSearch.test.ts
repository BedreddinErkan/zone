import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { convertStream } from "./convertStream.js";

async function* mockStream(
  events: Anthropic.MessageStreamEvent[]
): AsyncGenerator<Anthropic.MessageStreamEvent, void, unknown> {
  for (const e of events) yield e;
}

async function collectChunks(stream: AsyncIterable<Anthropic.MessageStreamEvent>): Promise<ChatCompletionChunk[]> {
  const chunks: ChatCompletionChunk[] = [];
  for await (const chunk of convertStream(stream)) {
    chunks.push(chunk);
  }
  return chunks;
}

function syntheticUsageChunk(chunks: ChatCompletionChunk[]): Record<string, number> | undefined {
  const c = chunks.find((ch) => ch.choices.length === 0);
  return c ? (c as unknown as { usage?: Record<string, number> }).usage : undefined;
}

describe("convertStream — server_tool_use and web_search_tool_result blocks dropped gracefully", () => {
  it("drops server_tool_use block, text block survives, web_search_requests in usage", async () => {
    const events: Anthropic.MessageStreamEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_srv",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 200, output_tokens: 0 } as Anthropic.Usage,
        },
      },
      // server_tool_use block — not in TS union, cast via unknown
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "server_tool_use", id: "svc_1", name: "web_search", input: {} } as unknown as Anthropic.ContentBlock,
      } as unknown as Anthropic.MessageStreamEvent,
      // delta for the server-tool block — should be ignored
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "SHOULD_NOT_APPEAR" } as Anthropic.TextDelta,
      },
      { type: "content_block_stop", index: 0 },
      // normal text block
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer text" } },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          output_tokens: 10,
          ...(({ server_tool_use: { web_search_requests: 2 } }) as unknown as object),
        } as Anthropic.MessageDeltaUsage,
      },
      { type: "message_stop" },
    ];

    const chunks = await collectChunks(mockStream(events));
    // No crash — stream completed
    const textChunks = chunks.filter((c) => c.choices[0]?.delta?.content !== undefined);
    const combinedText = textChunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(combinedText).toBe("answer text");
    // server_tool_use must not produce tool_call chunks
    const toolCallChunks = chunks.filter((c) => c.choices[0]?.delta?.tool_calls !== undefined);
    expect(toolCallChunks).toHaveLength(0);
    // usage survives with web_search_requests
    const usage = syntheticUsageChunk(chunks);
    expect(usage?.web_search_requests).toBe(2);
  });

  it("does not crash on web_search_tool_result block", async () => {
    const events: Anthropic.MessageStreamEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_res",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 0 } as Anthropic.Usage,
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "web_search_tool_result", tool_use_id: "svc_1", content: [] } as unknown as Anthropic.ContentBlock,
      } as unknown as Anthropic.MessageStreamEvent,
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "result" } },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 } as Anthropic.MessageDeltaUsage,
      },
      { type: "message_stop" },
    ];

    const chunks = await collectChunks(mockStream(events));
    const text = chunks.filter((c) => c.choices[0]?.delta?.content).map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(text).toBe("result");
  });
});

describe("convertStream — web_search_requests forwarding", () => {
  it("forwards web_search_requests from message_delta into synthetic usage chunk", async () => {
    const events: Anthropic.MessageStreamEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 } as Anthropic.Usage,
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          output_tokens: 10,
          // server_tool_use is not part of the TS type but the live API returns it
          ...(({ server_tool_use: { web_search_requests: 3 } }) as unknown as object),
        } as Anthropic.MessageDeltaUsage,
      },
      { type: "message_stop" },
    ];

    const chunks = await collectChunks(mockStream(events));
    const usage = syntheticUsageChunk(chunks);
    expect(usage?.web_search_requests).toBe(3);
  });

  it("carries 0 when server_tool_use is absent", async () => {
    const events: Anthropic.MessageStreamEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 50, output_tokens: 0 } as Anthropic.Usage,
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 } as Anthropic.MessageDeltaUsage,
      },
      { type: "message_stop" },
    ];

    const chunks = await collectChunks(mockStream(events));
    const usage = syntheticUsageChunk(chunks);
    expect(usage?.web_search_requests).toBe(0);
  });

  it("uses Math.max: takes highest count across message_start and message_delta", async () => {
    const events: Anthropic.MessageStreamEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_3",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            // Intermediate count present at message_start
            ...(({ server_tool_use: { web_search_requests: 1 } }) as unknown as object),
          } as Anthropic.Usage,
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: {
          output_tokens: 20,
          // Final cumulative count on message_delta — should win
          ...(({ server_tool_use: { web_search_requests: 3 } }) as unknown as object),
        } as Anthropic.MessageDeltaUsage,
      },
      { type: "message_stop" },
    ];

    const chunks = await collectChunks(mockStream(events));
    const usage = syntheticUsageChunk(chunks);
    expect(usage?.web_search_requests).toBe(3);
  });
});
