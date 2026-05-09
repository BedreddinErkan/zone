import { describe, expect, it } from "vitest";
import { shouldUseInvestigationMode } from "./detectIntent.js";

describe("shouldUseInvestigationMode", () => {
  it("routes identifier usage questions to investigation", () => {
    expect(
      shouldUseInvestigationMode(
        "What does getRunCost return and which files use it?",
        "question"
      )
    ).toBe(true);
  });

  it("keeps trivial chat on the cheap chat path", () => {
    expect(shouldUseInvestigationMode("hi", "question")).toBe(false);
    expect(shouldUseInvestigationMode("what does Zone do?", "question")).toBe(false);
  });

  it("keeps generic discussion on the chat path", () => {
    expect(
      shouldUseInvestigationMode(
        "what's the best way to handle async errors?",
        "discussion"
      )
    ).toBe(false);
  });

  it("routes codebase flow questions to investigation", () => {
    expect(
      shouldUseInvestigationMode(
        "how does the apply_patch flow work end to end?",
        "question"
      )
    ).toBe(true);
  });

  it("never routes patch requests to investigation", () => {
    expect(
      shouldUseInvestigationMode("Add a one-line comment to README.md", "patch_request")
    ).toBe(false);
  });
});
