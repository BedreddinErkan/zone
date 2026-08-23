import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordToolCall, readToolCallHealth, _resetToolCallHealthForTest } from "./toolCallRecord.js";
import {
  TOOL_CALL_RECORD_NAME,
  _setToolCallSinkPathForTest,
} from "../utils/toolCallSink.js";
import type { ToolCallLogEntry } from "./toolEventHandler/types.js";

/**
 * L1/L2 for the tool-call recorder.
 *
 * The load-bearing property is negative and easy to test vacuously: "recording
 * does not depend on ZONE_VERBOSE_LOGS". Every test here therefore runs with
 * that variable explicitly DELETED, and the first assertion of the first test
 * is that a record exists at all — a fact only a working sink can produce. An
 * absence check that ran against a broken harness would otherwise pass for the
 * wrong reason.
 */

let sinkPath: string;
let repoPath: string;
let savedVerbose: string | undefined;

function readRecords(): Array<Record<string, unknown>> {
  if (!fs.existsSync(sinkPath)) return [];
  return fs
    .readFileSync(sinkPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const META = (over?: Record<string, unknown>): never =>
  ({ runId: "run-A", sessionId: "sess-A", iter: 3, repoPath, ...over }) as never;

const entry = (over?: Partial<ToolCallLogEntry>): ToolCallLogEntry => ({
  id: "call-1",
  tool: "read_file",
  args: { filePath: "src/llm/agentLoop.ts" },
  result: "ok",
  success: true,
  ...over,
});

beforeEach(() => {
  savedVerbose = process.env.ZONE_VERBOSE_LOGS;
  delete process.env.ZONE_VERBOSE_LOGS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-toolcall-sink-"));
  sinkPath = path.join(dir, "tool-calls.jsonl");
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-toolcall-repo-"));
  _setToolCallSinkPathForTest(sinkPath);
  _resetToolCallHealthForTest();
});

afterEach(() => {
  _setToolCallSinkPathForTest(null);
  _resetToolCallHealthForTest();
  if (savedVerbose === undefined) delete process.env.ZONE_VERBOSE_LOGS;
  else process.env.ZONE_VERBOSE_LOGS = savedVerbose;
});

describe("recordToolCall — L1: recording is ungated", () => {
  it("writes a record with ZONE_VERBOSE_LOGS unset, and still pushes to the in-memory log", () => {
    expect(process.env.ZONE_VERBOSE_LOGS).toBeUndefined();
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry(), META());

    const recs = readRecords();
    // Harness plausibility floor: a working sink produced something.
    expect(recs).toHaveLength(1);
    expect(recs[0]!.name).toBe(TOOL_CALL_RECORD_NAME);
    expect(log).toHaveLength(1);
  });

  it("resolves the target to an ABSOLUTE path, not the raw argument", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry({ args: { filePath: "src/llm/agentLoop.ts" } }), META());
    const paths = readRecords()[0]!.paths as string[];
    expect(paths).toHaveLength(1);
    expect(path.isAbsolute(paths[0]!)).toBe(true);
    expect(paths[0]).toBe(path.resolve(repoPath, "src/llm/agentLoop.ts"));
    expect(paths[0]).not.toBe("src/llm/agentLoop.ts");
  });

  it("an ABSOLUTE in-repo argument records that same absolute path — the case that separates 'resolved' from 'relative'", () => {
    // With a relative argument, "record the raw arg" and "record the repo-relative
    // path" are the SAME edit and cannot be told apart. An absolute in-repo argument
    // separates them: resolveAgentPath strips the repo prefix, so the correct answer
    // and the raw argument agree here while the relative form does not.
    const log: ToolCallLogEntry[] = [];
    const absIn = path.join(repoPath, "src", "deep", "x.ts");
    recordToolCall(log, entry({ args: { filePath: absIn } }), META());
    expect(readRecords()[0]!.paths).toEqual([absIn]);
  });

  it("an absolute argument pointing OUTSIDE the repo is recorded as the sandboxed path the tool actually used", () => {
    // resolveAgentPath re-roots such a path under the repo; the record reports what
    // was accessed, not what was requested.
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry({ args: { filePath: "/etc/passwd" } }), META());
    expect(readRecords()[0]!.paths).toEqual([path.resolve(repoPath, "etc/passwd")]);
  });

  it("records every target of a multi_edit, not just the first", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry({ tool: "multi_edit", args: { files: ["a.ts", "b.ts", "c.ts"] } }), META());
    const paths = readRecords()[0]!.paths as string[];
    expect(paths).toHaveLength(3);
    expect(paths.every((p) => path.isAbsolute(p))).toBe(true);
  });

  it("a pathless tool records an EMPTY ARRAY, never null and never an absent field", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry({ tool: "run_command", args: { command: "npm test" } }), META());
    const rec = readRecords()[0]!;
    expect(rec.paths).toEqual([]);
    expect(rec.paths).not.toBeNull();
    expect(Object.keys(rec)).toContain("paths");
  });

  it("carries the verbatim command for a shell tool, and null for a file tool", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry({ tool: "run_command", args: { command: "grep -rn foo src/" } }), META());
    recordToolCall(log, entry(), META());
    const recs = readRecords();
    expect(recs[0]!.command).toBe("grep -rn foo src/");
    expect(recs[1]!.command).toBeNull();
  });

  it("records the real tool name", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry({ tool: "find_references", args: { sourceFile: "x.ts" } }), META());
    expect(readRecords()[0]!.tool).toBe("find_references");
  });

  it("seq is monotonic within a run and attributed to the right runId", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry(), META());
    recordToolCall(log, entry(), META());
    recordToolCall(log, entry(), META({ runId: "run-B" }));
    const recs = readRecords();
    expect(recs.map((r) => r.seq)).toEqual([0, 1, 0]);
    expect(recs.map((r) => r.runId)).toEqual(["run-A", "run-A", "run-B"]);
    expect(recs[0]!.sessionId).toBe("sess-A");
    expect(recs[0]!.iteration).toBe(3);
  });

  it("is a DIFFERENT channel from the debug marker — the names must not collide", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry(), META());
    expect(readRecords()[0]!.name).not.toBe("[zone-agent-tool-call]");
    expect(TOOL_CALL_RECORD_NAME).toBe("[zone-tool-call-record]");
  });
});

