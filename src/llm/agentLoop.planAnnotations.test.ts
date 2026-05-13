/**
 * Phase Q.6 unit tests: plan annotations are rendered into the agent
 * system prompt so the agent can actually see which steps are marked
 * delegatable. Pre-Q.6 the plan annotation only existed in the UI badge
 * and was invisible to the runtime agent.
 */

import { describe, expect, it } from "vitest";
import {
  assembleAgentSystemPrompt,
  buildPlanAnnotationsBlock,
} from "./agentLoop.js";
import type { ExecutionPlan } from "./executionPlan.js";

const makePlan = (
  steps: ExecutionPlan["steps"]
): ExecutionPlan => ({
  objective: "obj",
  steps,
  riskHints: [],
  scopeSummary: "s",
});

describe("buildPlanAnnotationsBlock (Q.6)", () => {
  it("returns empty string when plan is null/undefined", () => {
    expect(buildPlanAnnotationsBlock(null)).toBe("");
    expect(buildPlanAnnotationsBlock(undefined)).toBe("");
  });

  it("returns empty string when no step is marked subagentEligible", () => {
    const plan = makePlan([
      { title: "A", description: "x", filesLikely: ["a.ts"] },
      { title: "B", description: "y", filesLikely: ["b.ts"] },
    ]);
    expect(buildPlanAnnotationsBlock(plan)).toBe("");
  });

  it("renders the block header and one bullet per delegatable step", () => {
    const plan = makePlan([
      { title: "A", description: "x", filesLikely: ["a.ts"] },
      {
        title: "Rename across 5 files",
        description: "fanout",
        filesLikely: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
        subagentEligible: true,
        subagentType: "worker",
      },
      { title: "C", description: "z", filesLikely: ["c.ts"] },
    ]);
    const block = buildPlanAnnotationsBlock(plan);

    expect(block).toContain("PLAN ANNOTATIONS");
    expect(block).toContain("Step 2 (worker)");
    expect(block).toContain("Rename across 5 files");
    expect(block).toContain("src/a.ts, src/b.ts, src/c.ts, src/d.ts, src/e.ts");
    expect(block.toLowerCase()).toContain("prefer task dispatch");
  });

  it("renders multiple delegatable steps with the correct subagent types", () => {
    const plan = makePlan([
      {
        title: "Investigate callers",
        description: "read-only",
        filesLikely: ["src/**/*.ts"],
        subagentEligible: true,
        subagentType: "explore",
      },
      {
        title: "Apply rename",
        description: "fanout",
        filesLikely: ["a.ts", "b.ts", "c.ts"],
        subagentEligible: true,
        subagentType: "worker",
      },
    ]);
    const block = buildPlanAnnotationsBlock(plan);

    expect(block).toContain("Step 1 (explore)");
    expect(block).toContain("Step 2 (worker)");
    expect(block).toContain("Investigate callers");
    expect(block).toContain("Apply rename");
  });

  it("skips half-marked steps (eligible but no type) — those are runtime garbage", () => {
    const plan: ExecutionPlan = {
      objective: "o",
      // simulate a malformed step that escaped normalization
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      steps: [{ title: "X", description: "y", filesLikely: ["x.ts"], subagentEligible: true } as any],
      riskHints: [],
      scopeSummary: "s",
    };
    expect(buildPlanAnnotationsBlock(plan)).toBe("");
  });

  it("mentions the dispatch reason prefixes the agent should use", () => {
    const plan = makePlan([
      {
        title: "Fanout step",
        description: "x",
        filesLikely: ["a.ts", "b.ts", "c.ts"],
        subagentEligible: true,
        subagentType: "worker",
      },
    ]);
    const block = buildPlanAnnotationsBlock(plan);
    expect(block).toContain("multi_file_fanout");
    expect(block).toContain("exploration");
    expect(block).toContain("long_isolated_step");
  });
});

describe("assembleAgentSystemPrompt — Q.6 plan annotation injection", () => {
  it("system prompt omits PLAN ANNOTATIONS when no block is provided", () => {
    const prompt = assembleAgentSystemPrompt({
      agentIntro: "You are Zone.",
      frameworkLines: [],
      hasFramework: false,
      projectMemoryBlock: "",
      baseMaxIterations: 15,
      canRunCommand: false,
      backgroundCommandBlock: "",
      repoPath: "/tmp/repo",
    });
    expect(prompt).not.toContain("PLAN ANNOTATIONS");
  });

  it("system prompt includes the PLAN ANNOTATIONS block when one is passed", () => {
    const plan = makePlan([
      {
        title: "Fanout",
        description: "x",
        filesLikely: ["a.ts", "b.ts", "c.ts"],
        subagentEligible: true,
        subagentType: "worker",
      },
    ]);
    const prompt = assembleAgentSystemPrompt({
      agentIntro: "You are Zone.",
      frameworkLines: [],
      hasFramework: false,
      projectMemoryBlock: "",
      baseMaxIterations: 15,
      canRunCommand: false,
      backgroundCommandBlock: "",
      repoPath: "/tmp/repo",
      planAnnotationsBlock: buildPlanAnnotationsBlock(plan),
    });
    expect(prompt).toContain("PLAN ANNOTATIONS");
    expect(prompt).toContain("Step 1 (worker)");
    expect(prompt).toContain("Fanout");
  });

  it("block appears before the PATCH RULES so coaching has priority order", () => {
    const plan = makePlan([
      {
        title: "FanoutStep",
        description: "x",
        filesLikely: ["a.ts", "b.ts", "c.ts"],
        subagentEligible: true,
        subagentType: "worker",
      },
    ]);
    const prompt = assembleAgentSystemPrompt({
      agentIntro: "You are Zone.",
      frameworkLines: [],
      hasFramework: false,
      projectMemoryBlock: "",
      baseMaxIterations: 15,
      canRunCommand: false,
      backgroundCommandBlock: "",
      repoPath: "/tmp/repo",
      planAnnotationsBlock: buildPlanAnnotationsBlock(plan),
    });
    const planAnnIdx = prompt.indexOf("PLAN ANNOTATIONS");
    const patchRulesIdx = prompt.indexOf("PATCH RULES");
    expect(planAnnIdx).toBeGreaterThan(-1);
    expect(patchRulesIdx).toBeGreaterThan(planAnnIdx);
  });
});
