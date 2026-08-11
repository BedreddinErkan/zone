import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { taskAssertsProblem, isPureAddition, matchedLeadVerb, problemWordsPresent } from "./taskShape.js";
import { synthesizeMinimalPlan } from "./executionPlan.js";

describe("taskAssertsProblem", () => {
  const cases: [string, boolean][] = [
    // Additive lead-verb → false (regardless of problem words in the rest)
    ["create a hello.ts file", false],
    ["add error handling", false],      // "error" present but additive lead wins
    ["implement pagination", false],
    ["build a new dashboard", false],
    ["scaffold the auth module", false],
    ["refactor the auth module", false],
    ["rename UserService to AccountService", false],
    ["extract helper function", false],
    ["migrate database schema", false],
    ["write unit tests", false],
    ["make a login page", false],
    // Problem-word present, no additive lead → true
    ["fix the build error", true],
    ["why does X crash", true],
    ["the build is broken", true],
    ["app fails on startup", true],
    ["debug the failing test", true],
    ["exception thrown in auth middleware", true],
    ["regression in the payment flow", true],
    // No additive lead, no problem word → false (default safe)
    ["update the docs", false],
    ["show all endpoints", false],
    ["list the current routes", false],
  ];

  for (const [task, expected] of cases) {
    it(`${JSON.stringify(task)} → ${expected}`, () => {
      expect(taskAssertsProblem(task)).toBe(expected);
    });
  }
});

describe("problemWordsPresent", () => {
  const cases: [string, boolean][] = [
    // Six structural verbs, bare — no additive short-circuit, but also no problem word.
    ["make a login page", false],
    ["refactor the auth module", false],
    ["rename UserService to AccountService", false],
    ["extract helper function", false],
    ["migrate database schema", false],
    ["convert the script to TS", false],
    // Same six, each with a problem word added — taskAssertsProblem would say false
    // for all six; this predicate does not have that short-circuit.
    ["make the parser robust, it is broken", true],
    ["refactor the auth module, it has a bug", true],
    ["rename UserService, it has a stale name", true],
    ["extract helper function, the current one is broken", true],
    ["migrate database schema, current one has a bug", true],
    ["convert the script, it is broken", true],
    // Pure addition + problem word: true here (unlike taskAssertsProblem), which is
    // exactly why the E8a/E8b call sites pair this with !isPureAddition rather than
    // using this predicate alone.
    ["add error handling", true],
    // Pure addition, no problem word.
    ["add a helper", false],
  ];

  for (const [task, expected] of cases) {
    it(`${JSON.stringify(task)} → ${expected}`, () => {
      expect(problemWordsPresent(task)).toBe(expected);
    });
  }
});

describe("matchedLeadVerb", () => {
  const cases: [string, string | null][] = [
    ["add a helper function", "add"],
    ["Set up the CI pipeline", "set up"], // full matched phrase, not a bare first word
    ["ADD a file", "add"], // case-insensitive, returned lowercased
    ["why does X fail", null], // problem-shaped, no lead-verb match
    ["make X robust", null], // "make" deliberately excluded from PURE_ADDITION_LEAD_VERBS
    ["refactor the auth module", null], // structural verb, not pure-addition
    ["update the docs", null], // no recognized lead verb at all
  ];

  for (const [task, expected] of cases) {
    it(`${JSON.stringify(task)} → ${JSON.stringify(expected)}`, () => {
      expect(matchedLeadVerb(task)).toBe(expected);
    });
  }
});

