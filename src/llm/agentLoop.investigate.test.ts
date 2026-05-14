/**
 * Phase D unit tests: investigation mode — allowedTools enforcement,
 * system prompt content, and natural-termination behaviour.
 */

import { describe, expect, it, vi } from "vitest";
import { assembleInvestigationSystemPrompt } from "./agentLoop.js";
import { EXPLORE_ALLOWED_TOOLS } from "./subagents.js";

// ── allowedTools enforcement via executeTool ─────────────────────────────────

describe("executeTool allowedTools gate (investigate mode contract)", () => {
  it("rejects apply_patch when not in allowed set", async () => {
    const { executeTool } = await import("../tools/toolExecutor.js");
    const allowed = new Set(["read_file", "list_files", "search_in_files", "find_references"]);
    const result = await executeTool("apply_patch", {}, "/tmp", undefined, { allowedTools: allowed });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not in the allowed set/i);
    expect(result.output).toContain("apply_patch");
  });

  it("rejects write_file when not in allowed set", async () => {
    const { executeTool } = await import("../tools/toolExecutor.js");
    const allowed = new Set(["read_file", "list_files", "search_in_files", "find_references"]);
    const result = await executeTool("write_file", { filePath: "x.ts", content: "x" }, "/tmp", undefined, { allowedTools: allowed });
    expect(result.success).toBe(false);
    expect(result.output).toContain("write_file");
  });

  it("rejects run_command when not in allowed set", async () => {
    const { executeTool } = await import("../tools/toolExecutor.js");
    const allowed = new Set(["read_file", "list_files"]);
    const result = await executeTool("run_command", { command: "ls" }, "/tmp", undefined, { allowedTools: allowed });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not in the allowed set/i);
  });
});

// ── EXPLORE_ALLOWED_TOOLS set contents ───────────────────────────────────────

describe("EXPLORE_ALLOWED_TOOLS (investigate tool set)", () => {
  it("includes the four read-only tools", () => {
    expect(EXPLORE_ALLOWED_TOOLS.has("read_file")).toBe(true);
    expect(EXPLORE_ALLOWED_TOOLS.has("list_files")).toBe(true);
    expect(EXPLORE_ALLOWED_TOOLS.has("search_in_files")).toBe(true);
    expect(EXPLORE_ALLOWED_TOOLS.has("find_references")).toBe(true);
  });

  it("excludes write and execution tools", () => {
    expect(EXPLORE_ALLOWED_TOOLS.has("apply_patch")).toBe(false);
    expect(EXPLORE_ALLOWED_TOOLS.has("write_file")).toBe(false);
    expect(EXPLORE_ALLOWED_TOOLS.has("run_command")).toBe(false);
  });
});

// ── investigation system prompt ───────────────────────────────────────────────

describe("assembleInvestigationSystemPrompt", () => {
  const baseInput = {
    repoPath: "/repo",
    projectMemoryBlock: "",
    baseMaxIterations: 15,
  };

  it("mentions read-only / investigation mode", () => {
    const prompt = assembleInvestigationSystemPrompt(baseInput);
    expect(prompt.toLowerCase()).toMatch(/read-only/);
  });

  it("lists find_references and search_in_files as available tools", () => {
    const prompt = assembleInvestigationSystemPrompt(baseInput);
    expect(prompt).toContain("find_references");
    expect(prompt).toContain("search_in_files");
  });

  it("instructs agent not to write or modify code", () => {
    const prompt = assembleInvestigationSystemPrompt(baseInput);
    expect(prompt.toLowerCase()).toMatch(/do not (write|modify)/);
  });

  it("instructs agent to cite file paths with line numbers", () => {
    const prompt = assembleInvestigationSystemPrompt(baseInput);
    expect(prompt).toMatch(/line number|file path/i);
  });
});
