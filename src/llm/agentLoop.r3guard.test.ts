/**
 * Phase R.3 regression guards: ensure prompt + tool trimming did not
 * remove Phase Q safety signals and that future edits cannot re-bloat
 * the prompt or any tool description past these bounds.
 */

import { describe, expect, it } from "vitest";
import { assembleAgentSystemPrompt, buildPlanAnnotationsBlock } from "./agentLoop.js";
import { ZONE_TOOLS } from "../tools/toolDefinitions.js";

function basePrompt(overrides: Partial<Parameters<typeof assembleAgentSystemPrompt>[0]> = {}) {
  return assembleAgentSystemPrompt({
    agentIntro: "You are Zone, an AI code agent.",
    frameworkLines: [],
    hasFramework: false,
    projectMemoryBlock: "",
    baseMaxIterations: 25,
    canRunCommand: true,
    backgroundCommandBlock: "",
    repoPath: "/tmp/repo",
    planProgressBlock: "PLAN VISIBILITY (TodoWrite):\n…",
    planAnnotationsBlock: "",
    ...overrides,
  });
}

describe("R.3 — Phase Q safety signal preservation", () => {
  it("Q.5 exit_code authority signal is present", () => {
    const p = basePrompt();
    expect(p).toMatch(/exit_code/i);
    expect(p).toContain("INTERPRETING COMMAND OUTPUT");
    expect(p).toContain("exit_code=0");
  });

  it("Q.6 subagentEligible reference is present in TASK SUBAGENTS section", () => {
    const p = basePrompt();
    expect(p).toContain("TASK SUBAGENTS");
    expect(p).toContain("subagentEligible");
  });

  it("Q.3 all three dispatch reason prefixes are present", () => {
    const p = basePrompt();
    expect(p).toContain("multi_file_fanout");
    expect(p).toContain("exploration");
    expect(p).toContain("long_isolated_step");
    expect(p).toContain("DISPATCH REASON");
  });

  it("Q.3 MAX_SUBAGENT_CALLS=2 cap reminder is present", () => {
    const p = basePrompt();
    expect(p).toContain("MAX_SUBAGENT_CALLS=2");
  });

  it("Q.5b all five ZONE_VERIFICATION verdicts are present", () => {
    const p = basePrompt();
    expect(p).toContain("ZONE_VERIFICATION: tests_passed");
    expect(p).toContain("ZONE_VERIFICATION: tests_skipped_no_infra");
    expect(p).toContain("ZONE_VERIFICATION: tests_inconclusive");
    expect(p).toContain("ZONE_VERIFICATION: tests_failed_unrelated");
    expect(p).toContain("ZONE_VERIFICATION: tests_failed_by_patch");
  });

  it("Q.4 truncation marker handling is present", () => {
    const p = basePrompt();
    expect(p).toContain("ZONE_CONTEXT_TRUNCATED");
  });

  it("Q.6 PLAN ANNOTATIONS block injection point is intact when a block is provided", () => {
    const annotationsBlock = "PLAN ANNOTATIONS — delegatable steps:\n- Step 1 (worker): Fanout";
    const p = basePrompt({ planAnnotationsBlock: annotationsBlock });
    expect(p).toContain("PLAN ANNOTATIONS");
    const annIdx = p.indexOf("PLAN ANNOTATIONS");
    const patchIdx = p.indexOf("PATCH RULES");
    expect(annIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeGreaterThan(annIdx);
  });

  it("Q.6 PLAN ANNOTATIONS block string is NOT present when no block is provided", () => {
    const p = basePrompt({ planAnnotationsBlock: "" });
    expect(p).not.toContain("PLAN ANNOTATIONS");
  });

  it("apply-by-default semantics are intact: apply_patch for existing, write_file for new", () => {
    const p = basePrompt();
    expect(p).toMatch(/apply_patch/);
    expect(p).toMatch(/write_file/);
    expect(p).toMatch(/EXISTING file/i);
    expect(p).toMatch(/new file/i);
  });

  it("ELIDED READS guidance (R.2) is intact", () => {
    const p = basePrompt();
    expect(p).toContain("ELIDED READS");
  });
});

describe("R.3 — prompt size bounds (regression guard)", () => {
  it("base system prompt char count is in [3000, 9000] (was ~16,230 pre-R.3)", () => {
    const p = basePrompt();
    expect(p.length).toBeGreaterThan(3000);
    expect(p.length).toBeLessThan(9000);
  });
});

describe("R.3 — tool description bounds", () => {
  it("every tool has a non-empty description", () => {
    for (const tool of ZONE_TOOLS) {
      const desc = tool.function.description ?? "";
      expect(desc.length, `${tool.function.name} description must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("no single tool description exceeds 800 chars (regression guard)", () => {
    for (const tool of ZONE_TOOLS) {
      const desc = tool.function.description ?? "";
      expect(
        desc.length,
        `${tool.function.name} description length (${desc.length}) exceeds R.3 budget`
      ).toBeLessThanOrEqual(800);
    }
  });

  it("cumulative tool descriptions stay under 4000 chars (was ~7400 pre-R.3)", () => {
    let total = 0;
    for (const tool of ZONE_TOOLS) {
      total += (tool.function.description ?? "").length;
    }
    expect(total).toBeLessThan(4000);
  });

  it("tool names are unchanged (sentinel registry)", () => {
    const names = ZONE_TOOLS.map((t) => t.function.name).sort();
    expect(names).toEqual(
      [
        "TodoWrite",
        "Task",
        "apply_patch",
        "find_references",
        "kill_background",
        "list_background",
        "list_files",
        "read_background_output",
        "read_file",
        "run_command",
        "run_command_background",
        "search_in_files",
        "update_memory",
        "verify_visual",
        "write_file",
      ].sort()
    );
  });
});

describe("R.3 — TASK SUBAGENTS section GOOD/BAD signal structure preserved", () => {
  it("GOOD signals header and BAD signals header are present", () => {
    const p = basePrompt();
    expect(p).toContain("GOOD signals");
    expect(p).toContain("BAD signals");
  });

  it("buildPlanAnnotationsBlock still produces inline block for marked steps", () => {
    const block = buildPlanAnnotationsBlock({
      steps: [
        {
          title: "Fanout step",
          description: "rename across files",
          filesLikely: ["a.ts", "b.ts", "c.ts"],
          subagentEligible: true,
          subagentType: "worker",
        },
      ],
    } as unknown as Parameters<typeof buildPlanAnnotationsBlock>[0]);
    expect(block).toContain("PLAN ANNOTATIONS");
    expect(block).toContain("worker");
  });
});
