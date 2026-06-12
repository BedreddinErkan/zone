import { describe, it, expect } from "vitest";
import { appendFableHint } from "./agentLoop.js";

describe("appendFableHint", () => {
  it("appends Opus hint for claude-fable-5", () => {
    const result = appendFableHint("claude-fable-5", "Declined by safety classifier.");
    expect(result).toContain("/model claude-opus-4-8");
    expect(result).toContain("Opus applies its own safety floor");
    expect(result).toContain("Declined by safety classifier.");
  });

  it("snapshot-suffixed fable ID also gets the hint", () => {
    const result = appendFableHint("claude-fable-5-20261201", "Declined.");
    expect(result).toContain("/model claude-opus-4-8");
  });

  it("non-fable model — no hint appended", () => {
    const result = appendFableHint("claude-sonnet-4-6", "Declined by safety classifier.");
    expect(result).toBe("Declined by safety classifier.");
    expect(result).not.toContain("claude-opus-4-8");
  });

  it("another non-fable model — no hint appended", () => {
    const result = appendFableHint("claude-opus-4-8", "Declined.");
    expect(result).toBe("Declined.");
  });
});
