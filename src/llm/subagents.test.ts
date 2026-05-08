import { describe, expect, it } from "vitest";
import { ZONE_TOOLS } from "../tools/toolDefinitions.js";
import {
  WORKER_ALLOWED_TOOLS,
  formatSubagentToolResultForParent,
  getSubagentCallCount,
  incrementSubagentCallCount,
  parseWorkerSummary,
  resetSubagentCallCount,
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
      },
      "worker-1"
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      subagentId: "worker-1",
      status: "failed",
      summary: "Worker hit its iteration budget before completing the edit.",
      filesModified: [],
      notes: "Parent should continue directly instead of spawning another worker.",
    });
  });
});
