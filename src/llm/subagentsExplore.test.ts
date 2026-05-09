import { describe, expect, it } from "vitest";
import { ZONE_TOOLS } from "../tools/toolDefinitions.js";
import {
  EXPLORE_ALLOWED_TOOLS,
  EXPLORE_MAX_ITERATIONS,
  EXPLORE_ITER_FLOOR,
  EXPLORE_ITER_CEILING,
  WORKER_ITER_FLOOR,
  WORKER_ITER_CEILING,
  computeExploreMaxIterations,
  computeWorkerMaxIterations,
  formatExploreSubagentSummaryForParent,
  formatExploreSubagentToolResultForParent,
  parseExploreSummary,
  subagentTypeAllowedTools,
  subagentTypeMaxIterations,
} from "./subagents.js";

describe("EXPLORE_ALLOWED_TOOLS", () => {
  it("includes the expected read-only tools", () => {
    expect(EXPLORE_ALLOWED_TOOLS.has("read_file")).toBe(true);
    expect(EXPLORE_ALLOWED_TOOLS.has("list_files")).toBe(true);
    expect(EXPLORE_ALLOWED_TOOLS.has("search_in_files")).toBe(true);
    expect(EXPLORE_ALLOWED_TOOLS.has("find_references")).toBe(true);
  });

  it("excludes write and execution tools", () => {
    expect(EXPLORE_ALLOWED_TOOLS.has("apply_patch")).toBe(false);
    expect(EXPLORE_ALLOWED_TOOLS.has("write_file")).toBe(false);
    expect(EXPLORE_ALLOWED_TOOLS.has("run_command")).toBe(false);
    expect(EXPLORE_ALLOWED_TOOLS.has("Task")).toBe(false);
    expect(EXPLORE_ALLOWED_TOOLS.has("update_memory")).toBe(false);
  });

  it("all explore tools exist in the tool catalog", () => {
    const catalogNames = new Set(
      ZONE_TOOLS.map((t) => t.function?.name).filter(Boolean)
    );
    const missing = [...EXPLORE_ALLOWED_TOOLS].filter((name) => !catalogNames.has(name));
    expect(missing).toEqual([]);
  });
});

describe("EXPLORE_MAX_ITERATIONS", () => {
  it("equals the EXPLORE_ITER_FLOOR (Phase H.6: bumped 8 → 15 plan-unaware floor)", () => {
    expect(EXPLORE_MAX_ITERATIONS).toBe(15);
  });
});

describe("computeExploreMaxIterations (plan-aware)", () => {
  it("returns floor for single-step plans", () => {
    expect(computeExploreMaxIterations(1)).toBe(EXPLORE_ITER_FLOOR);
  });
  it("scales linearly above the floor", () => {
    expect(computeExploreMaxIterations(4)).toBe(24); // 4 * 6 = 24
    expect(computeExploreMaxIterations(5)).toBe(30); // 5 * 6 = 30
  });
  it("caps at the ceiling", () => {
    expect(computeExploreMaxIterations(20)).toBe(EXPLORE_ITER_CEILING);
  });
  it("treats 0 / negative / NaN as 1 step (floor)", () => {
    expect(computeExploreMaxIterations(0)).toBe(EXPLORE_ITER_FLOOR);
    expect(computeExploreMaxIterations(-3)).toBe(EXPLORE_ITER_FLOOR);
    expect(computeExploreMaxIterations(NaN)).toBe(EXPLORE_ITER_FLOOR);
  });
});

describe("computeWorkerMaxIterations (plan-aware)", () => {
  it("returns floor for single-step plans", () => {
    expect(computeWorkerMaxIterations(1)).toBe(WORKER_ITER_FLOOR);
  });
  it("scales linearly above the floor", () => {
    expect(computeWorkerMaxIterations(4)).toBe(32); // 4 * 8 = 32
    expect(computeWorkerMaxIterations(6)).toBe(48); // 6 * 8 = 48
  });
  it("caps at the ceiling", () => {
    expect(computeWorkerMaxIterations(20)).toBe(WORKER_ITER_CEILING);
  });
});

