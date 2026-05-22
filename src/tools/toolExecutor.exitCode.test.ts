/**
 * Phase Q.5 unit tests: exit_code authority in run_command results.
 *
 * The run_command tool result must:
 * 1. Include an explicit exitCode field (ToolResult.exitCode)
 * 2. Prepend an exit_code header to the output string
 * 3. success === (exitCode === 0) for backward compat
 * 4. Emit a "pre-existing failures" message on exitCode=0 + test-failure output
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";
import { assembleAgentSystemPrompt } from "../llm/agentLoop.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-q5-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("run_command exitCode field (Q.5)", () => {
  it("sets exitCode=0 and success=true when command exits 0", async () => {
    const result = await executeTool("run_command", { command: "exit 0" }, repoPath);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("sets exitCode=1 and success=false when command exits non-zero", async () => {
    const result = await executeTool("run_command", { command: "exit 1" }, repoPath);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("success === (exitCode === 0) — backward-compat invariant", async () => {
    const pass = await executeTool("run_command", { command: "exit 0" }, repoPath);
    const fail = await executeTool("run_command", { command: "exit 2" }, repoPath);
    expect(pass.success).toBe(pass.exitCode === 0);
    expect(fail.success).toBe(fail.exitCode === 0);
  });

  it("output starts with [exit_code=0 ...] header on success", async () => {
    const result = await executeTool("run_command", { command: "exit 0" }, repoPath);
    expect(result.output).toMatch(/^\[exit_code=0/);
  });

  it("output starts with [exit_code=N ...] header on failure", async () => {
    const result = await executeTool("run_command", { command: "exit 3" }, repoPath);
    expect(result.output).toMatch(/^\[exit_code=3/);
  });

  it("output header on success says 'command succeeded'", async () => {
    const result = await executeTool("run_command", { command: "exit 0" }, repoPath);
    expect(result.output.toLowerCase()).toContain("command succeeded");
  });

  it("output header on failure says 'command failed'", async () => {
    const result = await executeTool("run_command", { command: "exit 1" }, repoPath);
    expect(result.output.toLowerCase()).toContain("command failed");
  });

  it("emits pre-existing-failure header when exitCode=0 and output has Jest test-failure pattern", async () => {
    // Simulate exitCode=0 command that prints test failure text — use echo
    const result = await executeTool(
      "run_command",
      { command: `echo "Tests: 5 failed, 10 passed, 15 total"` },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    // Should get the pre-existing failure specific header
    expect(result.output).toContain("pre-existing");
    expect(result.output).toContain("Do not retry");
  });

  it("uses generic informational header when exitCode=0 and output has no test-failure patterns", async () => {
    const result = await executeTool(
      "run_command",
      { command: `echo "Build successful"` },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("informational");
    expect(result.output).not.toContain("pre-existing");
  });
});

describe("agent system prompt — INTERPRETING COMMAND OUTPUT section (Q.5)", () => {
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

  it("includes INTERPRETING COMMAND OUTPUT section", () => {
    expect(prompt).toContain("INTERPRETING COMMAND OUTPUT");
  });

  it("instructs agent to trust exit_code=0 and not retry", () => {
    expect(prompt).toContain("exit_code=0");
    expect(prompt.toLowerCase()).toContain("do not retry");
  });

  it("explains that output content may contain pre-existing failures", () => {
    expect(prompt).toContain("pre-existing");
  });

  it("tells agent to scope test-failure concern to files it modified", () => {
    // Prompt uses "the files you\nmodified" split across template lines
    expect(prompt.toLowerCase()).toContain("files you");
    expect(prompt.toLowerCase()).toContain("modified");
  });
});
