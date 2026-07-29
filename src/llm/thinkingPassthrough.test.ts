import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  ZONE_PROVIDER_FIELD,
  readProviderState,
  type ProviderThinkingBlock,
} from "./anthropicAdapter/thinkingBlocks.js";
import { stripTrailingManifests } from "./agentLoop.js";
import { MANIFEST_CONTENT_PREFIX } from "./anthropicAdapter/cacheControlHelpers.js";
import { BudgetReductionProcessor } from "./history/BudgetReductionProcessor.js";

const SIGNATURE = "ErUBCkYIAxgCIkDx7f2vQ9k1mZ0nR8sT4uV6wX2yZ0aB3cD5eF7gH9iJ==";
const BLOCK: ProviderThinkingBlock = {
  type: "thinking",
  thinking: "The failing assertion is in the reducer, not the view.",
  signature: SIGNATURE,
};

function assistantWithThinking(callId: string, filePath: string): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: callId, type: "function", function: { name: "read_file", arguments: JSON.stringify({ filePath }) } },
    ],
    [ZONE_PROVIDER_FIELD]: { blocks: [BLOCK], model: "claude-opus-5" },
  } as unknown as ChatCompletionMessageParam;
}

function toolResult(callId: string, content: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: callId, content } as ChatCompletionMessageParam;
}

describe("readProviderState", () => {
  it("reads a well-formed state", () => {
    const state = readProviderState(assistantWithThinking("c1", "a.ts"));
    expect(state).toEqual({ blocks: [BLOCK], model: "claude-opus-5" });
  });

  it("rejects malformed or absent state rather than half-trusting it", () => {
    expect(readProviderState(null)).toBeNull();
    expect(readProviderState({ role: "assistant" })).toBeNull();
    expect(readProviderState({ [ZONE_PROVIDER_FIELD]: { blocks: [], model: "m" } })).toBeNull();
    expect(readProviderState({ [ZONE_PROVIDER_FIELD]: { blocks: [BLOCK] } })).toBeNull();
    expect(readProviderState({ [ZONE_PROVIDER_FIELD]: { blocks: [BLOCK], model: "" } })).toBeNull();
  });
});

// The passthrough shape rests on one premise: nothing between the agent loop's
// push and translateMessages rebuilds an assistant message. These tests are that
// premise, not a formality — if any of them fails, the field is being silently
// dropped somewhere in the pipeline and the feature is inert.
describe("assistant messages survive the history pipeline by reference", () => {
  // Two pruneStaleReads cases lived here. R.2 and the U.1 shim were deleted —
  // pruning rewrote an already-cached message and cost 2.3x measured — so there
  // is no longer a processor that rebuilds a tool result. The premise they
  // guarded still matters and is covered below by the processors that remain.

  it("stripTrailingManifests keeps the field, and a thinking turn does not hide a manifest", () => {
    const manifest: ChatCompletionMessageParam = {
      role: "user",
      content: `${MANIFEST_CONTENT_PREFIX}\n- a.ts`,
    };
    const history = [
      { role: "user", content: "task" } as ChatCompletionMessageParam,
      assistantWithThinking("c1", "a.ts"),
      toolResult("c1", "ok"),
      manifest,
    ];

    const stripped = stripTrailingManifests(history);
    expect(stripped).toHaveLength(3); // the manifest was still identified
    expect(readProviderState(stripped[1])?.blocks[0]).toBe(BLOCK);
  });

  it("BudgetReductionProcessor truncates tool results without touching assistants", () => {
    const proc = new BudgetReductionProcessor({ kind: "budget_reduction", maxCharsPerToolResult: 100 });
    const history: ChatCompletionMessageParam[] = [
      assistantWithThinking("c1", "a.ts"),
      toolResult("c1", "y".repeat(5000)),
    ];
    const result = proc.process(history, {
      runId: "r1",
      iter: 0,
      emit: () => undefined,
    } as unknown as Parameters<typeof proc.process>[1]);

    expect(result.kind).toBe("transformed");
    const out = result.kind === "transformed" ? result.messages : history;
    expect(out[0]).toBe(history[0]); // identity, not a copy
    expect(readProviderState(out[0])?.blocks[0]).toBe(BLOCK);
  });
});

describe("envelope round trip", () => {
  it("survives JSON serialization byte-identically", () => {
    // RunEnvelope.messages is unknown[] and is written with JSON.stringify. The
    // field is plain data, so it crosses the process boundary intact — asserted
    // rather than assumed, because resume is where the benefit is largest.
    const history = [assistantWithThinking("c1", "a.ts"), toolResult("c1", "ok")];
    const restored = JSON.parse(JSON.stringify(history)) as unknown[];

    const state = readProviderState(restored[0]);
    expect(state?.model).toBe("claude-opus-5");
    expect(JSON.stringify(state?.blocks[0])).toBe(JSON.stringify(BLOCK));
    expect(state?.blocks[0]).not.toBe(BLOCK); // a real boundary crossing, not a shared reference
  });
});