describe("isPureAddition — preamble stripping (anchor-defeat fix)", () => {
  // Twelve frozen base tasks the fix was measured against: seven ground tasks
  // from rankerBaseline.snapshot.json, five from scripts/sweep-tasks.json.
  // Read at runtime rather than hand-transcribed, so this test cannot drift
  // from the actual frozen corpus by a transcription error.
  const groundTasks = JSON.parse(
    readFileSync(path.join(process.cwd(), "src", "repo", "rankerBaseline.snapshot.json"), "utf8")
  ).tasks as Array<{ id: string; task: string }>;
  const sweepTasks = JSON.parse(
    readFileSync(path.join(process.cwd(), "scripts", "sweep-tasks.json"), "utf8")
  ).tasks as Array<{ id: string; description: string }>;

  const BASE_TASKS: Record<string, string> = {};
  for (const t of groundTasks) BASE_TASKS[`ground:${t.id}`] = t.task.replace(/\n/g, " ").trim();
  for (const t of sweepTasks) BASE_TASKS[`sweep:${t.id}`] = t.description.replace(/\n/g, " ").trim();

  // Expected verdict per base task — unchanged by any same-intent rephrasing.
  const EXPECTED: Record<string, boolean> = {
    "ground:T1": false, "ground:T2": false, "ground:T3": false, "ground:T4": false,
    "ground:T5": false, "ground:T6": false, "ground:T7": false,
    "sweep:T1-comment-add": true,
    // "rename" is deliberately excluded from PURE_ADDITION_LEAD_VERBS
    // (structural) — the locative prefix this task also opens with is not
    // why it was false, and stripping it does not change that.
    "sweep:T2-single-file-rename": false,
    // Was false pre-fix — the locative clause defeated the anchor on "add".
    "sweep:T3-two-file-addition": true,
    "sweep:T4-direct-typecheck-break": true,
    "sweep:T5-tier-force-simple": false,
  };

  // The same four rephrasing templates the establish pass measured reaching
  // this router.
  const REPHRASINGS: Array<[string, (t: string) => string]> = [
    ["polite-prefix", (t) => `Please ${t[0]!.toLowerCase()}${t.slice(1)}`],
    ["request-frame", (t) => `I need you to ${t[0]!.toLowerCase()}${t.slice(1)}`],
    ["question-frame", (t) => `Can you ${t[0]!.toLowerCase()}${t.slice(1)}?`],
    ["lead-hedge", (t) => `Let's ${t[0]!.toLowerCase()}${t.slice(1)}`],
  ];

  // 60 assertions: one per base task, one per (task x rephrasing) pair. Every
  // additive task's expected verdict is true across all five rows (base + 4
  // rephrasings) — the fixed direction. Every non-additive or structural-verb
  // task's expected verdict is false across all five — the too-loose guard: a
  // mutation that widened the anchor to match mid-sentence, or made stripping
  // too permissive, fails here, not only on the additive rows.
  for (const [id, task] of Object.entries(BASE_TASKS)) {
    const expected = EXPECTED[id]!;
    it(`${id} (base) → isPureAddition === ${expected}`, () => {
      expect(isPureAddition(task)).toBe(expected);
    });
    for (const [label, rephrase] of REPHRASINGS) {
      it(`${id}/${label} → isPureAddition === ${expected} (same-intent rephrasing must not change the verdict)`, () => {
        expect(isPureAddition(rephrase(task))).toBe(expected);
      });
    }
  }

  it('sweep:T3-two-file-addition (base): matchedLeadVerb becomes "add" (was null pre-fix)', () => {
    expect(matchedLeadVerb(BASE_TASKS["sweep:T3-two-file-addition"]!)).toBe("add");
  });

  it('sweep:T2-single-file-rename (base): matchedLeadVerb stays null — "rename" is not a pure-addition verb', () => {
    expect(matchedLeadVerb(BASE_TASKS["sweep:T2-single-file-rename"]!)).toBeNull();
  });
});

describe("synthesizeMinimalPlan", () => {
  it("extracts explicit path tokens from task into filesLikely", () => {
    const plan = synthesizeMinimalPlan("create src/foo.ts");
    expect(plan.steps[0]!.filesLikely).toContain("src/foo.ts");
  });

  it("includes relevantFiles when no path token in task", () => {
    const plan = synthesizeMinimalPlan("implement a login page", ["src/auth.ts", "src/ui.tsx"]);
    expect(plan.steps[0]!.filesLikely).toContain("src/auth.ts");
    expect(plan.steps[0]!.filesLikely).toContain("src/ui.tsx");
  });

  it("merges task path tokens and relevantFiles without duplicates", () => {
    const plan = synthesizeMinimalPlan("create src/auth.ts", ["src/auth.ts", "src/index.ts"]);
    const files = plan.steps[0]!.filesLikely;
    expect(files.filter(f => f === "src/auth.ts")).toHaveLength(1); // no duplicate
    expect(files).toContain("src/index.ts");
  });

  it("always returns non-empty steps", () => {
    const plan = synthesizeMinimalPlan("vague task with no file");
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it("hello.ts appears in filesLikely for 'make hello.ts'", () => {
    const plan = synthesizeMinimalPlan("make hello.ts");
    expect(plan.steps[0]!.filesLikely).toContain("hello.ts");
  });

  it("caps relevantFiles to 3", () => {
    const plan = synthesizeMinimalPlan("no task tokens", [
      "a.ts", "b.ts", "c.ts", "d.ts", "e.ts",
    ]);
    // Only first 3 relevantFiles used; result de-duped
    expect(plan.steps[0]!.filesLikely.length).toBeLessThanOrEqual(3);
  });
});
