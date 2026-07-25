import { describe, it, expect } from "vitest";
import { MODEL_CATALOG } from "./models.js";

describe("claude-fable-5 ModelOption retention", () => {
  const fable = MODEL_CATALOG["anthropic"].find(m => m.id === "claude-fable-5");

  it("has the structured retention field", () => {
    // The field is what drives the picker's disclosure. Dropping it doesn't break a
    // render — it silently removes the warning, which is the failure to guard against
    // for a tool whose positioning is self-hosted and private.
    expect(fable?.retention).toEqual({ minDays: 30, zdrAvailable: false });
  });

  it("costNote does not also mention retention", () => {
    expect(fable?.costNote).not.toMatch(/retention/i);
  });
});

describe("retention is opt-in per model", () => {
  it("no other catalog model claims a retention requirement", () => {
    const withRetention = Object.values(MODEL_CATALOG)
      .flat()
      .filter(m => m.retention)
      .map(m => m.id);
    expect(withRetention).toEqual(["claude-fable-5"]);
  });
});
