/**
 * Cross-site agreement for the dispatch-reason vocabulary.
 *
 * Three sites name these prefixes: the parser, the TASK SUBAGENTS system-prompt
 * block, and buildPlanAnnotationsBlock's closing directive. Before this file
 * they carried three independent copies, and the existing tests pinned each
 * side alone — agentLoop.dispatch.test.ts asserts the parser reads a prefix and
 * separately that the prompt contains one, but nothing crossed the two. That is
 * why `focused_diagnosis` could be added to the prompt AND to a test asserting
 * the prompt named it, while the parser never learned it: both tests passed.
 *
 * Every assertion here spans two sites. A test that reads one side only belongs
 * in the other file.
 */
import { describe, expect, it } from "vitest";
import {
  DISPATCH_REASON_FALLBACK,
  DISPATCH_REASON_PREFIXES,
  buildDispatchReasonMatcher,
  extractDispatchReason,
} from "./subagentDispatch.js";
import { assembleAgentSystemPrompt, buildPlanAnnotationsBlock } from "./agentLoop.js";

const PROMPT_INPUT = {
  agentIntro: "You are Zone, an autonomous coding agent.",
  frameworkLines: [] as string[],
  hasFramework: false,
  projectMemoryBlock: "",
  baseMaxIterations: 15,
  canRunCommand: false,
  backgroundCommandBlock: "",
  repoPath: "/tmp/repo",
};

/** The TASK SUBAGENTS block as the model actually receives it. */
function taskSubagentsBlock(): string {
  const prompt = assembleAgentSystemPrompt(PROMPT_INPUT);
  const start = prompt.indexOf("TASK SUBAGENTS");
  // Harness floor: a block this function failed to find would make every
  // "does not contain a bad prefix" assertion below vacuously true.
  expect(start, "TASK SUBAGENTS block absent from the assembled prompt").toBeGreaterThanOrEqual(0);
  const end = prompt.indexOf("\n\n", start);
  expect(end).toBeGreaterThan(start);
  return prompt.slice(start, end);
}

/** The plan-annotations directive as the model actually receives it. */
function planAnnotationsBlock(): string {
  const block = buildPlanAnnotationsBlock({
    steps: [
      {
        title: "Rename detectFramework across five files",
        description: "Apply the same identifier change to every site.",
        filesLikely: ["src/a.ts", "src/b.ts"],
        subagentEligible: true,
        subagentType: "worker",
      },
    ],
  } as unknown as Parameters<typeof buildPlanAnnotationsBlock>[0]);
  // Same floor: an empty block would pass every containment check vacuously.
  expect(block, "plan-annotations block rendered empty").toContain("PLAN ANNOTATIONS");
  return block;
}

/**
 * Lowercase snake_case identifiers appearing anywhere in a prompt block. Any
 * such token is a candidate dispatch prefix to a reader, so each one must be
 * either in the vocabulary or deliberately listed as something else.
 */
function snakeCaseTokens(text: string): string[] {
  return [...text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((m) => m[0]);
}

/**
 * Lowercase snake_case identifiers these blocks legitimately contain that are
 * NOT dispatch prefixes. Kept deliberately short: adding to it is the visible
 * edit that makes "this new token is not a prefix" a decision someone made
 * rather than something that happened.
 */
const NON_PREFIX_TOKENS = new Set(["subagent_type"]);

describe("dispatch-reason vocabulary — parser and prompts cannot diverge", () => {
  it("the parser recognises every prefix the shared vocabulary names", () => {
    for (const prefix of DISPATCH_REASON_PREFIXES) {
      expect(
        extractDispatchReason(`${prefix}: do the thing`),
        `parser does not recognise "${prefix}", which the vocabulary names`
      ).toBe(prefix);
    }
  });

  it("the TASK SUBAGENTS block names every prefix the shared vocabulary names", () => {
    const block = taskSubagentsBlock();
    for (const prefix of DISPATCH_REASON_PREFIXES) {
      expect(block, `TASK SUBAGENTS omits "${prefix}"`).toContain(prefix);
    }
  });

  it("the plan-annotations directive names every prefix the shared vocabulary names", () => {
    const block = planAnnotationsBlock();
    for (const prefix of DISPATCH_REASON_PREFIXES) {
      expect(block, `plan-annotations directive omits "${prefix}"`).toContain(prefix);
    }
  });

  it("neither prompt block names a snake_case token the parser cannot read", () => {
    // The historical catch. `focused_diagnosis` lived in the prompt for months
    // while the parser mapped it to the fallback; this is the assertion that
    // would have failed on the commit that introduced it.
    const vocabulary = new Set<string>(DISPATCH_REASON_PREFIXES);
    for (const [name, block] of [
      ["TASK SUBAGENTS", taskSubagentsBlock()],
      ["plan-annotations", planAnnotationsBlock()],
    ] as const) {
      for (const token of snakeCaseTokens(block)) {
        if (NON_PREFIX_TOKENS.has(token)) continue;
        expect(
          vocabulary.has(token),
          `${name} names "${token}", which is neither in the dispatch vocabulary nor ` +
            `listed as a non-prefix token — the model would be told to use a prefix the parser reads as "${DISPATCH_REASON_FALLBACK}"`
        ).toBe(true);
        expect(extractDispatchReason(`${token}: x`)).toBe(token);
      }
    }
  });

  it("the vocabulary is exactly these three, so a silent addition or removal is a visible edit", () => {
    expect([...DISPATCH_REASON_PREFIXES]).toEqual([
      "multi_file_fanout",
      "exploration",
      "long_isolated_step",
    ]);
  });

  it("the fallback is not itself a prefix — the prompt must never instruct the model to type it", () => {
    expect([...DISPATCH_REASON_PREFIXES]).not.toContain(DISPATCH_REASON_FALLBACK);
    expect(taskSubagentsBlock()).not.toContain(`${DISPATCH_REASON_FALLBACK}:`);
  });
});

describe("the matcher is built from the vocabulary, and escapes it", () => {
  it("every member is lowercase snake_case — the convention the prompt prose relies on", () => {
    for (const prefix of DISPATCH_REASON_PREFIXES) {
      expect(prefix, `"${prefix}" is not lowercase snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("a member carrying a regex metacharacter is matched literally, not as a pattern", () => {
    // Structural half of the guard: this holds even if the convention test above
    // is deleted, because the escaping is in the builder rather than in a rule
    // someone has to remember.
    const matcher = buildDispatchReasonMatcher(["a.c"]);
    expect(matcher.test("a.c: literal dot matches")).toBe(true);
    expect(matcher.test("abc: dot must not match any character")).toBe(false);
  });

  it("alternation members do not leak into each other (anchored, colon-terminated)", () => {
    const matcher = buildDispatchReasonMatcher(["ab", "abc"]);
    expect(matcher.test("abc: longer member still matches")).toBe(true);
    expect(matcher.test("xab: not anchored at start")).toBe(false);
    expect(matcher.test("ab no colon")).toBe(false);
  });
});
