import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import {
  loadGroundTasks,
  loadPredictions,
  buildCaptureRecord,
  suppressNonOffered,
  restoreSuppressed,
  buildCreditProbeParams,
} from "./notice-regression-probe.mjs";
import { resolveToolList, listRegisteredTools, registerTool } from "../src/tools/toolRegistry.js";

const SNAPSHOT = new URL("../src/repo/rankerBaseline.snapshot.json", import.meta.url).pathname;
const SCRATCH = new URL("./.notice-regression-probe.scratch.json", import.meta.url).pathname;

describe("loadGroundTasks", () => {
  it("loads all seven frozen ground tasks with no filter", () => {
    const tasks = loadGroundTasks(SNAPSHOT, null);
    expect(tasks.map((t) => t.id).sort()).toEqual(["T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
  });

  it('loads all seven with only="all"', () => {
    expect(loadGroundTasks(SNAPSHOT, "all").length).toBe(7);
  });

  it("loads exactly one task for a single-id filter", () => {
    const tasks = loadGroundTasks(SNAPSHOT, ["T5"]);
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe("T5");
  });

  it("loads exactly the named subset for a multi-id filter", () => {
    const tasks = loadGroundTasks(SNAPSHOT, ["T2", "T4"]);
    expect(tasks.map((t) => t.id).sort()).toEqual(["T2", "T4"]);
  });
});

describe("loadPredictions", () => {
  it("throws with a specific message when the file is absent", () => {
    const missing = new URL("./.does-not-exist-predictions.json", import.meta.url).pathname;
    expect(() => loadPredictions(missing)).toThrow(/Predictions file required, not found/);
  });

  it('throws when the file exists but has no "perTask" object', () => {
    writeFileSync(SCRATCH, JSON.stringify({ anyRefusal: false }));
    try {
      expect(() => loadPredictions(SCRATCH)).toThrow(/missing a "perTask" object/);
    } finally {
      unlinkSync(SCRATCH);
    }
  });

  it("returns the parsed object when perTask is present", () => {
    writeFileSync(SCRATCH, JSON.stringify({ perTask: { T5: { discoveryCount: 1 } }, anyRefusal: false }));
    try {
      const p = loadPredictions(SCRATCH);
      expect(p.perTask.T5.discoveryCount).toBe(1);
      expect(p.anyRefusal).toBe(false);
    } finally {
      unlinkSync(SCRATCH);
    }
  });

  it("the shipped example file itself loads without throwing", () => {
    const example = new URL("./notice-regression-predictions.example.json", import.meta.url).pathname;
    expect(existsSync(example)).toBe(true);
    const p = loadPredictions(example);
    expect(p.perTask.T5).toBeDefined();
    expect(typeof p.rationale).toBe("string");
  });
});

describe("buildCaptureRecord", () => {
  const task = { id: "T5", task: "where do we decide iterations", correctFile: "src/llm/agentLoop.ts" };

  it("builds the full shape from a real-shaped loop result", () => {
    const loop = {
      iterCount: 3, terminationReason: "token_budget_exceeded", success: true,
      costUsd: 0.0613, tokenUsage: { total: 1200 },
      toolCallLog: [{ tool: "read_file", args: { filePath: "x.ts" }, success: true, result: "x".repeat(500) }],
      summary: "the answer",
    };
    const rec = buildCaptureRecord({
      arm: "B", task, model: "claude-sonnet-4-6", provider: "anthropic",
      err: null, wallMs: 1234, aborted: false, gitClean: true, gitBefore: "", gitAfter: "",
      loop, iterCap: 3, calls: [{ at: 10, name: "read_file", args: {} }],
    });
    expect(rec.arm).toBe("B");
    expect(rec.id).toBe("T5");
    expect(rec.correctFile).toBe("src/llm/agentLoop.ts");
    expect(rec.iterCount).toBe(3);
    expect(rec.iterCap).toBe(3);
    expect(rec.terminationReason).toBe("token_budget_exceeded");
    expect(rec.costUsd).toBe(0.0613);
    expect(rec.summary).toBe("the answer");
    expect(rec.onToolCallSeq.length).toBe(1);
  });

  it("truncates resultHead to 200 chars and computes resultLen from the full result", () => {
    const longResult = "y".repeat(500);
    const loop = { toolCallLog: [{ tool: "grep", args: {}, success: true, result: longResult }] };
    const rec = buildCaptureRecord({ arm: "A", task, model: "m", provider: "p", loop, iterCap: 3, calls: [] });
    expect(rec.toolCallLog[0].resultLen).toBe(500);
    expect(rec.toolCallLog[0].resultHead.length).toBe(200);
    expect(rec.toolCallLog[0].resultHead).toBe(longResult.slice(0, 200));
  });

  it("degrades gracefully when loop is null (a failed/aborted run)", () => {
    const rec = buildCaptureRecord({ arm: "B", task, model: "m", provider: "p", err: "boom", loop: null, iterCap: 3, calls: [] });
    expect(rec.iterCount).toBeNull();
    expect(rec.terminationReason).toBeNull();
    expect(rec.success).toBeNull();
    expect(rec.toolCallLog).toEqual([]);
    expect(rec.error).toBe("boom");
  });
});

describe("suppressNonOffered / restoreSuppressed — arm A's registry seam, against the real registry", () => {
  it("suppresses every non-offered tool, leaves the offered set exactly unchanged, and restores cleanly", () => {
    const registryFns = { listRegisteredTools, registerTool, resolveToolList };
    const before = resolveToolList(undefined).map((t) => t.name).sort();
    const offered = ["read_file", "run_command_readonly"];
    expect(before).toEqual(expect.arrayContaining(offered)); // sanity: both exist in the real registry

    const disabled = suppressNonOffered(offered, registryFns);
    try {
      const afterFull = resolveToolList(undefined).map((t) => t.name).sort();
      expect(afterFull).toEqual([...offered].sort());
      expect(disabled.length).toBe(before.length - offered.length);
    } finally {
      restoreSuppressed(disabled, registryFns);
    }

    const restored = resolveToolList(undefined).map((t) => t.name).sort();
    expect(restored).toEqual(before);
  });
});

describe("buildCreditProbeParams — the one provider-shaped assumption in the credit probe", () => {
  it("uses max_tokens: 16 for openai — the measured floor, not the anthropic default", () => {
    const params = buildCreditProbeParams("gpt-5.6-luna", "openai");
    expect(params.max_tokens).toBe(16);
    expect(params.model).toBe("gpt-5.6-luna");
    expect(params.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("uses max_tokens: 1 for anthropic — unaffected by the openai-specific floor", () => {
    const params = buildCreditProbeParams("claude-sonnet-4-6", "anthropic");
    expect(params.max_tokens).toBe(1);
  });
});
