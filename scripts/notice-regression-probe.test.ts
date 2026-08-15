import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  validatePredictions,
  runPromptAudit,
} from "./notice-regression-probe.mjs";
import { resolveToolList, listRegisteredTools, registerTool } from "../src/tools/toolRegistry.js";
import { buildDispatcherCapabilityFilter, QUESTION_PIPELINE } from "../src/llm/archetypeDispatcher.js";
// The byte-identity reference below must use the SAME built assembleAgentSystemPrompt and
// readProjectMemoryBlock runPromptAudit itself calls (../dist/..., not ../src/...) — using
// the vitest-transformed src versions here would make a src/dist build skew look like a
// prompt-assembly regression, which is exactly the kind of false signal this proof exists
// to rule out.
import { assembleAgentSystemPrompt } from "../dist/llm/agentLoop.js";
import { readProjectMemoryBlock } from "../dist/memory/projectMemory.js";
// runPromptAudit (imported above from notice-regression-probe.mjs) reaches the registry
// via ../dist/tools/toolRegistry.js, a SEPARATE module instance from the src import above
// — established by running: suppressing through the src-imported functions left
// runPromptAudit's own offered-set check unaffected. Only the dist-imported functions
// below can mutate the registry runPromptAudit actually reads.
import { listRegisteredTools as listRegisteredToolsDist, registerTool as registerToolDist } from "../dist/tools/toolRegistry.js";

const SNAPSHOT = new URL("../src/repo/rankerBaseline.snapshot.json", import.meta.url).pathname;
const SCRATCH = new URL("./.notice-regression-probe.scratch.json", import.meta.url).pathname;

// The real, unedited historical predictions file the T2/T4 openai arm-B run actually
// used — embedded verbatim rather than read live, for the same reason the discovery
// fixtures below are: .zone/ is gitignored, so a live read behaves differently
// depending on the machine running the test. Its T2 entry carries discoveryCount: 1.5
// — established as NOT a typo: the file's own rationale explains it as a deliberate
// range encoding ("Predicted T2 discoveryCount is a range (1-2, written as 1.5)"),
// which is exactly why validation warns rather than throws on it.
const REAL_T2T4_PREDICTIONS = {
  "_readme": "Predictions for the OpenAI cross-provider establish pass (gpt-5.6-luna, arm B / shipped configuration, T2 and T4 only). Registered before the first model call, transcribed from the plan approved for this pass -- not written after seeing any result.",
  "perTask": {
    "T2": { "discoveryCount": 1.5, "falseNegativeResolves": true },
    "T4": { "discoveryCount": 1, "falseNegativeResolves": true }
  },
  "anyRefusal": false,
  "rationale": "Both shipped fixes (the collision-suppression rule in toolAbsenceNotice.ts, and the discovery-binary disclosure in the tool's own description) are provider-blind -- static text and a suppression rule computed once, reading nothing about which model is calling. Step 1 of this pass's plan confirmed the notice, the description, and the tool schema all reach an OpenAI run unchanged: description text survives the Responses-API tool conversion byte for byte (responsesConvertParams.ts's unnest is structural only), and toolAbsenceNotice.ts itself has zero provider references. If the fixes are sound in general rather than incidentally Anthropic-shaped, a model with the same tool set and the same corrected notice should also discover T2's symbol (item 90: arms A and C both found it in ten places across four files with one grep) and locate T4's file (item 90: arms A and C both located it with one find). Predicted T2 discoveryCount is a range (1-2, written as 1.5) because arm A used one grep and arm C used one grep for T2 specifically, but a different model's own querying style is the one genuinely untested variable here -- not the fix, which is reasoned above to be provider-blind, but this specific OpenAI model's own tool-calling tendency, which no prior arm (all Anthropic-only) ever measured. anyRefusal is predicted false because checkCommandSafe is a pure function of the command string with no model-identity input, and it produced zero refusals across the seventeen commands recovered in the establish pass behind item 91. A miss on discoveryCount or falseNegativeResolves is informative about this model's own behaviour, not about the fix regressing on this provider -- item 90's own pending verification requires the same model as arms A, B, and C, which this pass does not use and cannot substitute for.",
};

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

