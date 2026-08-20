/**
 * No test anywhere in the repo drove a raw provider response through the real agentLoop.ts
 * emitter and asserted a `type:"thinking"` structured event actually fires — confirmed by a
 * whole-test-tree grep for the thinking/reasoningText shape, not a hand-picked sample. The
 * commit that built the Anthropic-side forwarder (2abc9dac) claims this was checked with
 * "three synthetic extended-thinking samples run through the real, unmocked...chain," but no
 * such automated test exists in the repository — it was a one-off manual check.
 *
 * Deliberately not OpenAI-specific: the mocked `createChatCompletion` bypasses both real
 * converters, so the gate tests below (positive/negative) exercise agentLoop.ts's own emitter
 * logic only, identically for either provider. The instrument that actually proves the OpenAI
 * seam works is the third describe block, which drives a REAL captured OpenAI response through
 * the REAL responsesConvertResponse — not a hand-built `{reasoningText: "..."}` literal. A
 * hand-rolled literal only proves "if the converter emits this shape, narration fires"; it does
 * not prove the converter emits it. That is the same gap a hand-rolled chalk.hex(...) assertion
 * left open for the banner defect, caught only once the real Ink-rendered frame replaced it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

const toolExecutorMock = vi.hoisted(() => ({
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  clearCommandCacheForRun: vi.fn(),
  clearCommandCacheForTest: vi.fn(),
  clearOutlineCacheForTest: vi.fn(),
  isMemoizableCommand: vi.fn(),
  computeCommandFingerprint: vi.fn(),
  truncateCommandOutput: vi.fn(),
  resolveAgentPath: vi.fn(),
  resolveRunCommandCwd: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

import { runAgentLoop } from "./agentLoop.js";
import { responsesConvertResponse } from "./openaiAdapter/responsesConvertResponse.js";
import type { Response as OpenAIResponse } from "openai/resources/responses/responses.js";

function makeReadFileToolCallResponse(reasoningText: string) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "tc-1",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ filePath: "config.json" }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    reasoningText,
    usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
  };
}

function makeDoneResponse(text: string) {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

let repoPath: string;
const structuredEvents: unknown[] = [];
const onStructuredEvent = (evt: unknown): void => {
  structuredEvents.push(evt);
};

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-reasoning-narration-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  structuredEvents.length = 0;
  toolExecutorMock.executeTool.mockImplementation(async () => ({
    success: true,
    output: "{}",
  }));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("agentLoop.ts thinking-event emitter — the gate itself, provider-agnostic", () => {
  it("investigation mode + real tool calls + a live runId → onStructuredEvent receives type:'thinking'", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return makeReadFileToolCallResponse("Checking config.json first.");
      return makeDoneResponse("The value is 42.");
    });

    await runAgentLoop({
      task: "read config.json and report the value",
      repoPath,
      runId: "test-run-1",
      mode: "investigation",
      allowToolRequest: true,
      capabilityFilter: { allowToolNames: new Set(["read_file"]) },
      maxIterationsOverride: 4,
      onStructuredEvent,
    });

    const thinking = structuredEvents.find(
      (e) => (e as { type?: string }).type === "thinking"
    ) as { type: string; text: string } | undefined;
    expect(thinking).toBeDefined();
    expect(thinking!.text).toBe("Checking config.json first.");
  });

  it("no runId → the same reasoningText never produces a thinking event", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return makeReadFileToolCallResponse("Checking config.json first.");
      return makeDoneResponse("The value is 42.");
    });

    await runAgentLoop({
      task: "read config.json and report the value",
      repoPath,
      // runId deliberately omitted — the gate in agentLoop.ts requires
      // `typeof input.runId === "string" && input.runId.trim()`.
      mode: "investigation",
      allowToolRequest: true,
      capabilityFilter: { allowToolNames: new Set(["read_file"]) },
      maxIterationsOverride: 4,
      onStructuredEvent,
    });

    const thinking = structuredEvents.find((e) => (e as { type?: string }).type === "thinking");
    expect(thinking).toBeUndefined();
  });
});

describe("agentLoop.ts thinking-event emitter — driven by a REAL captured OpenAI response through the REAL converter", () => {
  it("a real gpt-5.5 response (reasoning + function_call), converted by the real responsesConvertResponse, produces a thinking event with the real summary text", async () => {
    // Captured live 2026-08-20 against gpt-5.5 (the dominant model in the recorded usage data,
    // not just gpt-5.4-mini), with Zone's own request shape: reasoning:{effort:"high",
    // summary:"auto"}. Cost: 87 input + 51 output tokens ≈ $0.002. encrypted_content is
    // truncated (its value is never asserted, only its presence) — everything else, including
    // the summary text, is verbatim from the real response.
    const realResponse = {
      id: "resp_0a4a5dabf328aae8016a873047765487d1a5d5e8f5701f614a",
      object: "response",
      created_at: 1787244615,
      status: "completed",
      error: null,
      incomplete_details: null,
      model: "gpt-5.5-2026-04-23",
      output: [
        {
          id: "rs_0a4a5dabf328aae8016a873048f32487d1b130d32bfb870144",
          type: "reasoning",
          content: [],
          encrypted_content: "gAAAAABqhzBLQQDW-2InDZjEG-xhVvlPVRLdBZyi...TRUNCATED_REAL_CAPTURE",
          summary: [
            {
              type: "summary_text",
              text:
                "**Checking for user requests**\n\nI see the user is asking for something specific. " +
                "I need to check the contents of the file 'config.json' before providing an answer. " +
                "It looks like I'll be using the read_file tool to access that. It’s important I " +
                "ensure I'm looking at the right document before responding. I'll definitely make " +
                "sure to do that, so I provide the most accurate information!",
            },
          ],
        },
        {
          id: "fc_0a4a5dabf328aae8016a87304ad02c87d1aaadcb86f7f1e4ff",
          type: "function_call",
          status: "completed",
          arguments: '{"path":"config.json"}',
          call_id: "call_DqD8rfOZzWlwkhoHdYCa6D7Q",
          name: "read_file",
        },
      ],
      usage: {
        input_tokens: 87,
        output_tokens: 51,
        total_tokens: 138,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 30 },
      },
    } as unknown as OpenAIResponse;

    // Fixture guard, before anything reaches agentLoop.ts. Deliberately written so that an
    // emptied fixture fails as a readable ASSERTION rather than a TypeError from indexing
    // summary[0] — confirmed by mutation: emptying the array first produced
    // "Cannot read properties of undefined", which kills the test but says nothing about why.
    const fixtureSummaries = (realResponse.output[0] as { summary?: { text: string }[] }).summary ?? [];
    expect(
      fixtureSummaries.length,
      "fixture must carry at least one summary part — with none, this test would pass vacuously " +
        "for a converter that extracts nothing"
    ).toBeGreaterThan(0);
    const expectedText = fixtureSummaries.map((s) => s.text).join("\n\n").trim();
    expect(expectedText.length, "fixture summary text must be non-empty").toBeGreaterThan(0);

    const convertedFirstCall = responsesConvertResponse(realResponse);
    // The real converter really did extract that text from this real response.
    expect(convertedFirstCall.reasoningText).toBe(expectedText);

    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return convertedFirstCall;
      return makeDoneResponse("config.json contains the expected value.");
    });

    await runAgentLoop({
      task: "read config.json and report the value",
      repoPath,
      runId: "test-run-real-fixture",
      mode: "investigation",
      allowToolRequest: true,
      capabilityFilter: { allowToolNames: new Set(["read_file"]) },
      maxIterationsOverride: 4,
      onStructuredEvent,
    });

    const thinking = structuredEvents.find(
      (e) => (e as { type?: string }).type === "thinking"
    ) as { type: string; text: string } | undefined;
    expect(thinking).toBeDefined();
    expect(thinking!.text).toBe(expectedText);
  });
});
