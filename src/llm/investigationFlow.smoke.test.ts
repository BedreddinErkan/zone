/**
 * Phase D smoke test: the old /api/chat failure "no files use getRunCost"
 * must not recur in investigation mode.
 *
 * Strategy: mocked LLM (first response calls search_in_files, second emits
 * final markdown), real executeTool on a fixture repo containing getRunCost
 * in multiple files. Asserts tool was used, ≥3 file citations appear in the
 * response, and the failure message is absent.
 *
 * This is the L2 smoke regression for Phase D (memory #30 pattern:
 * mocked LLM + real tool execution against fixture data).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

// executeTool is NOT mocked — real search_in_files runs on the fixture repo.

import { runInvestigationFlow } from "./investigationFlow.js";

// ── fixture repo helpers ───────────────────────────────────────────────────────

let repoPath: string;

function writeFixture(relPath: string, content: string): void {
  const abs = path.join(repoPath, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-d-smoke-"));

  // Simulate the zone-api cost-tracking landscape in miniature.
  writeFixture(
    "src/usage/usageTracker.ts",
    [
      "export function getRunCost(userId: string, runId: string): number {",
      "  return 0;",
      "}",
      "export function recordExecution(userId: string, cost: number): void {}",
    ].join("\n")
  );
  writeFixture(
    "src/api/server.ts",
    [
      'import { getRunCost } from "../usage/usageTracker.js";',
      "// /api/chat handler",
      "const chatCostUsd = getRunCost(userId, runIdStr);",
      "// /api/patch handler",
      "const finalCostUsd = getRunCost(userId, runIdStr);",
      "// /api/investigate handler",
      "const costUsd = getRunCost(userId, runIdStr);",
    ].join("\n")
  );
  writeFixture(
    "src/core/runLlmPatchFlow.ts",
    [
      'import { getRunCost } from "../usage/usageTracker.js";',
      "export function buildCostSummary(userId: string, runId: string) {",
      "  return { totalUsd: getRunCost(userId, runId) };",
      "}",
    ].join("\n")
  );
  writeFixture(
    "src/ui/costDashboard.ts",
    [
      'import { getRunCost } from "../usage/usageTracker.js";',
      "export function renderCost(userId: string, runId: string) {",
      "  const cost = getRunCost(userId, runId);",
      '  return `$${cost.toFixed(4)}`;',
      "}",
    ].join("\n")
  );
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ── mocked LLM response sequence ──────────────────────────────────────────────

function searchToolResponse(pattern: string) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "tc-search-1",
              type: "function",
              function: {
                name: "search_in_files",
                arguments: JSON.stringify({ pattern, glob: "**/*.ts" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
  };
}

function finalAnswerResponse(answer: string) {
  return {
    choices: [
      {
        message: { content: answer, tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 },
  };
}

// ── smoke tests ───────────────────────────────────────────────────────────────

describe("smoke: getRunCost reference investigation (Phase D regression)", () => {
  it("agent uses search_in_files at least once (tool was called)", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(searchToolResponse("getRunCost"))
      .mockResolvedValueOnce(
        finalAnswerResponse(
          "## getRunCost References\n\n" +
          "- `src/usage/usageTracker.ts:1` — definition\n" +
          "- `src/api/server.ts:3` — called in chat handler\n" +
          "- `src/core/runLlmPatchFlow.ts:3` — called in patch flow\n" +
          "- `src/ui/costDashboard.ts:3` — called in UI"
        )
      );

    const result = await runInvestigationFlow({
      task: "which files reference getRunCost in this codebase?",
      repoPath,
    });

    const toolNames = result.toolCallLog.map((c) => c.tool);
    expect(toolNames).toContain("search_in_files");
  });

  it("response contains at least 3 distinct file: citations", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(searchToolResponse("getRunCost"))
      .mockResolvedValueOnce(
        finalAnswerResponse(
          "## References to getRunCost\n\n" +
          "- `src/usage/usageTracker.ts:1` — exported definition\n" +
          "- `src/api/server.ts:3` — chat cost attribution\n" +
          "- `src/core/runLlmPatchFlow.ts:3` — patch flow cost\n" +
          "- `src/ui/costDashboard.ts:3` — UI display"
        )
      );

    const result = await runInvestigationFlow({
      task: "which files reference getRunCost?",
      repoPath,
    });

    const citations = (result.chatResponse.match(/`[^`]+\.ts[^`]*`/g) ?? []);
    const distinctFiles = new Set(citations.map((c) => c.replace(/:\d+`$/, "`")));
    expect(distinctFiles.size).toBeGreaterThanOrEqual(3);
  });

  it("response is NOT the old chat-mode failure message", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(searchToolResponse("getRunCost"))
      .mockResolvedValueOnce(
        finalAnswerResponse(
          "## getRunCost\n\n`getRunCost` is defined in `src/usage/usageTracker.ts:1` " +
          "and called in `src/api/server.ts`, `src/core/runLlmPatchFlow.ts`, and `src/ui/costDashboard.ts`."
        )
      );

    const result = await runInvestigationFlow({
      task: "which files reference getRunCost?",
      repoPath,
    });

    expect(result.chatResponse).not.toMatch(/no files use getRunCost/i);
    expect(result.chatResponse).not.toMatch(/could not find any.*getRunCost/i);
  });

  it("toolCallLog is non-empty (agent explored before answering)", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(searchToolResponse("getRunCost"))
      .mockResolvedValueOnce(
        finalAnswerResponse("Found getRunCost in `src/usage/usageTracker.ts:1`, `src/api/server.ts:3`, `src/core/runLlmPatchFlow.ts:3`.")
      );

    const result = await runInvestigationFlow({
      task: "find getRunCost usages",
      repoPath,
    });

    expect(result.toolCallLog.length).toBeGreaterThanOrEqual(1);
  });

  it("decisionMode is 'investigation' and applyPatches is empty (read-only contract)", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(searchToolResponse("getRunCost"))
      .mockResolvedValueOnce(
        finalAnswerResponse("Found getRunCost in `src/usage/usageTracker.ts:1` and `src/api/server.ts:3` and `src/core/runLlmPatchFlow.ts:3`.")
      );

    const result = await runInvestigationFlow({
      task: "find getRunCost",
      repoPath,
    });

    expect(result.decisionMode).toBe("investigation");
    expect(result.applyPatches).toEqual([]);
    expect(result.fileDiffs).toEqual([]);
  });
});
