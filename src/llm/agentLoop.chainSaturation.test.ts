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
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

import { runAgentLoop } from "./agentLoop.js";

function makeDoneResponse() {
  return {
    choices: [
      { message: { content: "Done.", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeReadFileResponse(filePath: string) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: `call_rf_${filePath.replace(/\W/g, "_")}`,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ filePath }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeApplyPatchResponse() {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: "call_ap",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({
              patch: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
            }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-chain-saturation-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
  mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("CE.4.1.b: chain-saturation pre-iter hook", () => {
  it("fires at iter=6 with 0 successful patches, emits [zone-chain-saturation-warn] with iter=6", async () => {
    // 6 distinct read_file calls (iters 0-5), hook fires at start of iter 6, Done returned
    const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    for (const f of FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    await runAgentLoop({ task: "refactor everything", repoPath, runId: "test-csat-1" });

    const logs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
    expect(logs.length).toBe(1);
    const payload = JSON.parse(logs[0][1] as string) as Record<string, unknown>;
    expect(payload.iter).toBe(6);
  });

  it("does NOT fire at iter=5 — threshold is iter>=6", async () => {
    // 5 distinct read_file calls (iters 0-4), Done at iter 5; hook never reaches ctx.iter=6
    const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
    for (const f of FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    await runAgentLoop({
      task: "refactor everything",
      repoPath,
      runId: "test-csat-2",
      maxIterationsOverride: 6,
    });

    const logs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
    expect(logs.length).toBe(0);
  });

  it("does NOT fire when there is 1 successful apply_patch before iter 6", async () => {
    // apply_patch (success=true) at iter 0 → toolCallLog has entry with success:true
    // hook shouldRun: filter count === 1, not 0 → condition false, hook silent
    mocks.createChatCompletion.mockResolvedValueOnce(makeApplyPatchResponse());
    const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
    for (const f of FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    await runAgentLoop({ task: "refactor everything", repoPath, runId: "test-csat-3" });

    const logs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
    expect(logs.length).toBe(0);
  });

  it("scope guard: does NOT fire when originalArchetype is 'question'", async () => {
    // Hook condition includes: input.originalArchetype !== "question"
    // With originalArchetype:"question" the archetype guard short-circuits to false
    const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    for (const f of FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    await runAgentLoop({
      task: "list all files in src/",
      repoPath,
      runId: "test-csat-4",
      originalArchetype: "question",
    });

    const logs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
    expect(logs.length).toBe(0);
  });

  it("scope guard: does NOT fire when originalArchetype is 'investigation'", async () => {
    // Hook condition includes: input.originalArchetype !== "investigation"
    // With originalArchetype:"investigation" the archetype guard short-circuits to false
    const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    for (const f of FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    await runAgentLoop({
      task: "investigate the codebase",
      repoPath,
      runId: "test-csat-5",
      originalArchetype: "investigation",
    });

    const logs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
    expect(logs.length).toBe(0);
  });

  it("re-fire suppression: fires exactly once even across 9 iterations", async () => {
    // 8 distinct read_file calls (iters 0-7), hook fires at iter 6,
    // chainSaturationWarnInjected=true suppresses re-fire at iters 7-8, Done at iter 8
    const FILES = [
      "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts",
      "src/e.ts", "src/f.ts", "src/g.ts", "src/h.ts",
    ];
    for (const f of FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    await runAgentLoop({ task: "refactor everything", repoPath, runId: "test-csat-6" });

    const logs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
    expect(logs.length).toBe(1);
  });

  it("coaching text contains required ZONE_CHAIN_SATURATION phrases", async () => {
    const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    for (const f of FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    await runAgentLoop({ task: "refactor everything", repoPath, runId: "test-csat-7" });

    const logs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
    expect(logs.length).toBe(1);
    const payload = JSON.parse(logs[0][1] as string) as Record<string, unknown>;
    const content = payload.content as string;
    expect(content).toContain("ZONE_CHAIN_SATURATION");
    expect(content).toContain("You should now either");
    expect(content).toContain("Do NOT continue investigating without committing");
  });

  it("failed apply_patch does NOT count — hook fires when only failed patches exist", async () => {
    // apply_patch returns success:false at iter 0 → toolCallLog has entry with success:false
    // filter on success:true returns count 0 → hook fires at iter 6
    toolExecutorMock.executeTool.mockResolvedValueOnce({
      success: false,
      output: "APPLY_ROLLED_BACK\nError: patch did not apply cleanly",
    });
    mocks.createChatCompletion.mockResolvedValueOnce(makeApplyPatchResponse());
    const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
    for (const f of FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    await runAgentLoop({ task: "fix a bug", repoPath, runId: "test-csat-8" });

    const logs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
    expect(logs.length).toBe(1);
  });
});
