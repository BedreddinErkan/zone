import { describe, it, expect, afterEach } from "vitest";
import {
  clearToolResultSizeTrackerForTest,
  getAndClearToolResultSummary,
} from "./toolResultSizeTracker.js";
import { emitToolResultSize } from "./loopTelemetry.js";

describe("toolResultSizeTracker", () => {
  afterEach(() => clearToolResultSizeTrackerForTest());

  it("accumulates per-tool bytes within a run", () => {
    emitToolResultSize({ runId: "r1", tool: "read_file", bytes: 500, callId: "c1", iter: 0 });
    emitToolResultSize({ runId: "r1", tool: "run_command", bytes: 1200, callId: "c2", iter: 1 });
    const s = getAndClearToolResultSummary("r1")!;
    expect(s.totalResults).toBe(2);
    expect(s.totalBytes).toBe(1700);
    expect(s.perTool["read_file"]).toEqual({ count: 1, bytes: 500 });
    expect(s.perTool["run_command"]).toEqual({ count: 1, bytes: 1200 });
  });

  it("getAndClear clears the map so a second call returns null", () => {
    emitToolResultSize({ runId: "r2", tool: "read_file", bytes: 100, callId: "c1", iter: 0 });
    getAndClearToolResultSummary("r2");
    expect(getAndClearToolResultSummary("r2")).toBeNull();
  });

  it("run isolation — different runIds do not mix", () => {
    emitToolResultSize({ runId: "rA", tool: "read_file", bytes: 100, callId: "x", iter: 0 });
    emitToolResultSize({ runId: "rB", tool: "run_command", bytes: 200, callId: "y", iter: 0 });
    const sA = getAndClearToolResultSummary("rA")!;
    expect(sA.totalResults).toBe(1);
    expect(sA.perTool["read_file"]).toBeDefined();
    expect(sA.perTool["run_command"]).toBeUndefined();
    // rB still intact
    const sB = getAndClearToolResultSummary("rB")!;
    expect(sB.totalResults).toBe(1);
    expect(sB.perTool["run_command"]).toBeDefined();
  });

  it("same tool multiple times — count and bytes sum correctly", () => {
    emitToolResultSize({ runId: "r3", tool: "search_in_files", bytes: 1000, callId: "c1", iter: 0 });
    emitToolResultSize({ runId: "r3", tool: "search_in_files", bytes: 2000, callId: "c2", iter: 1 });
    const s = getAndClearToolResultSummary("r3")!;
    expect(s.perTool["search_in_files"]).toEqual({ count: 2, bytes: 3000 });
    expect(s.totalBytes).toBe(3000);
  });
});
