import { describe, expect, it } from "vitest";
import { buildFinalPrompt } from "./buildFinalPrompt.js";

describe("buildFinalPrompt", () => {
  it("always includes the global prompt", () => {
    const prompt = buildFinalPrompt({
      role: "developer",
      task: "polish spacing",
      context: "CONTEXT BLOCK",
    });

    expect(prompt).toContain("GLOBAL RULES");
    expect(prompt).toContain("Never generate filenames from raw user task text.");
  });

  it("selects the correct role prompt", () => {
    const prompt = buildFinalPrompt({
      role: "data_analyst",
      task: "create orders table",
      context: "CONTEXT BLOCK",
    });

    expect(prompt).toContain("Inspect schema, existing queries, and migration style before proposing changes.");
    expect(prompt).not.toContain("Inspect existing tests first");
  });

  it("adds the relevant framework prompt only for matching test flows", () => {
    const prompt = buildFinalPrompt({
      role: "test_engineer",
      task: "add login coverage",
      detectedFramework: "playwright_ts",
      context: "CONTEXT BLOCK",
    });

    expect(prompt).toContain("FRAMEWORK AUGMENTATION");
    expect(prompt).toContain("Reuse page objects, helpers, and fixtures when they exist.");
    expect(prompt).not.toContain("Preserve Cypress idioms");
  });

  it("does not add unrelated framework prompts", () => {
    const prompt = buildFinalPrompt({
      role: "developer",
      task: "fix login route",
      detectedFramework: "playwright_ts",
      context: "CONTEXT BLOCK",
    });

    expect(prompt).not.toContain("Reuse page objects, helpers, and fixtures when they exist.");
  });

  it("assembles deterministically", () => {
    const input = {
      role: "test_engineer" as const,
      task: "add login coverage",
      detectedFramework: "cucumber_java" as const,
      context: "CONTEXT BLOCK",
    };

    expect(buildFinalPrompt(input)).toBe(buildFinalPrompt(input));
  });

  it("keeps the filename guard text in final prompt for test roles", () => {
    const prompt = buildFinalPrompt({
      role: "test_engineer",
      task: "add negative login test",
      detectedFramework: "playwright_ts",
      context: "CONTEXT BLOCK",
    });

    expect(prompt).toContain("Never generate filenames from raw user task text.");
  });
});
