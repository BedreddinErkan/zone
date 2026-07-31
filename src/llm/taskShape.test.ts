import { describe, it, expect } from "vitest";
import { taskAssertsProblem, matchedLeadVerb } from "./taskShape.js";
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
