/**
 * Ledger item 7: the durable-resume checkpoint gate must read the current tool call's own
 * `result.success`, not the iteration-wide `toolEventCtx.failureDetected` flag — a failing call
 * earlier in the same iteration must not silence the checkpoint for a later, successful
 * apply_patch/write_file/multi_edit call. Same mock shape as agentLoop.resume.test.ts, reused
 * directly: the LLM adapter and toolExecutor.js are fully mocked; diskRunEnvelope.js is
 * partially mocked so saveRunEnvelope captures exactly what the (real) coalescing writer would
 * have persisted, with no real I/O and no race against stampEnvelopeStatus.
 *
 * Every test uses maxIterationsOverride: 1 so the only possible checkpoint triggers in a run are
 * the unconditional per-iteration checkpoint (fires once, before any tool call in that one
 * iteration runs) and the gate under test (fires 0-N times depending on write-tool outcomes) —
 * there is no second iteration for the per-iteration trigger to fire again in, and no TodoWrite
 * call in any sequence below to fire its own unconditional checkpoint.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

// ── Mocks (all hoisted before module imports) ────────────────────────────────

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

const adapterMocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

const envelopeMocks = vi.hoisted(() => ({
  saveRunEnvelope: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  stampEnvelopeStatus: vi.fn().mockResolvedValue(undefined),
  deleteRunEnvelope: vi.fn().mockResolvedValue(undefined),
  loadRunEnvelope: vi.fn().mockResolvedValue(null),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: adapterMocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("../api/diskRunEnvelope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/diskRunEnvelope.js")>();
  return {
    ...actual,
    saveRunEnvelope: envelopeMocks.saveRunEnvelope,
    stampEnvelopeStatus: envelopeMocks.stampEnvelopeStatus,
    deleteRunEnvelope: envelopeMocks.deleteRunEnvelope,
    loadRunEnvelope: envelopeMocks.loadRunEnvelope,
  };
});

import { runAgentLoop } from "./agentLoop.js";

// ── Response builders ────────────────────────────────────────────────────────

type CallSpec = { id: string; name: string; args: Record<string, unknown> };

function makeToolCallResponse(calls: CallSpec[]) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function makeDoneResponse(text = "[ZONE_VERIFICATION: tests_inconclusive] Done.") {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// ── Shared setup ─────────────────────────────────────────────────────────────

const SESSION_ID = "checkpoint-gate-test-session";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-checkpoint-gate-"));
  resetToolExecutorMock(toolExecutorMock);
  adapterMocks.createChatCompletion.mockReset();
  envelopeMocks.saveRunEnvelope.mockReset().mockResolvedValue(undefined);
  envelopeMocks.stampEnvelopeStatus.mockReset().mockResolvedValue(undefined);
  envelopeMocks.deleteRunEnvelope.mockReset().mockResolvedValue(undefined);
  envelopeMocks.loadRunEnvelope.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ── Observation helpers ──────────────────────────────────────────────────────

type RunningSnapshot = {
  status?: string;
  failureHistory?: Array<{ path: string; records: unknown[] }>;
  staging?: Array<{ path: string; content: string }>;
};

function runningSnapshots(): RunningSnapshot[] {
  return (envelopeMocks.saveRunEnvelope.mock.calls as unknown[][])
    .map((args) => args[0] as RunningSnapshot)
    .filter((env) => env.status === "running");
}

function hasFailureFor(snapshot: RunningSnapshot, filePath: string): boolean {
  return (snapshot.failureHistory ?? []).some((f) => f.path === filePath);
}

function hasStagedFor(snapshot: RunningSnapshot, filePath: string): boolean {
  return (snapshot.staging ?? []).some((s) => s.path === filePath);
}

async function runOneIteration(calls: CallSpec[]): Promise<void> {
  adapterMocks.createChatCompletion
    .mockResolvedValueOnce(calls.length > 0 ? makeToolCallResponse(calls) : makeDoneResponse())
    .mockResolvedValue(makeDoneResponse());
  await runAgentLoop({
    task: "checkpoint gate test",
    repoPath,
    sessionId: SESSION_ID,
    maxIterationsOverride: 1,
  });
}

describe("checkpoint gate: reads the current call's result, not the iteration flag", () => {
  it("T1: a failing apply_patch followed by a successful one in the same iteration — the checkpoint fires for the second", async () => {
    toolExecutorMock.executeTool.mockImplementation(
      async (
        name: string,
        args: Record<string, unknown>,
        toolRepoPath: string,
        _onProgress: unknown,
        opts: { stagingFiles?: Map<string, string> },
      ) => {
        if (name === "apply_patch" && args.filePath === "fail.ts") {
          return { success: false, output: "Block 1: FIND content not found" };
        }
        if (name === "apply_patch" && args.filePath === "ok.ts") {
          opts.stagingFiles?.set(path.join(toolRepoPath, "ok.ts"), "staged content");
          return { success: true, output: "Patch staged: 1 block(s) in ok.ts" };
        }
        return { success: true, output: "" };
      },
    );

    await runOneIteration([
      // apply_patch requires the target already read_file'd this run (agentLoop.ts's own
      // read-before-patch pre-check) — without this, both calls below would be intercepted by
      // that check before ever reaching the mocked executeTool.
      { id: "r1", name: "read_file", args: { filePath: "fail.ts" } },
      { id: "r2", name: "read_file", args: { filePath: "ok.ts" } },
      { id: "c1", name: "apply_patch", args: { filePath: "fail.ts", patch: "--- FIND ---\nx\n--- REPLACE ---\ny", intent: "modify", scope: null } },
      { id: "c2", name: "apply_patch", args: { filePath: "ok.ts", patch: "--- FIND ---\na\n--- REPLACE ---\nb", intent: "modify", scope: null } },
    ]);

    const snapshots = runningSnapshots();
    const target = snapshots.find((s) => hasFailureFor(s, "fail.ts"));
    // Target assertion, first and alone: a snapshot exists reflecting state after the first
    // (failing) call — impossible under the old gate, since the only trigger before the fix
    // fires at the top of the iteration, before either call has run.
    expect(target).toBeDefined();
    // Second assertion (C2): that same snapshot also reflects state only obtainable after the
    // SECOND (successful) call — not just "sometime after the first call's failure."
    expect(hasStagedFor(target!, "ok.ts")).toBe(true);
  });

  it("T2: a single successful apply_patch still checkpoints (regression lock)", async () => {
    toolExecutorMock.executeTool.mockImplementation(async () => ({ success: true, output: "ok" }));
    await runOneIteration([
      { id: "r1", name: "read_file", args: { filePath: "ok.ts" } },
      { id: "c1", name: "apply_patch", args: { filePath: "ok.ts", patch: "--- FIND ---\na\n--- REPLACE ---\nb", intent: "modify", scope: null } },
    ]);
    const successCount = runningSnapshots().length;

    envelopeMocks.saveRunEnvelope.mockClear();
    await runOneIteration([]);
    const controlCount = runningSnapshots().length;

    expect(successCount).toBeGreaterThan(controlCount);
  });

  it("T3: a lone failing apply_patch checkpoints nothing extra (correct half of old behavior, preserved)", async () => {
    // read_file must succeed even though the later apply_patch will fail — only the
    // apply_patch's own result should matter to the gate.
    toolExecutorMock.executeTool.mockImplementation(async (name: string) =>
      name === "read_file" ? { success: true, output: "content" } : { success: false, output: "fail" },
    );
    await runOneIteration([
      { id: "r1", name: "read_file", args: { filePath: "fail.ts" } },
      { id: "c1", name: "apply_patch", args: { filePath: "fail.ts", patch: "--- FIND ---\na\n--- REPLACE ---\nb", intent: "modify", scope: null } },
    ]);
    const failureOnlyCount = runningSnapshots().length;

    envelopeMocks.saveRunEnvelope.mockClear();
    await runOneIteration([]);
    const controlCount = runningSnapshots().length;

    expect(failureOnlyCount).toBe(controlCount);
  });

  it("T4: a successful non-write tool does not checkpoint (the tool-name gate still applies)", async () => {
    toolExecutorMock.executeTool.mockImplementation(async () => ({ success: true, output: "file content" }));
    await runOneIteration([
      { id: "c1", name: "read_file", args: { filePath: "a.ts" } },
    ]);
    const readOnlyCount = runningSnapshots().length;

    envelopeMocks.saveRunEnvelope.mockClear();
    await runOneIteration([]);
    const controlCount = runningSnapshots().length;

    expect(readOnlyCount).toBe(controlCount);
  });

  it("T5: a read-before-patch reject followed by a successful write in the same iteration — the checkpoint fires for the write", async () => {
    toolExecutorMock.executeTool.mockImplementation(
      async (
        name: string,
        args: Record<string, unknown>,
        toolRepoPath: string,
        _onProgress: unknown,
        opts: { stagingFiles?: Map<string, string> },
      ) => {
        if (name === "read_file" && args.filePath === "a.ts") {
          return { success: true, output: "// a.ts content" };
        }
        if (name === "apply_patch" && args.filePath === "a.ts") {
          opts.stagingFiles?.set(path.join(toolRepoPath, "a.ts"), "staged content");
          return { success: true, output: "Patch staged: 1 block(s) in a.ts" };
        }
        // apply_patch on b.ts must never reach here — it should be rejected inside agentLoop's
        // own read-before-patch check before executeTool is ever called for that call.
        return { success: true, output: "" };
      },
    );

    await runOneIteration([
      { id: "c1", name: "read_file", args: { filePath: "a.ts" } },
      { id: "c2", name: "apply_patch", args: { filePath: "b.ts", patch: "--- FIND ---\nx\n--- REPLACE ---\ny", intent: "modify", scope: null } },
      { id: "c3", name: "apply_patch", args: { filePath: "a.ts", patch: "--- FIND ---\na\n--- REPLACE ---\nc", intent: "modify", scope: null } },
    ]);

    const snapshots = runningSnapshots();
    const target = snapshots.find((s) => hasFailureFor(s, "b.ts"));
    // Target assertion, first and alone: a snapshot exists reflecting state after the
    // read-before-patch rejection of b.ts.
    expect(target).toBeDefined();
    // Second assertion (C2): that same snapshot also reflects state after the THIRD call
    // (the successful apply_patch on a.ts) — not just "sometime after b.ts was rejected."
    expect(hasStagedFor(target!, "a.ts")).toBe(true);
  });
});