describe("parseExploreSummary", () => {
  it("parses a well-formed FINDINGS/SUMMARY/STATUS block", () => {
    const raw = [
      "FINDINGS:",
      "- src/llm/agentLoop.ts:1319 — Worker system prompt branch introduced here",
      "- src/tools/toolExecutor.ts:467 — subagent_type routing hard-coded to worker",
      "",
      "SUMMARY: The worker subagent type is branched in two places. Both need updating to support explore.",
      "STATUS: completed",
    ].join("\n");

    const result = parseExploreSummary(raw);

    expect(result.status).toBe("completed");
    expect(result.summary).toBe(
      "The worker subagent type is branched in two places. Both need updating to support explore."
    );
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toEqual({
      path: "src/llm/agentLoop.ts",
      line: 1319,
      note: "Worker system prompt branch introduced here",
    });
    expect(result.findings[1]).toEqual({
      path: "src/tools/toolExecutor.ts",
      line: 467,
      note: "subagent_type routing hard-coded to worker",
    });
    expect(result.rawSummary).toBeUndefined();
  });

  it("handles findings without line numbers", () => {
    const raw = [
      "FINDINGS:",
      "- src/llm/subagents.ts — WORKER_ALLOWED_TOOLS defined here",
      "",
      "SUMMARY: Found the constants file.",
      "STATUS: partial",
    ].join("\n");

    const result = parseExploreSummary(raw);

    expect(result.findings[0]).toEqual({
      path: "src/llm/subagents.ts",
      note: "WORKER_ALLOWED_TOOLS defined here",
    });
    expect(result.findings[0]?.line).toBeUndefined();
  });

  it("falls back gracefully when structured block is absent", () => {
    const raw = "I looked around but couldn't find a clear FINDINGS block to format.";
    const result = parseExploreSummary(raw);

    expect(result.status).toBe("partial");
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe(raw);
    expect(result.rawSummary).toBe(raw);
  });

  it("truncates an excessively long raw fallback summary at 500 chars", () => {
    const raw = "x".repeat(600);
    const result = parseExploreSummary(raw);
    expect(result.summary.length).toBeLessThanOrEqual(500);
  });

  it("handles STATUS: failed", () => {
    const raw = [
      "FINDINGS:",
      "",
      "SUMMARY: Task required file modification which is outside my scope.",
      "STATUS: failed",
    ].join("\n");

    const result = parseExploreSummary(raw);
    expect(result.status).toBe("failed");
    expect(result.findings).toEqual([]);
  });
});

describe("formatExploreSubagentSummaryForParent", () => {
  it("produces a JSON payload with findings array", () => {
    const fakeResult = {
      success: true,
      summary: [
        "FINDINGS:",
        "- src/a.ts:10 — entry point",
        "",
        "SUMMARY: Found the entry point.",
        "STATUS: completed",
      ].join("\n"),
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted" as const,
    };

    const json = formatExploreSubagentSummaryForParent(fakeResult, "explore-1");
    const parsed = JSON.parse(json);

    expect(parsed.subagentId).toBe("explore-1");
    expect(parsed.status).toBe("completed");
    expect(parsed.summary).toBe("Found the entry point.");
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.findings[0]).toMatchObject({ path: "src/a.ts", line: 10, note: "entry point" });
  });

  it("marks status as failed when agentLoop result.success is false", () => {
    const fakeResult = {
      success: false,
      summary: [
        "FINDINGS:",
        "",
        "SUMMARY: Task could not be completed.",
        "STATUS: partial",
      ].join("\n"),
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted" as const,
    };

    const json = formatExploreSubagentSummaryForParent(fakeResult, "explore-2");
    const parsed = JSON.parse(json);
    expect(parsed.status).toBe("failed");
  });

  it("formatExploreSubagentToolResultForParent wraps with success: true", () => {
    const fakeResult = {
      success: true,
      summary: "FINDINGS:\n\nSUMMARY: nothing found.\nSTATUS: partial",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_verification_attempted" as const,
    };

    const toolResult = formatExploreSubagentToolResultForParent(fakeResult, "explore-3");
    expect(toolResult.success).toBe(true);
    const parsed = JSON.parse(toolResult.output);
    expect(Array.isArray(parsed.findings)).toBe(true);
  });
});

describe("subagentTypeAllowedTools / subagentTypeMaxIterations routing", () => {
  it("routes explore → EXPLORE_ALLOWED_TOOLS", () => {
    const tools = subagentTypeAllowedTools("explore");
    expect(tools.has("read_file")).toBe(true);
    expect(tools.has("apply_patch")).toBe(false);
  });

  it("routes explore → EXPLORE_MAX_ITERATIONS", () => {
    expect(subagentTypeMaxIterations("explore")).toBe(15);
  });
});
