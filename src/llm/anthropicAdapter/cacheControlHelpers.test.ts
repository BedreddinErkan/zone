import { describe, expect, it, vi, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { applyMessageCacheBreakpoint2, MANIFEST_CONTENT_PREFIX } from "./cacheControlHelpers.js";

function userMsg(content: string | Anthropic.MessageParam["content"]): Anthropic.MessageParam {
  return { role: "user", content } as Anthropic.MessageParam;
}

function assistantMsg(content: string): Anthropic.MessageParam {
  return { role: "assistant", content };
}

describe("applyMessageCacheBreakpoint2", () => {
  it("returns messages unchanged when disabled", () => {
    const msgs = [userMsg("hello")];
    const result = applyMessageCacheBreakpoint2(msgs, { enabled: false });
    expect(result).toBe(msgs); // same reference
  });

  it("returns messages unchanged when empty array", () => {
    const result = applyMessageCacheBreakpoint2([], { enabled: true });
    expect(result).toEqual([]);
  });

  it("returns unchanged when no user message exists", () => {
    const msgs = [assistantMsg("hi")];
    const result = applyMessageCacheBreakpoint2(msgs, { enabled: true });
    expect(result).toBe(msgs);
  });

  it("skips single tiny user message (isFirstAndTiny)", () => {
    const msgs = [userMsg("short")];
    const result = applyMessageCacheBreakpoint2(msgs, { enabled: true });
    expect(result).toBe(msgs); // returned unchanged
  });

  it("applies to single user message that exceeds threshold", () => {
    const longContent = "x".repeat(600);
    const msgs = [userMsg(longContent)];
    const result = applyMessageCacheBreakpoint2(msgs, { enabled: true });
    expect(result).not.toBe(msgs);
    const target = result[0];
    expect(Array.isArray(target.content)).toBe(true);
    const blocks = target.content as Array<{ cache_control?: unknown }>;
    expect(blocks[blocks.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("converts string content to block array with cache_control on last user message", () => {
    const msgs = [assistantMsg("step1"), userMsg("do something")];
    const result = applyMessageCacheBreakpoint2(msgs, { enabled: true });
    expect(result[0]).toBe(msgs[0]); // assistant unchanged
    const lastUser = result[1];
    expect(Array.isArray(lastUser.content)).toBe(true);
    const blocks = lastUser.content as Array<{ type: string; text: string; cache_control?: unknown }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("do something");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("attaches cache_control to LAST block when content is already a block array", () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tc1", content: "result" },
          { type: "text", text: "follow-up" },
        ] as unknown as Anthropic.MessageParam["content"],
      },
    ];
    const result = applyMessageCacheBreakpoint2(msgs, { enabled: true });
    const blocks = result[0].content as Array<{ cache_control?: unknown }>;
    expect(blocks[0].cache_control).toBeUndefined(); // first block untouched
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" }); // last block marked
  });

  it("marks the last user message, not earlier ones", () => {
    const msgs = [
      userMsg("first user"),
      assistantMsg("assistant"),
      userMsg("last user"),
    ];
    const result = applyMessageCacheBreakpoint2(msgs, { enabled: true });
    // first user message: unchanged
    expect(result[0]).toBe(msgs[0]);
    // last user message: has cache_control
    const lastBlocks = result[2].content as Array<{ cache_control?: unknown }>;
    expect(lastBlocks[lastBlocks.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("emits [zone-cache-marker-placed] log when ZONE_DEBUG_CACHE_PROBE=1", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env["ZONE_DEBUG_CACHE_PROBE"] = "1";
    try {
      const msgs = [assistantMsg("a"), userMsg("b")];
      applyMessageCacheBreakpoint2(msgs, { enabled: true });
      const written = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(written).toContain("[zone-cache-marker-placed]");
      expect(written).toContain('"markerOnIdx":1');
    } finally {
      delete process.env["ZONE_DEBUG_CACHE_PROBE"];
      logSpy.mockRestore();
    }
  });

  it("does NOT emit debug log when ZONE_DEBUG_CACHE_PROBE is unset", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env["ZONE_DEBUG_CACHE_PROBE"];
    try {
      const msgs = [assistantMsg("a"), userMsg("b")];
      applyMessageCacheBreakpoint2(msgs, { enabled: true });
      const written = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(written).not.toContain("[zone-cache-marker-placed]");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("applyMessageCacheBreakpoint2 — manifest skip (Fix A)", () => {
  function manifestMsg(): Anthropic.MessageParam {
    return {
      role: "user",
      content: `${MANIFEST_CONTENT_PREFIX}\nfoo.ts (2 reads)\n\nRe-read ONLY if modified.\nReference prior content by line number.`,
    };
  }

  function toolResultMsg(id: string): Anthropic.MessageParam {
    return {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content: "ok" } as unknown as Anthropic.ContentBlockParam,
      ],
    };
  }

  it("[..., tool_result_batch, manifest] → marker on tool_result_batch, NOT manifest", () => {
    const msgs: Anthropic.MessageParam[] = [
      userMsg("initial task"),
      assistantMsg("thinking..."),
      toolResultMsg("t1"),
      manifestMsg(),
    ];
    const result = applyMessageCacheBreakpoint2(msgs, { enabled: true });
    // tool_result_batch at index 2 must have the marker
    const toolBatch = result[2].content as Array<{ cache_control?: unknown }>;
    expect(toolBatch[toolBatch.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
    // manifest at index 3 must NOT have the marker
    const manifestContent = result[3].content;
    if (Array.isArray(manifestContent)) {
      const blocks = manifestContent as Array<{ cache_control?: unknown }>;
      expect(blocks[blocks.length - 1]?.cache_control).toBeUndefined();
    } else {
      // still a string → no cache_control applied (string content means unchanged)
      expect(typeof manifestContent).toBe("string");
      expect(result[3]).toBe(msgs[3]);
    }
  });

  it("[..., real_user_prompt, tool_results] → marker stays on tool_results (last non-manifest)", () => {
    const msgs: Anthropic.MessageParam[] = [
      userMsg("initial"),
      assistantMsg("..."),
      toolResultMsg("t1"),
    ];
    const result = applyMessageCacheBreakpoint2(msgs, { enabled: true });
    const toolBatch = result[2].content as Array<{ cache_control?: unknown }>;
    expect(toolBatch[toolBatch.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("manifest-only → falls back to marking manifest (no crash, first iter before tool calls)", () => {
    const msgs: Anthropic.MessageParam[] = [manifestMsg()];
    // Must not throw; marker must be placed somewhere (the manifest itself as fallback)
    const result = applyMessageCacheBreakpoint2(msgs, { enabled: true });
    expect(result).not.toBe(msgs); // something was changed
    const content = result[0].content;
    // string was converted to block with cache_control
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Array<{ cache_control?: unknown }>;
    expect(blocks[blocks.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
  });
});