// The exact prefix of a whitelist-miss refusal, verified by reading toolExecutor.ts's
// current render branch (`safety.tag === "whitelist-miss"`) and runCommandSafe.ts's
// WHITELIST_MISS_SAMPLE/WHITELIST_PREFIXES, not read from a capture — no on-disk
// capture in this arc's data contains a whitelist-miss refusal, established by
// sweeping all seven arm-B files before writing this. Structurally different from the
// chain text below: a different template entirely (allowed prefixes, not a blocked
// pattern), reached via a different branch than either the chain or catch-all texts.
// Established, not assumed: item 93's own ledger entry describes an OLDER render of
// this same branch (WHITELIST_PREFIXES.slice(0,8), test-runner-heavy, no discovery
// binary) — that description is now stale. Item 108 decoupled the rendered text from
// that raw slice into the curated, discovery-first WHITELIST_MISS_SAMPLE below; this
// fixture reflects the code as it reads today, confirmed by reading toolExecutor.ts
// fresh rather than trusting the ledger's own prose about it.
const REAL_WHITELIST_MISS_TEXT =
  "Command blocked: not in whitelist. Examples of allowed prefixes: ls, find, grep, rg, fd, npm test, npx vitest, tsc, and more (45 total). This command isn't on the no-approval read-only allowlist — if it's a safe read, run it via the approval-gated shell (run_command) instead.";

// The exact resultHead the real T3 capture holds — copied verbatim, truncated at 200
// chars exactly as buildCaptureRecord truncates it in production, not reproduced from
// the current source template. (The current chain-text template no longer contains the
// raw-regex fragment this real capture does — item 93's own "chain branch rendered a
// raw regex too" finding, fixed after this capture was taken. Using the real bytes
// rather than today's template is deliberate: this is what a real run actually
// produced, which is what isRefusal has to work against.)
const REAL_T3_CHAIN_REFUSAL_TEXT =
  "Command blocked: blocked pattern: &&\\s*\\S. Chained commands aren't supported on the read-only shell — run each command (e.g. `git status -s` and `git diff --stat`) as a separate call. For file content";

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

  it("REAL T3, verbatim from the actual capture (not a synthetic invention): a refusal is detected", () => {
    expect(isRefusal(REAL_T3_CHAIN_REFUSAL_TEXT)).toBe(true);
  });

  it("REAL TEMPLATE (whitelist-miss, verified from current source, structurally different from the chain text): a refusal is detected", () => {
    expect(isRefusal(REAL_WHITELIST_MISS_TEXT)).toBe(true);
  });
});

