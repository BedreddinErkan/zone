import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { convertParams } from "../anthropicAdapter/convertParams.js";
import { hashCachedPrefix } from "../anthropicAdapter/cacheControlHelpers.js";
import { buildDefaultOrchestrator } from "./ContextOrchestrator.js";

/**
 * The default history pipeline must leave the cached prefix append-only.
 *
 * This is the property R.2 stale-read pruning violated. Evicting a read result
 * rewrites a message that Anthropic has already cached, invalidating the prefix
 * from that point: measured at 2.3x the cost of simply leaving it, because the
 * evicted tokens would have been read at 0.1x while the surviving prefix gets
 * re-written at 1.25x. The U.1 shim "fixed" that by discarding every elision,
 * so the subsystem produced byte-identical output to the raw history and its
 * `charsSaved` telemetry was phantom. Both are deleted.
 *
 * @unverified-probe(cache:real-run-prefix) Every case here is a synthetic
 * harness — one read_file per iteration, uniform sizes, no coaching injections,
 * no compaction, no subagent interleave. The mechanism is structural and holds
 * regardless, but the acceptance test for a deletion this size is one real
 * dogfood run with ZONE_DEBUG_CACHE_PROBE=1 showing [zone-cache-prefix-hash]
 * preserved across iterations. The probe computes locally; only API credit for
 * the run is missing.
 */

const MODEL = "claude-opus-5";
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
// Large enough that an eviction would have been worth thousands of chars.
const READ_RESULT = "export function f() { return 1; }\n".repeat(200);

function assistant(i: number): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: `c${i}`, type: "function", function: { name: "read_file", arguments: `{"filePath":"src/f${i}.ts"}` } },
    ],
  } as ChatCompletionMessageParam;
}

function toolResult(i: number): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: `c${i}`, content: READ_RESULT } as ChatCompletionMessageParam;
}

function markerIdx(messages: Anthropic.MessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const c = messages[i]!.content;
    if (Array.isArray(c) && c.some((b) => (b as { cache_control?: unknown }).cache_control)) return i;
  }
  return -1;
}

function toWire(messages: ChatCompletionMessageParam[]): Anthropic.MessageParam[] {
  return convertParams({
    model: MODEL,
    messages: [{ role: "system", content: SYSTEM }, ...messages],
    max_tokens: 1024,
    tools: TOOLS,
  }).params.messages;
}

describe("the default pipeline keeps the cached prefix append-only", () => {
  it("preserves every previously-cached prefix across 8 iterations", () => {
    const orchestrator = buildDefaultOrchestrator();
    const responseInput: ChatCompletionMessageParam[] = [
      { role: "user", content: "make the flush atomic" },
    ];

    let prev: { idx: number; hash: string } | null = null;

    for (let iter = 1; iter <= 8; iter += 1) {
      responseInput.push(assistant(iter), toolResult(iter));
      const assembled = orchestrator.assemble({
        responseInput,
        toolCallLog: [],
        iter: iter - 1,
        runId: "r1",
        emit: () => undefined,
      }).messages;

      const wire = toWire(assembled);
      const idx = markerIdx(wire);
      expect(idx).toBeGreaterThan(-1); // the marker is actually placed

      if (prev) {
        // The previously-cached prefix must still hash the same inside the new
        // request. This is the cache-hit condition, and it is exactly what
        // pruning broke.
        expect(hashCachedPrefix(wire, prev.idx)).toBe(prev.hash);
      }
      prev = { idx, hash: hashCachedPrefix(wire, idx) };
    }
  });

  it("the marker advances with the conversation rather than pinning to the task", () => {
    // The corrected model: translateMessages renders every role:"tool" as a
    // role:"user" carrying tool_result, so the marker lands on the last tool
    // result and moves forward. That is what puts the conversation inside the
    // cached prefix. If this stops holding, the economics above change.
    const shortHistory = [
      { role: "user", content: "task" } as ChatCompletionMessageParam,
      assistant(1),
      toolResult(1),
    ];
    const longHistory = [...shortHistory, assistant(2), toolResult(2)];

    const shortWire = toWire(shortHistory);
    const longWire = toWire(longHistory);

    expect(markerIdx(shortWire)).toBe(shortWire.length - 1);
    expect(markerIdx(longWire)).toBe(longWire.length - 1);
    expect(markerIdx(longWire)).toBeGreaterThan(markerIdx(shortWire));
  });

  it("no processor rewrites an already-sent message", () => {
    // The general form of the rule. A processor may append; it may not edit
    // history behind the marker.
    const orchestrator = buildDefaultOrchestrator();
    const responseInput: ChatCompletionMessageParam[] = [
      { role: "user", content: "task" },
    ];
    const snapshots: string[] = [];

    for (let iter = 1; iter <= 5; iter += 1) {
      responseInput.push(assistant(iter), toolResult(iter));
      const assembled = orchestrator.assemble({
        responseInput,
        toolCallLog: [],
        iter: iter - 1,
        runId: "r1",
        emit: () => undefined,
      }).messages;
      snapshots.push(JSON.stringify(assembled.slice(0, 1 + (iter - 1) * 2)));
    }

    // Every snapshot prefix must be a prefix of the next iteration's.
    for (let i = 1; i < snapshots.length; i += 1) {
      expect(snapshots[i]!.startsWith(snapshots[i - 1]!.slice(0, -1))).toBe(true);
    }
  });
});
