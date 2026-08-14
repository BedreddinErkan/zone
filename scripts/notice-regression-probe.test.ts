import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import {
  loadGroundTasks,
  loadPredictions,
  buildCaptureRecord,
  suppressNonOffered,
  restoreSuppressed,
  buildCreditProbeParams,
  DISCOVERY_BINARIES,
  isDiscoveryCommand,
  isRefusal,
  scoreTaskDiscovery,
  compareDiscovery,
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

// Item 144: the discovery metric, formerly prose-only. Fixtures below are, wherever
// marked REAL, copied verbatim from the seven on-disk arm-B captures at
// .zone/audits/notice-regression-arm/armB-T*-*.json (read fresh for this pass, not
// carried) — embedded here rather than read live because that directory is gitignored
// and a test reading it would behave differently depending on whether the directory
// exists on the machine running it. Everything marked SYNTHETIC was written because no
// real capture in that set exercises the case, established by reading all seven before
// writing anything.

describe("DISCOVERY_BINARIES — the definition itself", () => {
  it("is exactly the prose's own list, single source of truth", () => {
    expect(DISCOVERY_BINARIES).toEqual(["ls", "find", "fd", "grep", "rg", "git grep", "git ls-files"]);
  });
});

describe("isDiscoveryCommand", () => {
  it("REAL T1: a bare rg call is discovery-shaped", () => {
    expect(isDiscoveryCommand(
      'rg -n -C 8 "QUICK_PLAN_FILES|12000|3000|overflow|plan context|planContext|seed" src test tests 2>/dev/null'
    )).toBe(true);
  });

  it("REAL T2: rg with long-form flags is still discovery-shaped", () => {
    expect(isDiscoveryCommand(
      "rg -n --hidden --glob '!node_modules' --glob '!dist' 'problemWordsPresent' ."
    )).toBe(true);
  });

  it("REAL T3: npm test is not discovery-shaped", () => {
    expect(isDiscoveryCommand("npm test")).toBe(false);
  });

  it("REAL T3: a compound of two git subcommands neither named in the prose is not discovery-shaped", () => {
    expect(isDiscoveryCommand("git diff --stat && git status --short")).toBe(false);
  });

  it("REAL T4: find piped to sort — the leading segment is discovery-shaped", () => {
    expect(isDiscoveryCommand("find . -name 'scopeGuard.ts' -type f | sort")).toBe(true);
  });

  it('SYNTHETIC: "git grep", the compound the prose names but no real capture exercises', () => {
    expect(isDiscoveryCommand("git grep -rn pattern src/")).toBe(true);
  });

  it('SYNTHETIC: "git ls-files", the other compound the prose names', () => {
    expect(isDiscoveryCommand("git ls-files --others --exclude-standard")).toBe(true);
  });

  it("ADVERSARIAL A (misparse shape 1 — quoted argument): a discovery word inside a search pattern is not the invoked command", () => {
    // npm test is invoked; "find" sits inside a quoted argument. A whole-string \bfind\b
    // regex would misparse this as discovery-shaped.
    expect(isDiscoveryCommand('npm test -- "please find the failing test"')).toBe(false);
  });

  it("ADVERSARIAL B (misparse shape 2 — path substring): a discovery word delimited inside a filename is not the invoked command", () => {
    // cat is invoked; "find" is delimited by / and - inside a filename, not a command.
    // Established before writing: no real capture in this set contains this shape.
    expect(isDiscoveryCommand("cat logs/find-output.log")).toBe(false);
  });

  it("SYNTHETIC: a single call with two qualifying segments still evaluates true (aggregation is scoreTaskDiscovery's job, not this function's)", () => {
    expect(isDiscoveryCommand("find . -name '*.ts' | grep foo")).toBe(true);
  });
});

describe("isRefusal", () => {
  it("REAL T1: an executed-and-failed call (exit_code=2) is not a refusal", () => {
    expect(isRefusal("[exit_code=2 — command failed]\nsrc/remote/toWireFrame.ts-21- * ...")).toBe(false);
  });

  it("REAL-SHAPED: an executed-and-succeeded call is not a refusal", () => {
    expect(isRefusal("[exit_code=0 — command succeeded; output below is informational]\n...")).toBe(false);
  });

  it('SYNTHETIC, exact prefix from toolExecutor.ts\'s own catch-all text: a refusal is detected', () => {
    expect(isRefusal("Command blocked: this find flag writes or runs a program. List without it.")).toBe(true);
  });
});

describe("scoreTaskDiscovery", () => {
  it("REAL T3: three calls, none discovery-shaped (npm test, two git commands off the list) — the zero fixture", () => {
    const toolCallLog = [
      { tool: "run_command_readonly", args: { command: "npm test" }, success: true, resultHead: "[exit_code=0 — command succeeded; output below is informational]\n..." },
      { tool: "run_command_readonly", args: { command: "git diff --stat && git status --short" }, success: false, resultHead: "[exit_code=1 — command failed]\n..." },
      { tool: "run_command_readonly", args: { command: "git diff --stat" }, success: true, resultHead: "[exit_code=0 — command succeeded; output below is informational]\n..." },
    ];
    const scored = scoreTaskDiscovery(toolCallLog);
    expect(scored.discoveryCount).toBe(0);
    expect(scored.discoveryCalls).toEqual([]);
    expect(scored.allShellCalls.length).toBe(3);
    expect(scored.refused).toBe(false);
  });

  it("REAL T5: two rg calls both count — the multi-discovery real fixture", () => {
    const toolCallLog = [
      { tool: "run_command_readonly", args: { command: 'rg -n -i "max[_ -]?iterations?|iterations?.{0,30}(max|limit)|max[_ -]?turns?|turns?.{0,30}(max|limit)|give up|iteration budget" src package.json' }, success: true, resultHead: "[exit_code=0 — command succeeded; output below is informational]\n..." },
      { tool: "run_command_readonly", args: { command: 'rg -n "BASE_MAX_ITERATIONS|ESCALATION_BONUS_ITERATIONS|maxIterationsForRun|maxIterationsOverride|maxIterations:" src/llm src/core src/cli/dispatch.ts src/cli/config.ts' }, success: true, resultHead: "[exit_code=0 — command succeeded; output below is informational]\n..." },
    ];
    expect(scoreTaskDiscovery(toolCallLog).discoveryCount).toBe(2);
  });

  it("REAL T4: read_file calls are excluded — only the one run_command_readonly call counts", () => {
    const toolCallLog = [
      { tool: "read_file", args: { filePath: "src/cli/scopeGuard.ts", lineRange: null }, success: false },
      { tool: "run_command_readonly", args: { command: "find . -name 'scopeGuard.ts' -type f | sort" }, success: true, resultHead: "[exit_code=0 — command succeeded; output below is informational]\n..." },
      { tool: "read_file", args: { filePath: "src/tools/scopeGuard.ts", lineRange: null }, success: true },
    ];
    const scored = scoreTaskDiscovery(toolCallLog);
    expect(scored.discoveryCount).toBe(1);
    expect(scored.allShellCalls.length).toBe(1);
  });

  it("REAL T1: a failed-but-genuine rg call still counts — success is not the discovery signal", () => {
    const toolCallLog = [
      { tool: "run_command_readonly", args: { command: 'rg -n -C 8 "QUICK_PLAN_FILES|12000|3000|overflow|plan context|planContext|seed" src test tests 2>/dev/null' }, success: false, resultHead: "[exit_code=2 — command failed]\n..." },
    ];
    expect(scoreTaskDiscovery(toolCallLog).discoveryCount).toBe(1);
  });

  it("SYNTHETIC: one call with two qualifying segments counts once, not twice — the unit is calls", () => {
    const toolCallLog = [
      { tool: "run_command_readonly", args: { command: "find . -name '*.ts' | grep foo" }, success: true, resultHead: "[exit_code=0 — command succeeded; output below is informational]\n..." },
    ];
    expect(scoreTaskDiscovery(toolCallLog).discoveryCount).toBe(1);
  });

  it("SYNTHETIC: a refused call is flagged separately from discovery scoring", () => {
    const toolCallLog = [
      { tool: "run_command_readonly", args: { command: "find / -exec rm {} \\;" }, success: false, resultHead: "Command blocked: this find flag writes or runs a program." },
    ];
    const scored = scoreTaskDiscovery(toolCallLog);
    expect(scored.refused).toBe(true);
    expect(scored.refusedCalls.length).toBe(1);
  });
});

describe("compareDiscovery", () => {
  const T3_ZERO = { taskId: "T3", summary: "", discoveryCount: 0, discoveryCalls: [], allShellCalls: [], refused: false, refusedCalls: [] };
  const T5_TWO = { taskId: "T5", summary: "", discoveryCount: 2, discoveryCalls: [], allShellCalls: [], refused: false, refusedCalls: [] };

  it("matching discoveryCount is reported as a match", () => {
    const predictions = { perTask: { T5: { discoveryCount: 2, falseNegativeResolves: null } }, anyRefusal: false };
    const cmp = compareDiscovery(predictions, [T5_TWO]);
    expect(cmp.perTask.T5.discoveryMatch).toBe(true);
    expect(cmp.perTask.T5.predictedDiscoveryCount).toBe(2);
    expect(cmp.perTask.T5.actualDiscoveryCount).toBe(2);
  });

  it("mismatching discoveryCount is reported as a mismatch, not silently averaged or rounded", () => {
    const predictions = { perTask: { T3: { discoveryCount: 3, falseNegativeResolves: null } }, anyRefusal: false };
    const cmp = compareDiscovery(predictions, [T3_ZERO]);
    expect(cmp.perTask.T3.discoveryMatch).toBe(false);
    expect(cmp.perTask.T3.predictedDiscoveryCount).toBe(3);
    expect(cmp.perTask.T3.actualDiscoveryCount).toBe(0);
  });

  it("anyRefusal: matches when the prediction and the aggregate agree", () => {
    const predictions = { perTask: { T3: { discoveryCount: 0, falseNegativeResolves: null } }, anyRefusal: false };
    const cmp = compareDiscovery(predictions, [T3_ZERO]);
    expect(cmp.anyRefusal).toEqual({ predicted: false, actual: false, match: true });
  });

  it("anyRefusal: mismatches when a task refused but none was predicted", () => {
    const refusedTask = { taskId: "T9", summary: "", discoveryCount: 0, discoveryCalls: [], allShellCalls: [], refused: true, refusedCalls: ["rm -rf /"] };
    const predictions = { perTask: { T9: { discoveryCount: 0, falseNegativeResolves: null } }, anyRefusal: false };
    const cmp = compareDiscovery(predictions, [refusedTask]);
    expect(cmp.anyRefusal).toEqual({ predicted: false, actual: true, match: false });
  });

  it("falseNegativeResolves is surfaced for human judgment, never auto-resolved to true or false", () => {
    // REAL T2 summary (truncated): the false negative genuinely resolved — the symbol
    // arm B claimed absent is found in five places. A regex over this prose is not what
    // decides that; a human reading it is.
    const t2 = {
      taskId: "T2", summary: "I found `problemWordsPresent` in: - `src/llm/taskShape.ts` — exported function ...",
      discoveryCount: 1, discoveryCalls: [], allShellCalls: [], refused: false, refusedCalls: [],
    };
    const predictions = { perTask: { T2: { discoveryCount: 1, falseNegativeResolves: true } }, anyRefusal: false };
    const cmp = compareDiscovery(predictions, [t2]);
    expect(cmp.perTask.T2.requiresHumanJudgment).toBe(true);
    expect(cmp.perTask.T2.predictedFalseNegativeResolves).toBe(true);
    expect(cmp.perTask.T2.actualSummary).toContain("problemWordsPresent");
    // The function itself never produces a resolved boolean for this field.
    expect(cmp.perTask.T2).not.toHaveProperty("falseNegativeResolvesActual");
    expect(cmp.perTask.T2).not.toHaveProperty("falseNegativeMatch");
  });

  it("a task with no prediction entry reports null rather than a false mismatch", () => {
    const predictions = { perTask: {}, anyRefusal: false };
    const cmp = compareDiscovery(predictions, [T3_ZERO]);
    expect(cmp.perTask.T3.discoveryMatch).toBeNull();
    expect(cmp.perTask.T3.predictedDiscoveryCount).toBeNull();
  });
});