describe("scoreTaskDiscovery", () => {
  it("REAL T3: three calls, none discovery-shaped (npm test, two git commands off the list) — the zero fixture, with its genuine mid-call refusal", () => {
    // Call #2's resultHead corrected to the real captured text (was a generic
    // exit-code placeholder in the prior pass — the real call was refused, not
    // executed-and-failed, and `refused` below was wrongly asserted false against it).
    const toolCallLog = [
      { tool: "run_command_readonly", args: { command: "npm test" }, success: true, resultHead: "[exit_code=0 — command succeeded; output below is informational]\n..." },
      { tool: "run_command_readonly", args: { command: "git diff --stat && git status --short" }, success: false, resultHead: REAL_T3_CHAIN_REFUSAL_TEXT },
      { tool: "run_command_readonly", args: { command: "git diff --stat" }, success: true, resultHead: "[exit_code=0 — command succeeded; output below is informational]\n..." },
    ];
    const scored = scoreTaskDiscovery(toolCallLog);
    expect(scored.discoveryCount).toBe(0);
    expect(scored.discoveryCalls).toEqual([]);
    expect(scored.allShellCalls.length).toBe(3);
    expect(scored.refused).toBe(true);
    expect(scored.refusedCalls).toEqual(["git diff --stat && git status --short"]);
    // The refusal is real, but the refused command isn't discovery-shaped — so the
    // ruling has nothing to exclude here. This is the case the establish pass named:
    // a task with only a refused, non-discovery call cannot tell "excluded" from
    // "never there" — the boundary test below is what actually exercises the ruling.
    expect(scored.refusedDiscoveryShapedCalls).toEqual([]);
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

  it("THE RULING, center case: a refused discovery-shaped call does not count, but remains visible in both raw fields", () => {
    const toolCallLog = [
      { tool: "run_command_readonly", args: { command: "find / -exec rm {} \\;" }, success: false, resultHead: "Command blocked: this find flag writes or runs a program." },
    ];
    const scored = scoreTaskDiscovery(toolCallLog);
    expect(scored.discoveryCount).toBe(0);
    expect(scored.discoveryCalls).toEqual([]);
    expect(scored.refused).toBe(true);
    expect(scored.refusedCalls).toEqual(["find / -exec rm {} \\;"]);
    expect(scored.refusedDiscoveryShapedCalls).toEqual(["find / -exec rm {} \\;"]);
  });

  it("THE RULING under a second, structurally different refusal text (whitelist-miss, verified from source): still excluded", () => {
    // The pairing (this specific command with a whitelist-miss refusal) is constructed
    // to exercise the scorer's classification, not a claim that the real gate would
    // route this exact command to whitelist-miss — ls/find/fd/grep/rg and git
    // grep/ls-files are themselves whitelisted prefixes, per item 93/CLAUDE.md, so a
    // real whitelist-miss-and-discovery-shaped pairing may not be reachable through the
    // live gate at all. What's real here is the refusal TEXT, verified from current
    // source; the test proves isRefusal and the ruling both hold under it regardless.
    const toolCallLog = [
      { tool: "run_command_readonly", args: { command: "rg --unusual-flag-combo pattern src/" }, success: false, resultHead: REAL_WHITELIST_MISS_TEXT },
    ];
    const scored = scoreTaskDiscovery(toolCallLog);
    expect(scored.discoveryCount).toBe(0);
    expect(scored.refused).toBe(true);
    expect(scored.refusedDiscoveryShapedCalls).toEqual(["rg --unusual-flag-combo pattern src/"]);
  });

  it("THE RULING'S BOUNDARY: a task with both a refused discovery-shaped call and an executed one — the count is exactly one, and both stay visible", () => {
    // This is the case a single-call fixture cannot exercise: with only a refused call
    // present, "excluded from the count" and "never there" produce the same zero. Two
    // calls make the exclusion observable, not just assertable.
    const toolCallLog = [
      { tool: "run_command_readonly", args: { command: "find / -exec rm {} \\;" }, success: false, resultHead: "Command blocked: this find flag writes or runs a program." },
      { tool: "run_command_readonly", args: { command: "rg pattern src/" }, success: true, resultHead: "[exit_code=0 — command succeeded; output below is informational]\n..." },
    ];
    const scored = scoreTaskDiscovery(toolCallLog);
    expect(scored.discoveryCount).toBe(1);
    expect(scored.discoveryCalls).toEqual(["rg pattern src/"]);
    expect(scored.refusedDiscoveryShapedCalls).toEqual(["find / -exec rm {} \\;"]);
    expect(scored.allShellCalls).toEqual(["find / -exec rm {} \\;", "rg pattern src/"]);
    expect(scored.refused).toBe(true);
  });
});

describe("validatePredictions", () => {
  it("a valid integer discoveryCount produces no warning", () => {
    const raw = { perTask: { T5: { discoveryCount: 3, falseNegativeResolves: null } }, anyRefusal: false, rationale: "because" };
    expect(validatePredictions(raw)).toEqual([]);
  });

  it("the shipped example file itself produces zero warnings via loadPredictions — the fully-valid case, through the real path", () => {
    const example = new URL("./notice-regression-predictions.example.json", import.meta.url).pathname;
    const p = loadPredictions(example);
    expect(p.validationWarnings).toEqual([]);
  });

  it("the REAL historical T2/T4 file's discoveryCount: 1.5 produces exactly one warning naming the field and value", () => {
    const warnings = validatePredictions(REAL_T2T4_PREDICTIONS);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("perTask.T2.discoveryCount");
    expect(warnings[0]).toContain("1.5");
  });

  it("loadPredictions integration: the real T2/T4 file does not throw and its warning survives into validationWarnings, untouched on disk", () => {
    // Written to SCRATCH rather than pointed at the real .zone/ path — same portability
    // reasoning as every other embedded fixture here — but this is still the real
    // recorded content, round-tripped through the actual loadPredictions file-read path
    // rather than called as a pure function on an in-memory object.
    writeFileSync(SCRATCH, JSON.stringify(REAL_T2T4_PREDICTIONS));
    try {
      const p = loadPredictions(SCRATCH);
      expect(p.perTask.T2.discoveryCount).toBe(1.5); // unmodified — the artifact is not edited to pass
      expect(p.validationWarnings.some((w) => w.includes("perTask.T2.discoveryCount"))).toBe(true);
    } finally {
      unlinkSync(SCRATCH);
    }
  });

  it("an invalid falseNegativeResolves (not true/false/null) is warned", () => {
    const raw = { perTask: { T2: { discoveryCount: 1, falseNegativeResolves: "yes" } }, anyRefusal: false, rationale: "x" };
    const warnings = validatePredictions(raw);
    expect(warnings.some((w) => w.includes("falseNegativeResolves"))).toBe(true);
  });

  it("an invalid anyRefusal (not a boolean) is warned", () => {
    const raw = { perTask: {}, anyRefusal: "maybe", rationale: "x" };
    const warnings = validatePredictions(raw);
    expect(warnings.some((w) => w.includes("anyRefusal"))).toBe(true);
  });

  it("a missing rationale is warned, since the readme states it is required", () => {
    const raw = { perTask: {}, anyRefusal: false };
    const warnings = validatePredictions(raw);
    expect(warnings.some((w) => w.includes("rationale"))).toBe(true);
  });

  it("a negative or non-integer discoveryCount is warned, an in-range integer is not, across a small sweep", () => {
    // rationale included in each so the sweep isolates discoveryCount specifically —
    // its own absence is a separate, already-covered warning.
    expect(validatePredictions({ perTask: { X: { discoveryCount: 0 } }, rationale: "x" }).length).toBe(0);
    expect(validatePredictions({ perTask: { X: { discoveryCount: -1 } }, rationale: "x" }).length).toBe(1);
    expect(validatePredictions({ perTask: { X: { discoveryCount: 2.5 } }, rationale: "x" }).length).toBe(1);
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

// Item 150: the prompt-audit step used to omit offeredToolNames, so its own diagnostic
// dumps rendered eight write-tool blocks (PATCH RULES among them) the real run — which
// does pass the real offered set — never sees. Established by running both ways before
// writing any assertion here: for this archetype (offered = read_file,
// run_command_readonly only), every isOffered(...) gate in assembleAgentSystemPrompt
// checks a WRITE tool (apply_patch, write_file, multi_edit, Task, TodoWrite, revert_patch,
// search_in_files) — none checks read_file or run_command_readonly positively — so an
// EMPTY offered set and the real pair render byte-identical text for this configuration.
// A text-content assertion cannot distinguish "the real set was passed" from "an empty
// set was passed" here; only inspecting what was actually constructed and handed to the
// assembler can. offeredToolNamesUsed exists for exactly that: it is derived from the
// same Set object runPromptAudit passes to both assembly calls, not a separately
// re-derived value that could silently diverge from it.
describe("runPromptAudit", () => {
  function scratchDir() {
    return mkdtempSync(path.join(tmpdir(), "notice-regression-audit-test-"));
  }

  // Fixed literal, not a real path anywhere — repoPath is spliced literally into the
  // assembled prompt (see agentLoop.ts's "Repository path:" line), so a real repoPath
  // here would make the tests below sensitive to this machine's own absolute checkout
  // path length. Item 159 investigation: notice-regression-probe.mjs and its own test
  // are the only place this class of test previously used a real, machine-dependent
  // repoPath (docs/deferred-work.md item 90's addendum records the broader mechanism —
  // out of scope to fix here).
  const FIXTURE_REPO_PATH = "/fixture/repo";

  // A real, throwaway directory with a test-owned .zone/memory.md — never the live,
  // untracked one at this repo's own root, which is absent on a fresh CI checkout
  // (item 159). marker must be unique enough that it cannot coincidentally appear
  // anywhere else in the assembled prompt.
  function memoryFixtureDir(marker: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "notice-regression-memory-fixture-"));
    mkdirSync(path.join(dir, ".zone"), { recursive: true });
    writeFileSync(
      path.join(dir, ".zone", "memory.md"),
      `# Zone Project Memory\n\n- [2026-01-01] ${marker}\n`
    );
    return dir;
  }

  it("PATCH RULES is absent from both dumps for the question archetype — half 1's payoff", async () => {
    const dir = scratchDir();
    try {
      const audit = await runPromptAudit({ capturesDir: dir, ARM: "B", only: null, runStamp: 1000 });
      expect(audit.sysNoNotice).not.toContain("PATCH RULES:");
      expect(audit.sysWithNotice).not.toContain("PATCH RULES:");
      expect(audit.sysWithNotice).toContain("TOOLS NOT AVAILABLE THIS RUN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("offeredToolNamesUsed is exactly the real registry-derived pair — pins the field's CONTENTS, not merely its presence", async () => {
    const dir = scratchDir();
    try {
      const audit = await runPromptAudit({ capturesDir: dir, ARM: "B", only: null, runStamp: 1001 });
      const expected = resolveToolList(buildDispatcherCapabilityFilter({ ...QUESTION_PIPELINE }))
        .map((t) => t.name)
        .sort();
      expect(audit.offeredToolNamesUsed).toEqual(expected);
      expect(audit.offeredToolNamesUsed).toEqual(["read_file", "run_command_readonly"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filenames carry the run stamp — two different stamps produce two different, non-colliding paths", async () => {
    const dir = scratchDir();
    try {
      const a = await runPromptAudit({ capturesDir: dir, ARM: "B", only: null, runStamp: 2000 });
      const b = await runPromptAudit({ capturesDir: dir, ARM: "B", only: null, runStamp: 2001 });
      expect(a.noNoticePath).not.toBe(b.noNoticePath);
      expect(a.withNoticePath).not.toBe(b.withNoticePath);
      expect(a.noNoticePath).toMatch(/system-prompt-no-notice-armB-all-2000\.txt$/);
      expect(b.noNoticePath).toMatch(/system-prompt-no-notice-armB-all-2001\.txt$/);
      expect(existsSync(a.noNoticePath)).toBe(true);
      expect(existsSync(b.noNoticePath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filenames also carry the task selection, matching the capture file's own arm+selection+stamp shape", async () => {
    const dir = scratchDir();
    try {
      const audit = await runPromptAudit({ capturesDir: dir, ARM: "A", only: ["T2", "T4"], runStamp: 3000 });
      expect(audit.noNoticePath).toMatch(/system-prompt-no-notice-armA-T2_T4-3000\.txt$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws (not process.exit) when the registry no longer resolves to exactly [read_file, run_command_readonly] — a test importing this must survive the assertion failing", async () => {
    // Same registry seam the suppressNonOffered describe block above exercises, but
    // against the DIST-imported registry functions — runPromptAudit reads through
    // ../dist/tools/toolRegistry.js, a separate module instance from the src import used
    // elsewhere in this file, established above. Disable everything except
    // run_command_readonly, so resolveToolList(capabilityFilter) inside runPromptAudit
    // resolves to a one-tool set instead of the expected pair, then restore.
    const registryFns = { listRegisteredTools: listRegisteredToolsDist, registerTool: registerToolDist };
    const dir = scratchDir();
    const disabled = suppressNonOffered(["run_command_readonly"], registryFns);
    try {
      await expect(runPromptAudit({ capturesDir: dir, ARM: "B", only: null, runStamp: 4000 })).rejects.toThrow(
        /offered set is .*expected exactly \[read_file, run_command_readonly\]/
      );
    } finally {
      restoreSuppressed(disabled, { registerTool: registerToolDist });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The two divergences below were established by comparing the audit's output against a
  // real-call-site reconstruction, traced field by field from agentLoop.ts's own
  // assembleAgentSystemPrompt call site: agentIntro was a shorter, unrelated hardcoded
  // string, and projectMemoryBlock was omitted, so both dumps carried an assembled prompt
  // no real run of this instrument's own configuration would ever produce.

  it("agentIntro matches the real call site's own literal for this configuration", async () => {
    const dir = scratchDir();
    try {
      const audit = await runPromptAudit({ capturesDir: dir, ARM: "B", only: null, runStamp: 5000 });
      expect(audit.sysNoNotice.startsWith("You are Zone, an AI code agent.")).toBe(true);
      expect(audit.sysWithNotice.startsWith("You are Zone, an AI code agent.")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("project memory reaches the audit exactly as the real call site reads it, and degrades the same way when absent", async () => {
    const dir = scratchDir();
    // Item 159: the real .zone/memory.md is untracked and absent on a fresh CI checkout
    // — asserting against its live prose (the previous "## Project" heading check) made
    // this test pass locally and fail on CI. A fixture with a marker this test owns
    // proves the same plumbing without depending on what today's live file happens to
    // say, or on it existing at all.
    const MARKER = "ZONE-PROBE-FIXTURE-MEMORY-MARKER-7f3a";
    const memDir = memoryFixtureDir(MARKER);
    try {
      const audit = await runPromptAudit({
        capturesDir: dir, ARM: "B", only: null, runStamp: 5001,
        memoryRepoPath: memDir, renderedRepoPath: FIXTURE_REPO_PATH,
      });
      expect(audit.sysNoNotice).toContain(MARKER);

      // The exact function runPromptAudit calls, pointed at a directory with no memory
      // file: confirms the ENOENT path it wraps degrades to "" rather than throwing,
      // matching agentLoop.ts's own try/catch around this same call.
      const emptyRepoDir = mkdtempSync(path.join(tmpdir(), "notice-regression-no-memory-"));
      try {
        const block = await readProjectMemoryBlock(emptyRepoDir);
        expect(block).toBe("");
      } finally {
        rmSync(emptyRepoDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  it("the audit's no-notice output is byte-identical to a reference built independently from the real call site's own field values", async () => {
    const dir = scratchDir();
    // Item 159: the previous version of this fixture read the live, untracked
    // .zone/memory.md (via process.cwd()) AND rendered the real, machine-dependent
    // repoPath into the prompt (runPromptAudit's own REPO constant). Both are absent
    // or different-length on a fresh CI checkout — confirmed by reproducing the CI
    // condition in a detached worktree: the live file is genuinely absent there, and
    // the worktree's own longer absolute path alone shifted this length by exactly the
    // path's own extra character count. A fixture directory and a fixed literal
    // repoPath make both sides of this comparison depend on nothing outside the test.
    const MARKER = "ZONE-PROBE-FIXTURE-MEMORY-MARKER-7f3a";
    const memDir = memoryFixtureDir(MARKER);
    try {
      const audit = await runPromptAudit({
        capturesDir: dir, ARM: "B", only: null, runStamp: 5002,
        memoryRepoPath: memDir, renderedRepoPath: FIXTURE_REPO_PATH,
      });

      // Independently constructed: its own call to readProjectMemoryBlock and
      // resolveToolList, not a reuse of anything runPromptAudit computed — the two
      // invocations share only the imported functions, not a construction path, which is
      // what makes this comparison non-tautological.
      const off = resolveToolList(buildDispatcherCapabilityFilter({ ...QUESTION_PIPELINE }))
        .map((t) => t.name)
        .sort();
      const mem = await readProjectMemoryBlock(memDir);
      const reference = assembleAgentSystemPrompt({
        agentIntro: "You are Zone, an AI code agent.",
        frameworkLines: [],
        hasFramework: false,
        projectMemoryBlock: mem,
        importContextSummary: undefined,
        baseMaxIterations: QUESTION_PIPELINE.iterCap,
        canRunCommand: false,
        backgroundCommandBlock: "",
        repoPath: FIXTURE_REPO_PATH,
        planProgressBlock: "",
        planAnnotationsBlock: "",
        archetype: "question",
        planApproved: undefined,
        offeredToolNames: new Set(off),
        toolAbsenceBlock: "",
      });

      // Pinned as a length assertion alongside the full-string equality below, so a
      // future change that preserves byte-identity by both sides drifting together
      // still surfaces here. Item 155's justification, now against a fixture the test
      // fully controls rather than the live memory file: both sides read the same
      // fixture independently, so a change to the fixture (or to shared prompt-assembly
      // text) that moves both sides together in a way that still leaves them equal to
      // EACH OTHER is exactly what the length assertion, not the equality assertion,
      // would catch. When this goes red: confirm the equality assertion below still
      // passes on its own before updating the number.
      expect(audit.sysNoNotice.length).toBe(7099);
      expect(audit.sysNoNotice).toBe(reference);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(memDir, { recursive: true, force: true });
    }
  });
});