describe("tool-call sink — default destination", () => {
  /**
   * Every other test in this file overrides the sink path, which means none of
   * them can see WHICH file production writes to. Without this case, pointing
   * the sink at markers.jsonl would be invisible to the whole suite — observer
   * absence, not a passing design. HOME is redirected to a temp dir for the
   * suite (vitest.config.ts), so this writes to the test home, never the real one.
   */
  it("writes to ~/.zone/tool-calls.jsonl by default — a separate file from the marker sink", () => {
    _setToolCallSinkPathForTest(null);
    const expected = path.join(os.homedir(), ".zone", "tool-calls.jsonl");
    try {
      fs.rmSync(expected, { force: true });
      const log: ToolCallLogEntry[] = [];
      recordToolCall(log, entry(), META());
      expect(fs.existsSync(expected)).toBe(true);
      const line = fs.readFileSync(expected, "utf8").trim().split("\n").pop()!;
      expect((JSON.parse(line) as Record<string, unknown>).name).toBe(TOOL_CALL_RECORD_NAME);
      expect(expected.endsWith(path.join(".zone", "tool-calls.jsonl"))).toBe(true);
      expect(expected).not.toContain("markers.jsonl");
    } finally {
      fs.rmSync(expected, { force: true });
      _setToolCallSinkPathForTest(sinkPath);
    }
  });
});

describe("recordToolCall — outcomes, including refusals", () => {
  it("a rejected call records outcome 'rejected' and its structured reason", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(
      log,
      entry({ tool: "apply_patch", success: false, rejectionReason: "find_not_found", result: "no match" }),
      META(),
    );
    const rec = readRecords()[0]!;
    expect(rec.outcome).toBe("rejected");
    expect(rec.reason).toBe("find_not_found");
  });

  it("a failure with no structured reason records outcome 'error' and a non-null reason", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry({ success: false, result: "ENOENT: no such file" }), META({ errorText: "ENOENT" }));
    const rec = readRecords()[0]!;
    expect(rec.outcome).toBe("error");
    expect(rec.reason).toBe("ENOENT");
  });

  it("a success records outcome 'ok' with a null reason", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry(), META());
    const rec = readRecords()[0]!;
    expect(rec.outcome).toBe("ok");
    expect(rec.reason).toBeNull();
  });
});

