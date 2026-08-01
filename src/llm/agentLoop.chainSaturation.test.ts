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

  it("does NOT fire when multi_edit succeeded (ZONE_SATURATION_COUNT_MULTIEDIT default on)", async () => {
    // multi_edit (success=true, filesStaged non-empty) at iter 0 → counted as a successful
    // edit → hook suppressed. filesStaged mirrors what toolExecutor.ts's terminal return
    // actually sets for a real replacement — countsTowardChainSaturation() reads it, not
    // success alone.
    toolExecutorMock.executeTool.mockResolvedValueOnce({
      success: true,
      output: "multi_edit: 3 replacement(s) across 1 file(s).\n  src/a.ts: 3 replacement(s)",
      filesStaged: ["src/a.ts"],
    });
    mocks.createChatCompletion.mockResolvedValueOnce({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_me",
            type: "function",
            function: {
              name: "multi_edit",
              arguments: JSON.stringify({ files: ["src/a.ts"], find: "foo", replace: "bar" }),
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const FILES = ["src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    for (const f of FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    delete process.env["ZONE_SATURATION_COUNT_MULTIEDIT"];
    await runAgentLoop({ task: "rename all foos", repoPath, runId: "test-csat-9" });

    const logs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
    expect(logs.length).toBe(0);
  });

  it("DOES fire when ZONE_SATURATION_COUNT_MULTIEDIT=0 even with successful multi_edit", async () => {
    // env=0 restores apply_patch-only counting → multi_edit not counted → hook fires at iter 6
    toolExecutorMock.executeTool.mockResolvedValueOnce({
      success: true,
      output: "multi_edit: 3 replacement(s) across 1 file(s).\n  src/a.ts: 3 replacement(s)",
      filesStaged: ["src/a.ts"],
    });
    mocks.createChatCompletion.mockResolvedValueOnce({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_me2",
            type: "function",
            function: {
              name: "multi_edit",
              arguments: JSON.stringify({ files: ["src/a.ts"], find: "foo", replace: "bar" }),
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const FILES = ["src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    for (const f of FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    process.env["ZONE_SATURATION_COUNT_MULTIEDIT"] = "0";
    try {
      await runAgentLoop({ task: "rename all foos", repoPath, runId: "test-csat-10" });
    } finally {
      delete process.env["ZONE_SATURATION_COUNT_MULTIEDIT"];
    }

    const logs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
    expect(logs.length).toBe(1);
  });

  it("fires with zero-replacement multi_edit (success:true, 0 replacements — 2372 fix)", async () => {
    // multi_edit returns success:true even when totalReplacements===0 (toolExecutor.ts's
    // terminal return). A no-op multi_edit used to SUPPRESS the nudge — agentLoop.ts:2372's
    // documented defect. countsTowardChainSaturation() now reads filesStaged instead of
    // trusting success alone, so a zero-replacement call (filesStaged: []) does not count
    // and the nudge fires. filesStaged mirrors toolExecutor.ts's real terminal return, which
    // always sets it (possibly empty), never leaves it absent.
    toolExecutorMock.executeTool.mockResolvedValueOnce({
      success: true,
      output: "multi_edit: 0 replacement(s) across 1 file(s).\n  [NOT FOUND] src/a.ts",
      filesStaged: [],
    });
    mocks.createChatCompletion.mockResolvedValueOnce({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_me3",
            type: "function",
            function: {
              name: "multi_edit",
              arguments: JSON.stringify({ files: ["src/a.ts"], find: "nonexistent", replace: "bar" }),
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const FILES = ["src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    for (const f of FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());

    delete process.env["ZONE_SATURATION_COUNT_MULTIEDIT"];
    await runAgentLoop({ task: "rename all foos", repoPath, runId: "test-csat-11" });

    const logs = mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
    // fixed: a zero-replacement multi_edit no longer counts as a successful action
    expect(logs.length).toBe(1);
  });
});

/**
 * A dogfood run on a read-only trace task took this nudge at iteration 6:
 * "Apply a patch implementing your best current hypothesis." The guard below it
 * already excluded `investigation` — it was fed `refactor`, because the
 * classifier's tier field was unusable and the whole classification fell back.
 *
 * So the fix is not in the trigger. It is in what the guard is allowed to
 * believe about the run.
 */
describe("chain-saturation trusts the archetype only when there is one", () => {
  const SIX_FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];

  function classification(over: Record<string, unknown> = {}) {
    return {
      tier: "medium" as const,
      estimatedFiles: 5,
      estimatedIterations: 15,
      confidence: 0.9,
      classifierCostUsd: 0.003,
      classifierLatencyMs: 1700,
      classifierModel: "claude-haiku-4-5",
      archetype: "refactor" as const,
      archetypeConfidence: 0.85,
      ...over,
    };
  }

  function queueSixReads() {
    for (const f of SIX_FILES) {
      mocks.createChatCompletion.mockResolvedValueOnce(makeReadFileResponse(f));
    }
    mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
  }

  function warnings() {
    return mocks.log.mock.calls.filter(
      (c: unknown[]) => c[0] === "[zone-chain-saturation-warn]",
    );
  }

  it("stands down on a fallback classification — the dogfood shape", async () => {
    // Exactly what the failed run carried: tier forced to medium, confidence 0,
    // and `refactor` from ZONE_FALLBACK_ARCHETYPE rather than from the model.
    queueSixReads();

    await runAgentLoop({
      task: "trace how a tool result reaches the message history",
      repoPath,
      runId: "test-csat-fallback",
      taskClassification: classification({ confidence: 0, archetypeConfidence: 0, fallbackUsed: true }),
    });

    expect(warnings().length).toBe(0);
  });

  it("reads the archetype from taskClassification when no dispatcher pipeline applied", async () => {
    // `originalArchetype` is only populated when buildPipelineConfig returned a
    // pipeline (runLlmPatchFlow.ts:6010). Leaving it undefined used to blind the
    // guard completely; the classification is always threaded.
    queueSixReads();

    await runAgentLoop({
      task: "walk me through the compaction gates",
      repoPath,
      runId: "test-csat-classification-archetype",
      taskClassification: classification({ archetype: "investigation" }),
      // originalArchetype deliberately omitted
    });

    expect(warnings().length).toBe(0);
  });

  it("still fires on a confident patch classification", async () => {
    // The nudge keeps its job. Suppression is scoped to "we do not know what
    // this run is", not to "this run has not patched yet" — the latter is the
    // trigger condition, and gating on it would neuter the hook entirely.
    queueSixReads();

    await runAgentLoop({
      task: "rename createThing to buildThing across the repo",
      repoPath,
      runId: "test-csat-still-fires",
      taskClassification: classification(),
    });

    const logs = warnings();
    expect(logs.length).toBe(1);
    const payload = JSON.parse(logs[0][1] as string) as Record<string, unknown>;
    expect(payload.iter).toBe(6);
    // Telemetry reports the archetype the gate actually consulted.
    expect(payload.archetype).toBe("refactor");
  });
});
