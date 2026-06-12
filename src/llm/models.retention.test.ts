import { describe, it, expect } from "vitest";
import { MODEL_CATALOG } from "./models.js";

describe("claude-fable-5 ModelOption retention", () => {
  const fable = MODEL_CATALOG["anthropic"].find(m => m.id === "claude-fable-5");

  it("has structured retention field", () => {
    expect(fable?.retention).toEqual({ minDays: 30, zdrAvailable: false });
  });

  it("costNote no longer contains 'retention'", () => {
    expect(fable?.costNote).not.toMatch(/retention/i);
  });
});