describe("recordToolCall — warm resume", () => {
  it("replayed entries reach the in-memory log but write NO durable record, and the next real call is seq 0", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry({ id: "old-1" }), META({ replayed: true }));
    recordToolCall(log, entry({ id: "old-2" }), META({ replayed: true }));
    expect(log).toHaveLength(2);
    expect(readRecords()).toHaveLength(0);

    recordToolCall(log, entry({ id: "new-1" }), META());
    const recs = readRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.seq).toBe(0);
    expect(readToolCallHealth("run-A").attempted).toBe(1);
  });
});

describe("recordToolCall — never throws into the run it observes", () => {
  /**
   * This is a diagnostic side-channel; it must be strictly LESS reliable than
   * the run. The first version of this file did not test it, and the gap was
   * real: a caller with no repoPath made path resolution throw, turning an
   * observability feature into a way to kill a tool call. Observer absence, not
   * inertness — the behaviour was always wrong, nothing was watching it.
   */
  it("a missing repoPath records no paths rather than throwing", () => {
    const log: ToolCallLogEntry[] = [];
    expect(() =>
      recordToolCall(log, entry(), { runId: "r", sessionId: null, iter: 0 } as never),
    ).not.toThrow();
    expect(log).toHaveLength(1);
    const recs = readRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.paths).toEqual([]);
    expect(recs[0]!.tool).toBe("read_file");
  });

  it("an unusable sink path is a dropped record, not an exception", () => {
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zone-nothrow-")), "notadir");
    fs.writeFileSync(blocker, "x");
    _setToolCallSinkPathForTest(path.join(blocker, "sub", "tool-calls.jsonl"));
    const log: ToolCallLogEntry[] = [];
    expect(() => recordToolCall(log, entry(), META())).not.toThrow();
    expect(log).toHaveLength(1);
    expect(readToolCallHealth("run-A")).toEqual({ attempted: 1, dropped: 1 });
  });

  it("garbage args do not throw and still record the tool name", () => {
    const log: ToolCallLogEntry[] = [];
    expect(() =>
      recordToolCall(log, entry({ tool: "multi_edit", args: { files: [null, 7, {}] } as never }), META()),
    ).not.toThrow();
    expect(readRecords()[0]!.tool).toBe("multi_edit");
    expect(readRecords()[0]!.paths).toEqual([]);
  });
});

describe("recordToolCall — write health (an empty sink must be falsifiable)", () => {
  it("a writer that fails on EVERY append still reports attempted > 0 through the other instrument", () => {
    // Force every write to fail: point the sink at a path whose parent is a FILE,
    // so mkdirSync throws. Total failure, not partial — the case the counter exists for.
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zone-blocked-")), "notadir");
    fs.writeFileSync(blocker, "x");
    _setToolCallSinkPathForTest(path.join(blocker, "sub", "tool-calls.jsonl"));

    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry(), META());
    recordToolCall(log, entry(), META());

    const health = readToolCallHealth("run-A");
    expect(health.attempted).toBe(2);
    expect(health.dropped).toBe(2);
    expect(log).toHaveLength(2); // the run itself is unaffected
  });

  it("a healthy run reports dropped 0 and droppedSinceLast 0", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry(), META());
    expect(readRecords()[0]!.droppedSinceLast).toBe(0);
    expect(readToolCallHealth("run-A")).toEqual({ attempted: 1, dropped: 0 });
  });

  it("reading health drains it, so a second read cannot double-count", () => {
    const log: ToolCallLogEntry[] = [];
    recordToolCall(log, entry(), META());
    expect(readToolCallHealth("run-A").attempted).toBe(1);
    expect(readToolCallHealth("run-A").attempted).toBe(0);
  });
});
