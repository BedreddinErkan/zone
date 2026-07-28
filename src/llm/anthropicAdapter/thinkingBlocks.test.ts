import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  captureThinkingBlocks,
  extractReasoningText,
  isThinkingBlock,
} from "./thinkingBlocks.js";
import { convertResponse } from "./convertResponse.js";

const SIGNATURE = "ErUBCkYIAxgCIkDx7f2vQ9k1mZ0nR8sT4uV6wX2yZ0aB3cD5eF7gH9iJ==";

function msg(content: unknown[]): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: content as Anthropic.ContentBlock[],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as Anthropic.Message;
}

describe("capture is blind to content", () => {
  it("captures a thinking block that has text", () => {
    const block = { type: "thinking", thinking: "Derive the invariant.", signature: SIGNATURE };
    expect(captureThinkingBlocks([block])).toEqual([block]);
  });

  it("captures a signed block whose content was omitted", () => {
    // The Fable shape: thinking.display defaults to "omitted", so a block may
    // arrive signed and content-free. Gating capture on `typeof thinking ===
    // "string"` would drop it — silently, and only on that model.
    const omitted = { type: "thinking", signature: SIGNATURE };
    expect(captureThinkingBlocks([omitted])).toEqual([omitted]);
  });

  it("captures a redacted_thinking block without reading it", () => {
    const redacted = { type: "redacted_thinking", data: "EroBCkYIAxgCEgxk...encrypted" };
    expect(captureThinkingBlocks([redacted])).toEqual([redacted]);
  });

  it("captures by reference — never a copy", () => {
    // A copy is a re-serialization, which is the one thing signature validation
    // cannot survive.
    const block = { type: "thinking", thinking: "x", signature: SIGNATURE };
    expect(captureThinkingBlocks([block])[0]).toBe(block);
  });

  it("ignores text, tool_use and unknown block types", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1", name: "read_file", input: {} },
      { type: "some_future_block", payload: 1 },
    ];
    expect(captureThinkingBlocks(blocks)).toEqual([]);
    expect(isThinkingBlock(null)).toBe(false);
    expect(isThinkingBlock("thinking")).toBe(false);
  });
});

describe("display extraction is separate from capture", () => {
  it("skips a content-free block that capture still carries", () => {
    const content = [
      { type: "thinking", signature: SIGNATURE },
      { type: "thinking", thinking: "Visible.", signature: SIGNATURE },
    ];
    expect(extractReasoningText(content)).toBe("Visible.");
    expect(captureThinkingBlocks(content)).toHaveLength(2);
  });

  it("never reads redacted_thinking data as text", () => {
    const content = [{ type: "redacted_thinking", data: "encrypted-bytes" }];
    expect(extractReasoningText(content)).toBe("");
  });

  it("joins multiple blocks with a blank line", () => {
    const content = [
      { type: "thinking", thinking: "One.", signature: SIGNATURE },
      { type: "thinking", thinking: "Two.", signature: SIGNATURE },
    ];
    expect(extractReasoningText(content)).toBe("One.\n\nTwo.");
  });
});

describe("convertResponse surfaces both", () => {
  it("attaches thinkingBlocks alongside reasoningText", () => {
    const thinking = { type: "thinking", thinking: "Plan it.", signature: SIGNATURE };
    const out = convertResponse(
      msg([
        thinking,
        { type: "text", text: "Reading now." },
        { type: "tool_use", id: "call_1", name: "read_file", input: { filePath: "a.ts" } },
      ])
    );

    expect(out.thinkingBlocks).toEqual([thinking]);
    expect(out.thinkingBlocks?.[0]).toBe(thinking);
    expect(out.reasoningText).toBe("Plan it.");
    expect(out.choices[0]!.message.content).toBe("Reading now.");
    expect(out.choices[0]!.message.tool_calls).toHaveLength(1);
  });

  it("attaches thinkingBlocks even when no text is readable", () => {
    const out = convertResponse(
      msg([
        { type: "thinking", signature: SIGNATURE },
        { type: "tool_use", id: "call_1", name: "read_file", input: {} },
      ])
    );
    expect(out.thinkingBlocks).toHaveLength(1);
    expect(out.reasoningText).toBeUndefined();
  });

  it("omits the field entirely when the model returned no thinking", () => {
    const out = convertResponse(msg([{ type: "text", text: "Done." }]));
    expect(out.thinkingBlocks).toBeUndefined();
  });

  it("does not leak thinking into the assistant text", () => {
    const out = convertResponse(
      msg([
        { type: "thinking", thinking: "Secret reasoning.", signature: SIGNATURE },
        { type: "text", text: "Answer." },
      ])
    );
    expect(out.choices[0]!.message.content).toBe("Answer.");
  });
});
