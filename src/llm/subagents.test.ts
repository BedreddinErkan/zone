import { describe, expect, it } from "vitest";
import { ZONE_TOOLS } from "../tools/toolDefinitions.js";
import {
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
    // Phase H.6: floor values bumped to provide more headroom under
    // tool-result compression / lazy-read changes (was 12 worker, 8 explore).
    expect(subagentTypeMaxIterations("worker")).toBe(20);
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
});
