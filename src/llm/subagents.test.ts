import { describe, expect, it } from "vitest";
import { ZONE_TOOLS } from "../tools/toolDefinitions.js";
import {
  AUDIT_ALLOWED_TOOLS,
  EXPLORE_ALLOWED_TOOLS,
  WORKER_ALLOWED_TOOLS,
  formatSubagentToolResultForParent,
  getSubagentCallCount,
  incrementSubagentCallCount,
  parseWorkerSummary,
  resetSubagentCallCount,
  subagentTypeAllowedTools,
  subagentTypeMaxIterations,
} from "./subagents.js";
import { buildWorkerAgentIntro, buildExploreAgentIntro } from "./agentLoop.js";

describe("subagent helpers", () => {
  it("tracks and resets subagent call budget per parent run", () => {
    resetSubagentCallCount("run-1");
    resetSubagentCallCount("run-2");

    expect(getSubagentCallCount("run-1")).toBe(0);
    expect(incrementSubagentCallCount("run-1")).toBe(1);
    expect(incrementSubagentCallCount("run-1")).toBe(2);
    expect(incrementSubagentCallCount("run-2")).toBe(1);
    expect(getSubagentCallCount("run-1")).toBe(2);

    resetSubagentCallCount("run-1");
    expect(getSubagentCallCount("run-1")).toBe(0);
    expect(getSubagentCallCount("run-2")).toBe(1);
  });

  it("parses a well-formed worker summary", () => {
    const parsed = parseWorkerSummary(
      [
        "SUMMARY: Added validation and updated the save handler. The component now reports invalid state.",
        "FILES_MODIFIED: src/App.tsx, src/lib/save.ts",
        "STATUS: success",
        "NOTES: Verification is left to the parent.",
      ].join("\n")
    );

    expect(parsed).toEqual({
      status: "success",
      summary:
        "Added validation and updated the save handler. The component now reports invalid state.",
      filesModified: ["src/App.tsx", "src/lib/save.ts"],
      notes: "Verification is left to the parent.",
    });
  });

  it("falls back to partial status for malformed worker output", () => {
    const parsed = parseWorkerSummary("I changed the requested files but forgot the block.");

    expect(parsed.status).toBe("partial");
    expect(parsed.summary).toBe("I changed the requested files but forgot the block.");
    expect(parsed.filesModified).toEqual([]);
  });

  it("keeps the worker whitelist aligned with the tool catalog", () => {
    const catalogNames = new Set(
      ZONE_TOOLS.map((tool) => tool.function?.name).filter(Boolean)
    );
    const missing = [...WORKER_ALLOWED_TOOLS].filter((name) => !catalogNames.has(name));

    expect(missing).toEqual([]);
  });

  it("documents PR 3 staging-isolation limitation for worker writes", () => {
    expect(WORKER_ALLOWED_TOOLS.has("apply_patch")).toBe(true);
    expect(WORKER_ALLOWED_TOOLS.has("write_file")).toBe(true);
  });

  it("subagentTypeAllowedTools routes correctly", () => {
    expect(subagentTypeAllowedTools("worker")).toBe(WORKER_ALLOWED_TOOLS);
    expect(subagentTypeAllowedTools("explore")).toBe(EXPLORE_ALLOWED_TOOLS);
  });

  it("subagentTypeMaxIterations routes correctly", () => {
    // K.2: worker floor tightened 20 → 6 (defensive cap); explore floor stays 15.
    expect(subagentTypeMaxIterations("worker")).toBe(6); // K.2: tightened from 20 to 6 (defensive)
    expect(subagentTypeMaxIterations("explore")).toBe(15);
  });

  it("formats a failed worker as a terminal successful Task tool result", () => {
    const result = formatSubagentToolResultForParent(
      {
        success: false,
        summary: [
          "SUMMARY: Worker hit its iteration budget before completing the edit.",
          "FILES_MODIFIED: none",
          "STATUS: failed",
          "NOTES: Parent should continue directly instead of spawning another worker.",
        ].join("\n"),
        toolCallLog: [],
        filesModified: [],
        patchValidatedByAgent: false,
        verificationReason: "no_verification_attempted",
        tokenUsage: {
          input: 100,
          output: 25,
          cached: 40,
          total: 125,
          perIter: [60, 65],
        },
      },
      "worker-1",
      "parent-run-1"
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      subagentId: "worker-1",
      parentRunId: "parent-run-1",
      status: "failed",
      summary: "Worker hit its iteration budget before completing the edit.",
      tokenUsage: {
        input: 100,
        output: 25,
        cached: 40,
        total: 125,
        perIter: [60, 65],
      },
      filesModified: [],
      notes: "Parent should continue directly instead of spawning another worker.",
    });
  });

  it("Worker max_iter label: status is max_iterations (not failed) when terminationReason is max_iterations", () => {
    // A worker that hit its iteration cap gets status "max_iterations" so the UI
    // can render "ITER CAP" (amber) instead of "FAILED" (red), distinguishing a
    // tier-limit termination from a genuine failure.
    const maxIterResult = formatSubagentToolResultForParent(
      {
        success: false,
        summary: "Partial progress made; iteration limit reached before completing.",
        toolCallLog: [],
        filesModified: [],
        patchValidatedByAgent: false,
        verificationReason: "no_verification_attempted",
        terminationReason: "max_iterations",
      },
      "worker-max",
      "parent-run-x"
    );
    expect(JSON.parse(maxIterResult.output)).toMatchObject({ status: "max_iterations" });

    // Genuine failure (no terminationReason) still emits status "failed".
    const genuineFailResult = formatSubagentToolResultForParent(
      {
        success: false,
        summary: "Encountered an unexpected error.",
        toolCallLog: [],
        filesModified: [],
        patchValidatedByAgent: false,
        verificationReason: "no_verification_attempted",
      },
      "worker-err",
      "parent-run-x"
    );
    expect(JSON.parse(genuineFailResult.output)).toMatchObject({ status: "failed" });
  });

  it("formats missing token usage as a required zeroed tokenUsage payload", () => {
    const result = formatSubagentToolResultForParent(
      {
        success: true,
        summary: [
          "SUMMARY: Completed the delegated edit.",
          "FILES_MODIFIED: src/App.tsx",
          "STATUS: success",
        ].join("\n"),
        toolCallLog: [],
        filesModified: ["src/App.tsx"],
        patchValidatedByAgent: false,
        verificationReason: "no_verification_attempted",
      },
      "worker-2",
      "parent-run-2"
    );

    expect(JSON.parse(result.output)).toMatchObject({
      subagentId: "worker-2",
      parentRunId: "parent-run-2",
      status: "completed",
      tokenUsage: {
        input: 0,
        output: 0,
        cached: 0,
        total: 0,
        perIter: [],
      },
    });
  });

  it("K.6: costUsd is serialized into worker Task tool result", () => {
    const result = formatSubagentToolResultForParent(
      {
        success: true,
        summary: [
          "SUMMARY: Patched the handler.",
          "FILES_MODIFIED: src/handler.ts",
          "STATUS: completed",
        ].join("\n"),
        toolCallLog: [],
        filesModified: ["src/handler.ts"],
        patchValidatedByAgent: true,
        verificationReason: "tests_passed",
        tokenUsage: { input: 50000, output: 5000, cached: 40000, total: 55000 },
        costUsd: 0.045,
      },
      "worker-k6",
      "parent-run-k6"
    );

    const parsed = JSON.parse(result.output);
    expect(parsed.costUsd).toBe(0.045);
    expect(parsed.subagentId).toBe("worker-k6");
  });

  it("K.6: costUsd defaults to 0 when not provided by AgentLoopResult", () => {
    const result = formatSubagentToolResultForParent(
      {
        success: true,
        summary: ["SUMMARY: Done.", "FILES_MODIFIED: none", "STATUS: completed"].join("\n"),
        toolCallLog: [],
        filesModified: [],
        patchValidatedByAgent: false,
        verificationReason: "no_verification_attempted",
      },
      "worker-no-cost",
      "parent-run-no-cost"
    );

    expect(JSON.parse(result.output).costUsd).toBe(0);
  });
});

