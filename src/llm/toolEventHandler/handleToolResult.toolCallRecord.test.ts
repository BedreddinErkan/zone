import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("../subagentDispatch.js", () => ({
  handleSubagentResult: vi.fn().mockReturnValue({ subagentTokenDelta: 0, subagentCostDelta: 0 }),
  logSubagentDispatched: vi.fn(),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleToolResult } from "./handleToolResult.js";
import type { ToolEventContext, HandleToolResultDeps } from "./types.js";
import { _setToolCallSinkPathForTest, TOOL_CALL_RECORD_NAME } from "../../utils/toolCallSink.js";
import { _resetToolCallHealthForTest, readToolCallHealth } from "../toolCallRecord.js";

/**
 * L2 — the PRODUCTION seam, not the recorder in isolation.
 *
 * `toolCallRecord.test.ts` proves the recorder writes what it is handed. This
 * file proves the thing that actually matters: that the one production path
 * every executed tool takes reaches it, carrying the fields only that path has
 * (`ToolResult.rejectionReason`, `ToolResult.error`). Writes go through the
 * REAL sink writer into a temp path — no mock of the thing under test.
 */

let sinkPath: string;
let repoPath: string;
let savedVerbose: string | undefined;

function readRecords(): Array<Record<string, unknown>> {
  if (!fs.existsSync(sinkPath)) return [];
  return fs.readFileSync(sinkPath, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function makeCtx(): ToolEventContext {
  return {
    toolCallLog: [], filesModified: new Set(), filesReadThisRun: new Set(),
    filesReadCountThisRun: new Map(), failureHistory: new Map(), responseInput: [],
    failedFilesThisIter: new Set(), failureDetected: false, failedToolName: "",
    failedToolOutput: "", failedToolError: "", failedToolFilePath: null,
    rollbackCount: 0, lastLoopResult: null, consecutiveScopeBlocks: 0,
    recentVerifyKeySets: [], noProgressBaselines: { tsc: null, test: null },
  } as unknown as ToolEventContext;
}

function makeDeps(): HandleToolResultDeps {
  return {
    budget: {
      recordSubagentResult: vi.fn().mockReturnValue({ ratio: 0.1 }),
      recordSubagentCostOnly: vi.fn(),
    } as never,
    iter: 2,
    runId: "run-L2",
    sessionId: "sess-L2",
    effectiveTokenBudgetCap: 100_000,
    tokenBudgetHardThreshold: 0.95,
    detectorState: { window: [] } as never,
    throwIfAborted: vi.fn(),
    onStructuredEvent: vi.fn(),
    onToolResult: vi.fn(),
    synthesizeTokenBudgetExit: vi.fn(),
    synthesizeLoopDetectedExit: vi.fn(),
    synthesizeScopeBlockExit: vi.fn(),
    classifyFailure: vi.fn().mockReturnValue("generic_failure"),
    extractSemanticSmellName: vi.fn().mockReturnValue("unknown"),
    extractErrorLine: vi.fn().mockReturnValue(null),
    hashPatchBlocks: vi.fn().mockReturnValue("h"),
    hashToolCall: vi.fn().mockReturnValue("h"),
    recordAndDetect: vi.fn().mockReturnValue({ status: "ok", count: 1 }),
    repoPath,
  } as unknown as HandleToolResultDeps;
}

beforeEach(() => {
  savedVerbose = process.env.ZONE_VERBOSE_LOGS;
  delete process.env.ZONE_VERBOSE_LOGS;
  sinkPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zone-l2-sink-")), "tool-calls.jsonl");
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-l2-repo-"));
  _setToolCallSinkPathForTest(sinkPath);
  _resetToolCallHealthForTest();
});

afterEach(() => {
  _setToolCallSinkPathForTest(null);
  _resetToolCallHealthForTest();
  if (savedVerbose === undefined) delete process.env.ZONE_VERBOSE_LOGS;
  else process.env.ZONE_VERBOSE_LOGS = savedVerbose;
  vi.restoreAllMocks();
});

describe("handleToolResult → durable tool-call record (production seam)", () => {
  it("a successful read_file lands one record with an absolute path, env unset", async () => {
    const ctx = makeCtx();
    await handleToolResult(
      "read_file", { filePath: "src/a.ts" }, "c1",
      { output: "contents", success: true }, ctx, makeDeps(),
    );
    const recs = readRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.name).toBe(TOOL_CALL_RECORD_NAME);
    expect(recs[0]!.tool).toBe("read_file");
    expect(recs[0]!.outcome).toBe("ok");
    expect(recs[0]!.paths).toEqual([path.resolve(repoPath, "src/a.ts")]);
    expect(recs[0]!.runId).toBe("run-L2");
    expect(recs[0]!.iteration).toBe(2);
  });

  it("an apply_patch REJECTION carries its structured rejectionReason through the seam", async () => {
    const ctx = makeCtx();
    await handleToolResult(
      "apply_patch", { filePath: "src/a.ts", patch: "x" }, "c2",
      {
        output: "Block 1: FIND text not found",
        success: false,
        error: "apply_patch_find_not_found",
        rejectionReason: "find_not_found",
      },
      ctx, makeDeps(),
    );
    const rec = readRecords()[0]!;
    expect(rec.outcome).toBe("rejected");
    expect(rec.reason).toBe("find_not_found");
    expect(rec.paths).toEqual([path.resolve(repoPath, "src/a.ts")]);
  });

  it("a failure with only an error code records outcome 'error' carrying that code", async () => {
    const ctx = makeCtx();
    await handleToolResult(
      "write_file", { filePath: "src/b.ts", content: "x" }, "c3",
      { output: "blocked", success: false, error: "write_file_blocked_out_of_plan_scope" },
      ctx, makeDeps(),
    );
    const rec = readRecords()[0]!;
    expect(rec.outcome).toBe("error");
    expect(rec.reason).toBe("write_file_blocked_out_of_plan_scope");
  });

  it("a shell call records its command and an empty paths array", async () => {
    const ctx = makeCtx();
    await handleToolResult(
      "run_command", { command: "npm test" }, "c4",
      { output: "ok", success: true, exitCode: 0 }, ctx, makeDeps(),
    );
    const rec = readRecords()[0]!;
    expect(rec.command).toBe("npm test");
    expect(rec.paths).toEqual([]);
  });

  it("several calls in one run are recorded in order with monotonic seq, and health matches", async () => {
    const ctx = makeCtx();
    const deps = makeDeps();
    await handleToolResult("read_file", { filePath: "a.ts" }, "c1", { output: "x", success: true }, ctx, deps);
    await handleToolResult("run_command", { command: "ls" }, "c2", { output: "x", success: true }, ctx, deps);
    await handleToolResult(
      "apply_patch", { filePath: "a.ts" }, "c3",
      { output: "no", success: false, rejectionReason: "find_block_empty" }, ctx, deps,
    );
    const recs = readRecords();
    expect(recs.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(recs.map((r) => r.tool)).toEqual(["read_file", "run_command", "apply_patch"]);
    expect(recs.map((r) => r.outcome)).toEqual(["ok", "ok", "rejected"]);
    expect(readToolCallHealth("run-L2")).toEqual({ attempted: 3, dropped: 0 });
  });
});
