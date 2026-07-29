import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  saveRunEnvelope,
  loadRunEnvelope,
  _setEnvelopeDirForTest,
  type RunEnvelope,
} from "../api/diskRunEnvelope.js";
import { reconcileDanglingToolCalls } from "./agentLoop.js";
import { convertParams } from "./anthropicAdapter/convertParams.js";
import { ZONE_PROVIDER_FIELD, type ProviderThinkingBlock } from "./anthropicAdapter/thinkingBlocks.js";

/**
 * The park/resume round trip, end to end through disk.
 *
 * This is the case where the benefit is largest and the only one that exercises
 * the durable-suspend work and thinking passthrough together. A parked run
 * stopped MID-THOUGHT to ask the user something: its assistant turn carries both
 * the thinking that produced the question and the ask_user tool_use whose
 * tool_result is the answer. The answer only means anything against that
 * reasoning, and it is separated from it by a process boundary.
 */

const MODEL = "claude-opus-5";
const OTHER_MODEL = "claude-sonnet-5";
const SIGNATURE = "ErUBCkYIAxgCIkDx7f2vQ9k1mZ0nR8sT4uV6wX2yZ0aB3cD5eF7gH9iJ==";
const THINKING =
  "Two call sites could own the flush. Asking which the user means before I patch either.";
const ASK_CALL_ID = "call_ask_1";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-thinking-park-"));
  _setEnvelopeDirForTest(dir);
});

afterEach(() => {
  _setEnvelopeDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const THINKING_BLOCK: ProviderThinkingBlock = {
  type: "thinking",
  thinking: THINKING,
  signature: SIGNATURE,
};

/** The history as it stands at the moment the run parks on a question. */
function parkedHistory(model = MODEL): ChatCompletionMessageParam[] {
  return [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "make the flush atomic" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: ASK_CALL_ID,
          type: "function",
          function: {
            name: "ask_user",
            arguments: JSON.stringify({ question: "Which call site owns the flush?" }),
          },
        },
      ],
      [ZONE_PROVIDER_FIELD]: { blocks: [THINKING_BLOCK], model },
    },
  ] as unknown as ChatCompletionMessageParam[];
}

function envelopeFor(messages: unknown[]): RunEnvelope {
  return {
    version: 1,
    sessionId: "sess-park-thinking",
    runId: "run-park-thinking",
    pid: process.pid,
    repoPath: "/tmp/repo",
    model: MODEL,
    task: "make the flush atomic",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "awaiting_user_input",
    executionPlan: null,
    todos: [],
    failureHistory: [],
    staging: [],
    flushedPaths: [],
    priorSessionSummary: "",
    messages,
    pendingQuestion: {
      toolCallId: ASK_CALL_ID,
      question: "Which call site owns the flush?",
      iter: 1,
    },
  } as unknown as RunEnvelope;
}

/** Rebuild responseInput the way agentLoop's warm-resume branch does. */
function warmResume(restored: unknown[], answer: string): ChatCompletionMessageParam[] {
  const reconciled = reconcileDanglingToolCalls(restored, answer);
  return [
    { role: "system", content: "You are a coding agent." },
    ...(reconciled.slice(1) as ChatCompletionMessageParam[]),
  ];
}

function assistantContent(msgs: Anthropic.MessageParam[]): Anthropic.ContentBlockParam[] {
  const assistant = msgs.find((m) => m.role === "assistant");
  return Array.isArray(assistant?.content) ? (assistant.content as Anthropic.ContentBlockParam[]) : [];
}

describe("a parked question's thinking survives the process boundary", () => {
  it("replays byte-identically ahead of the ask_user tool_use, with the answer as its result", async () => {
    await saveRunEnvelope(envelopeFor(parkedHistory()), { dir });

    // A different process: nothing shared but the file.
    const restored = await loadRunEnvelope("run-park-thinking");
    expect(restored?.messages).toBeDefined();
    expect(restored?.messagesOmitted).toBeFalsy();

    const resumed = warmResume(restored!.messages!, "The second one — finalizeStaging.");
    const params = convertParams({ model: MODEL, messages: resumed, max_tokens: 1024 }).params;

    const blocks = assistantContent(params.messages);
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "tool_use"]);

    // Byte-identical after a real serialize/deserialize, not a shared reference.
    expect(JSON.stringify(blocks[0])).toBe(JSON.stringify(THINKING_BLOCK));

    // And the answer arrives as that call's result, not as UNANSWERED_ON_RESUME.
    const last = params.messages[params.messages.length - 1]!;
    expect(JSON.stringify(last)).toContain("The second one — finalizeStaging.");
    expect(JSON.stringify(last)).toContain(ASK_CALL_ID);
    expect(JSON.stringify(last)).not.toContain("No answer is available");
  });

  it("drops the thinking when the resume runs under a different model", async () => {
    await saveRunEnvelope(envelopeFor(parkedHistory()), { dir });
    const restored = await loadRunEnvelope("run-park-thinking");
    const resumed = warmResume(restored!.messages!, "The second one.");

    const params = convertParams({ model: OTHER_MODEL, messages: resumed, max_tokens: 1024 }).params;
    const blocks = assistantContent(params.messages);

    expect(blocks.map((b) => b.type)).toEqual(["tool_use"]);
    expect(JSON.stringify(params.messages)).not.toContain(SIGNATURE);
    // The question and its answer still round-trip — only the reasoning is lost.
    expect(JSON.stringify(params.messages)).toContain(ASK_CALL_ID);
  });

  it("the envelope's own model field is the signal a resume compares against", async () => {
    // envelope.model already existed; nothing new is persisted to detect the
    // boundary. Pinned so a schema change does not quietly remove the only
    // cross-process way to know which model signed the blocks.
    await saveRunEnvelope(envelopeFor(parkedHistory()), { dir });
    const restored = await loadRunEnvelope("run-park-thinking");
    expect(restored?.model).toBe(MODEL);

    const state = (restored!.messages![2] as Record<string, unknown>)[ZONE_PROVIDER_FIELD] as {
      model: string;
    };
    expect(state.model).toBe(restored?.model);
  });

  it("survives an envelope written before thinking capture existed", async () => {
    // Legacy envelopes have assistant turns with no passthrough field at all.
    // They must resume, just without reasoning.
    const legacy = parkedHistory().map((m) => {
      const copy = { ...(m as object) } as Record<string, unknown>;
      delete copy[ZONE_PROVIDER_FIELD];
      return copy;
    });
    await saveRunEnvelope(envelopeFor(legacy), { dir });

    const restored = await loadRunEnvelope("run-park-thinking");
    const resumed = warmResume(restored!.messages!, "The second one.");
    const params = convertParams({ model: MODEL, messages: resumed, max_tokens: 1024 }).params;

    expect(assistantContent(params.messages).map((b) => b.type)).toEqual(["tool_use"]);
  });
});
