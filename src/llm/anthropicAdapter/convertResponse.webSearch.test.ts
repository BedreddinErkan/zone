import { describe, it, expect } from "vitest";
import { convertResponse } from "./convertResponse.js";
import type Anthropic from "@anthropic-ai/sdk";

function baseMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 } as Anthropic.Usage,
    ...overrides,
  };
}

describe("convertResponse — server_tool_use blocks and web_search_requests", () => {
  it("drops server_tool_use block, text block survives", () => {
    const msg = baseMessage({
      content: [
        // server_tool_use is not in the TS union but the live API can return it
        { type: "server_tool_use", id: "svc_1", name: "web_search", input: { query: "node version" } } as unknown as Anthropic.ContentBlock,
        { type: "text", text: "Node.js v20 is current." },
      ],
    });
    const result = convertResponse(msg);
    expect(result.choices[0].message.content).toBe("Node.js v20 is current.");
    expect(result.choices[0].message.tool_calls).toBeUndefined();
  });

  it("extracts web_search_requests from usage.server_tool_use", () => {
    const msg = baseMessage({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        ...(({ server_tool_use: { web_search_requests: 2 } }) as unknown as object),
      } as Anthropic.Usage,
    });
    const result = convertResponse(msg);
    expect((result.usage as Record<string, number>).web_search_requests).toBe(2);
  });

  it("defaults web_search_requests to 0 when server_tool_use absent", () => {
    const msg = baseMessage();
    const result = convertResponse(msg);
    expect((result.usage as Record<string, number>).web_search_requests).toBe(0);
  });

  it("does not crash on web_search_tool_result block in content", () => {
    const msg = baseMessage({
      content: [
        { type: "web_search_tool_result", tool_use_id: "svc_1", content: [] } as unknown as Anthropic.ContentBlock,
        { type: "text", text: "Found it." },
      ],
    });
    const result = convertResponse(msg);
    expect(result.choices[0].message.content).toBe("Found it.");
  });
});

describe("convertResponse — thinking blocks", () => {
  it("extracts thinking block text into reasoningText", () => {
    const msg = baseMessage({
      content: [
        { type: "thinking", thinking: "Let me check the imports first.", signature: "sig" } as unknown as Anthropic.ContentBlock,
        { type: "text", text: "Here is the answer." },
      ],
    });
    const result = convertResponse(msg);
    expect(result.reasoningText).toBe("Let me check the imports first.");
    expect(result.choices[0].message.content).toBe("Here is the answer.");
  });

  it("joins multiple thinking blocks with double newline", () => {
    const msg = baseMessage({
      content: [
        { type: "thinking", thinking: "Step 1.", signature: "sig" } as unknown as Anthropic.ContentBlock,
        { type: "thinking", thinking: "Step 2.", signature: "sig" } as unknown as Anthropic.ContentBlock,
        { type: "text", text: "Done." },
      ],
    });
    const result = convertResponse(msg);
    expect(result.reasoningText).toBe("Step 1.\n\nStep 2.");
  });

  it("reasoningText is undefined when no thinking blocks", () => {
    const msg = baseMessage({
      content: [{ type: "text", text: "Answer." }],
    });
    const result = convertResponse(msg);
    expect(result.reasoningText).toBeUndefined();
  });

  it("thinking text does NOT bleed into message.content", () => {
    const msg = baseMessage({
      content: [
        { type: "thinking", thinking: "Private reasoning.", signature: "sig" } as unknown as Anthropic.ContentBlock,
        { type: "text", text: "Public answer." },
      ],
    });
    const result = convertResponse(msg);
    expect(result.choices[0].message.content).toBe("Public answer.");
    expect(result.choices[0].message.content).not.toContain("Private reasoning.");
  });
});