describe("K.4: subagent prompt no-recursive-dispatch rules", () => {
  it("worker agentIntro contains TASK TOOL FORBIDDEN", () => {
    const prompt = buildWorkerAgentIntro();
    expect(prompt).toMatch(/TASK TOOL FORBIDDEN/);
  });

  it("worker agentIntro forbids dispatching other subagents", () => {
    const prompt = buildWorkerAgentIntro();
    expect(prompt).toMatch(/CANNOT dispatch other subagents/);
  });

  it("worker agentIntro states recursive dispatch is NEVER appropriate", () => {
    const prompt = buildWorkerAgentIntro();
    expect(prompt).toMatch(/Recursive subagent dispatch is NEVER appropriate/);
  });

  it("explore agentIntro contains TASK TOOL FORBIDDEN", () => {
    const prompt = buildExploreAgentIntro();
    expect(prompt).toMatch(/TASK TOOL FORBIDDEN/);
  });

  it("explore agentIntro forbids dispatching other subagents", () => {
    const prompt = buildExploreAgentIntro();
    expect(prompt).toMatch(/CANNOT dispatch other subagents/);
  });

  it("explore agentIntro states recursive dispatch is NEVER appropriate", () => {
    const prompt = buildExploreAgentIntro();
    expect(prompt).toMatch(/Recursive subagent dispatch is NEVER appropriate/);
  });

  it("Task is absent from WORKER_ALLOWED_TOOLS (defensive by omission)", () => {
    expect(WORKER_ALLOWED_TOOLS.has("Task")).toBe(false);
  });

  it("Task is absent from EXPLORE_ALLOWED_TOOLS (defensive by omission)", () => {
    expect(EXPLORE_ALLOWED_TOOLS.has("Task")).toBe(false);
  });

  it("Phase G: AUDIT_ALLOWED_TOOLS includes run_command_readonly", () => {
    expect(AUDIT_ALLOWED_TOOLS.has("run_command_readonly")).toBe(true);
  });

  it("Phase G: EXPLORE_ALLOWED_TOOLS does NOT include run_command_readonly (deferred)", () => {
    expect(EXPLORE_ALLOWED_TOOLS.has("run_command_readonly")).toBe(false);
  });

  it("Phase G: WORKER_ALLOWED_TOOLS does NOT include run_command_readonly (deferred)", () => {
    expect(WORKER_ALLOWED_TOOLS.has("run_command_readonly")).toBe(false);
  });
});
