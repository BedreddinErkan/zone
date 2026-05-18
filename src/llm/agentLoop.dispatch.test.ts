/**
 * Phase Q.3 unit tests: dispatch reason extraction + system prompt coaching.
 */

import { describe, expect, it } from "vitest";
import {
  assembleAgentSystemPrompt,
  extractDispatchReason,
} from "./agentLoop.js";

describe("extractDispatchReason", () => {
  it("returns multi_file_fanout when description starts with that prefix", () => {
    expect(
      extractDispatchReason("multi_file_fanout: rename foo to bar across 8 files")
    ).toBe("multi_file_fanout");
  });

  it("returns exploration when description starts with that prefix", () => {
    expect(
      extractDispatchReason("exploration: map every caller of authService")
    ).toBe("exploration");
  });

  it("returns long_isolated_step when description starts with that prefix", () => {
    expect(
      extractDispatchReason("long_isolated_step: rewrite the parser module from scratch")
    ).toBe("long_isolated_step");
  });

  it("is case-insensitive on the prefix", () => {
    expect(extractDispatchReason("EXPLORATION: scan deps")).toBe("exploration");
    expect(extractDispatchReason("Multi_File_Fanout: edits")).toBe("multi_file_fanout");
  });

  it("only looks at the first line of the description", () => {
    expect(
      extractDispatchReason(
        "exploration: top line\nmulti_file_fanout: should be ignored on line 2"
      )
    ).toBe("exploration");
  });

  it('falls back to "manual" when no recognizable prefix is present', () => {
    expect(extractDispatchReason("Just go do the thing")).toBe("manual");
    expect(extractDispatchReason("")).toBe("manual");
  });

  it('falls back to "manual" for non-string input (undefined, null, number)', () => {
    expect(extractDispatchReason(undefined)).toBe("manual");
    expect(extractDispatchReason(null)).toBe("manual");
    expect(extractDispatchReason(42)).toBe("manual");
  });

  it("requires the colon — bare keywords do not count", () => {
    expect(extractDispatchReason("multi_file_fanout but no colon")).toBe("manual");
  });
});

describe("assembleAgentSystemPrompt — Q.3 Task coaching", () => {
  it("includes the new Task dispatch coaching section", () => {
    const prompt = assembleAgentSystemPrompt({
      agentIntro: "You are Zone, an autonomous coding agent.",
      frameworkLines: [],
      hasFramework: false,
      projectMemoryBlock: "",
      baseMaxIterations: 15,
      canRunCommand: false,
      backgroundCommandBlock: "",
      repoPath: "/tmp/repo",
    });

    expect(prompt).toContain("TASK SUBAGENTS");
    expect(prompt).toContain("subagentEligible");
    expect(prompt).toContain("multi_file_fanout");
    expect(prompt).toContain("exploration");
    expect(prompt).toContain("long_isolated_step");
    expect(prompt).toContain("focused_diagnosis");
    expect(prompt).toContain("DISPATCH REASON");
  });

  it("documents the GOOD and BAD dispatch signals", () => {
    const prompt = assembleAgentSystemPrompt({
      agentIntro: "You are Zone, an autonomous coding agent.",
      frameworkLines: [],
      hasFramework: false,
      projectMemoryBlock: "",
      baseMaxIterations: 15,
      canRunCommand: false,
      backgroundCommandBlock: "",
      repoPath: "/tmp/repo",
    });

    expect(prompt).toContain("GOOD signals");
    expect(prompt).toContain("BAD signals");
  });

  it("retains the MAX_SUBAGENT_CALLS=2 cap reminder", () => {
    const prompt = assembleAgentSystemPrompt({
      agentIntro: "You are Zone, an autonomous coding agent.",
      frameworkLines: [],
      hasFramework: false,
      projectMemoryBlock: "",
      baseMaxIterations: 15,
      canRunCommand: false,
      backgroundCommandBlock: "",
      repoPath: "/tmp/repo",
    });
    expect(prompt).toContain("MAX_SUBAGENT_CALLS=2");
  });

  it("Step D: focused_diagnosis GOOD signal is present in the active prompt path", () => {
    const prompt = assembleAgentSystemPrompt({
      agentIntro: "You are Zone, an autonomous coding agent.",
      frameworkLines: [],
      hasFramework: false,
      projectMemoryBlock: "",
      baseMaxIterations: 25,
      canRunCommand: false,
      backgroundCommandBlock: "",
      repoPath: "/tmp/repo",
    });
    expect(prompt).toContain("focused_diagnosis");
    expect(prompt).toContain("Verifier rolled back your patch");
    expect(prompt).toContain("environment archaeology");
  });
});
