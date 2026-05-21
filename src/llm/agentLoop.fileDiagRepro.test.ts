/**
 * Y.2.2 reproducer: apply_patch → filesModified + beforeByFile snapshot + fileDiffs.
 *
 * Hypothesis under test:
 *   2B — filesModified not populated (tracking doesn't fire)
 *   2A — beforeByFile not populated (onToolCall guard skips snapshot)
 *   2C — beforeByFile snapshot is stale (before === after → empty diff)
 *
 * Verdict: 2B and 2A ruled out by first two tests.
 * Test 3 covers 2C: confirms beforeByFile captures pre-patch content and
 * fileDiffs computation produces non-zero addedLines.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  recordRunSummary: vi.fn(),
  getUsage: vi.fn(),
  readDailyUsdCapOverride: vi.fn<() => number | undefined>(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => ({
  clearCommandCacheForRun: vi.fn(() => undefined),
  executeTool: mocks.executeTool,
  withStagingTempFlush: mocks.withStagingTempFlush,
}));

vi.mock("../usage/usageTracker.js", () => ({
  getUsage: mocks.getUsage,
  recordExecution: vi.fn(),
  readRecords: vi.fn(() => []),
  recordRunSummary: mocks.recordRunSummary,
  getRunCost: vi.fn(() => 0),
  recordRunSummarySync: vi.fn(),
}));

vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: mocks.readDailyUsdCapOverride,
  readTierSettings: vi.fn(() => ({})),
  readAutoAuditSetting: vi.fn(() => false),
  writeTierSettings: vi.fn(),
  writeAutoAuditSetting: vi.fn(),
  writeDailyUsdCapOverride: vi.fn(),
  getTierSettingsPath: vi.fn(() => "/tmp/tier-limits.json"),
}));

import { runAgentLoop } from "./agentLoop.js";

const FILE_REL = "test.ts";
const FILE_BEFORE = "const foo = 1;\n";
const FILE_AFTER = "// comment\nconst foo = 1;\n";

function makeReadFileResponse() {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "tc-read",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ filePath: FILE_REL, lineRange: null }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeApplyPatchResponse() {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: "tc-patch",
              type: "function",
              function: {
                name: "apply_patch",
                arguments: JSON.stringify({
                  filePath: FILE_REL,
                  patch: "--- FIND ---\nconst foo = 1;\n--- REPLACE ---\n// comment\nconst foo = 1;",
                  intent: "modify",
                  scope: null,
                }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeDoneResponse() {
  return {
    choices: [
      { message: { content: "[ZONE_VERIFICATION: tests_skipped_no_infra]", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-y22-repro-"));
  fs.writeFileSync(path.join(repoPath, FILE_REL), FILE_BEFORE, "utf8");

  mocks.createChatCompletion.mockReset();
  mocks.executeTool.mockReset();
  mocks.withStagingTempFlush.mockReset();
  mocks.recordRunSummary.mockReset();
  mocks.getUsage.mockReset();
  mocks.readDailyUsdCapOverride.mockReset();

  mocks.withStagingTempFlush.mockImplementation(async (fn: () => Promise<void>) => fn());
  mocks.recordRunSummary.mockResolvedValue(undefined);
  mocks.readDailyUsdCapOverride.mockReturnValue(0);
  mocks.getUsage.mockResolvedValue({
    period: "day" as const,
    totalRuns: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    byProvider: {},
    byModel: {},
  });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("Y.2.2 — apply_patch tracking pipeline", () => {
  it("filesModified is populated after a successful apply_patch (read → patch → done)", async () => {
    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeReadFileResponse();
      if (callCount === 2) return makeApplyPatchResponse();
      return makeDoneResponse();
    });

    mocks.executeTool.mockImplementation(async (toolName: string) => {
      if (toolName === "read_file") return { success: true, output: FILE_BEFORE };
      if (toolName === "apply_patch") return { success: true, output: "Patch applied." };
      return { success: true, output: "" };
    });

    const result = await runAgentLoop({
      task: "add a comment above foo",
      repoPath,
      userId: "user-1",
      runId: "test-run-y22",
      maxIterationsOverride: 5,
    });

    // Hypothesis 2B: filesModified must be populated.
    expect(result.filesModified).toContain(FILE_REL);
  });

  it("onToolCall fires for apply_patch before tool execution (beforeByFile snapshot)", async () => {
    const capturedOnToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeReadFileResponse();
      if (callCount === 2) return makeApplyPatchResponse();
      return makeDoneResponse();
    });

    mocks.executeTool.mockImplementation(async (toolName: string) => {
      if (toolName === "read_file") return { success: true, output: FILE_BEFORE };
      if (toolName === "apply_patch") return { success: true, output: "Patch applied." };
      return { success: true, output: "" };
    });

    await runAgentLoop({
      task: "add a comment above foo",
      repoPath,
      userId: "user-1",
      runId: "test-run-y22-callback",
      maxIterationsOverride: 5,
      onToolCall: (name, args) => {
        capturedOnToolCalls.push({ name, args });
      },
    });

    // Hypothesis 2A: onToolCall must fire for apply_patch (enabling beforeByFile snapshot).
    const patchCall = capturedOnToolCalls.find((c) => c.name === "apply_patch");
    expect(patchCall).toBeDefined();
    expect(patchCall?.args.filePath).toBe(FILE_REL);
  });

  it("beforeByFile captures pre-patch content; fileDiffs computation yields non-empty diff (hypothesis 2C)", async () => {
    // Simulates the runLlmPatchFlow beforeByFile → fileDiffs pipeline.
    // The mock executeTool writes FILE_AFTER to disk so the "after" read is patched content.
    // The onToolCall callback captures FILE_BEFORE as "before" BEFORE the write happens.
    const beforeByFile = new Map<string, string>();

    let callCount = 0;
    mocks.createChatCompletion.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) return makeReadFileResponse();
      if (callCount === 2) return makeApplyPatchResponse();
      return makeDoneResponse();
    });

    mocks.executeTool.mockImplementation(
      async (toolName: string, _args: unknown, repoPathArg: string) => {
        if (toolName === "read_file") return { success: true, output: FILE_BEFORE };
        if (toolName === "apply_patch") {
          // Write patched content to disk (simulates staging flush).
          fs.writeFileSync(path.join(repoPathArg, FILE_REL), FILE_AFTER, "utf8");
          return { success: true, output: "Patch applied." };
        }
        return { success: true, output: "" };
      }
    );

    const result = await runAgentLoop({
      task: "add a comment above foo",
      repoPath,
      userId: "user-1",
      runId: "test-run-y22-2c",
      maxIterationsOverride: 5,
      onToolCall: (name, args) => {
        // Mirror runLlmPatchFlow's onToolCall: snapshot disk content BEFORE tool runs.
        if ((name === "write_file" || name === "apply_patch") && typeof args.filePath === "string") {
          const rel = args.filePath;
          if (!beforeByFile.has(rel)) {
            const abs = path.join(repoPath, rel);
            const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
            beforeByFile.set(rel, before);
          }
        }
      },
    });

    expect(result.filesModified).toContain(FILE_REL);

    // Simulate runLlmPatchFlow's fileDiffs computation (lines 5970-5981).
    const fileDiffs = result.filesModified.map((rel) => {
      const abs = path.join(repoPath, rel);
      const before =
        beforeByFile.get(rel) ?? (fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "");
      const after = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
      const addedLines = after.split("\n").filter((l) => !before.split("\n").includes(l)).length;
      return { filePath: rel, before, after, addedLines };
    });

    // Hypothesis 2C assertion: beforeByFile captured FILE_BEFORE (pre-patch),
    // disk now has FILE_AFTER (post-patch), so diff must be non-empty.
    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0]!.before).toBe(FILE_BEFORE);
    expect(fileDiffs[0]!.after).toBe(FILE_AFTER);
    expect(fileDiffs[0]!.addedLines).toBeGreaterThan(0);
  });
});
