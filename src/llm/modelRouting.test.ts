import { describe, expect, it } from "vitest";
import { getModelForRole } from "./modelRouting.js";

describe("getModelForRole", () => {
  it("worker on anthropic → claude-haiku-4-5", () => {
    expect(getModelForRole("worker", "anthropic")).toBe("claude-haiku-4-5");
  });

  it("agent on anthropic → claude-sonnet-4-6", () => {
    expect(getModelForRole("agent", "anthropic")).toBe("claude-sonnet-4-6");
  });

  it("planner on anthropic → claude-sonnet-4-6", () => {
    expect(getModelForRole("planner", "anthropic")).toBe("claude-sonnet-4-6");
  });

  it("classifier on anthropic → claude-haiku-4-5", () => {
    expect(getModelForRole("classifier", "anthropic")).toBe("claude-haiku-4-5");
  });

  it("worker on openai → gpt-5.4-mini", () => {
    expect(getModelForRole("worker", "openai")).toBe("gpt-5.4-mini");
  });

  it("agent on openai → gpt-5.4", () => {
    expect(getModelForRole("agent", "openai")).toBe("gpt-5.4");
  });

  it("classifier on openai → gpt-5.4-mini", () => {
    expect(getModelForRole("classifier", "openai")).toBe("gpt-5.4-mini");
  });

  it("override path: worker on anthropic with override → uses override", () => {
    expect(
      getModelForRole("worker", "anthropic", { worker: "claude-sonnet-4-6" })
    ).toBe("claude-sonnet-4-6");
  });

  it("override only overrides the specified role, others get defaults", () => {
    const override = { worker: "claude-sonnet-4-6" };
    expect(getModelForRole("agent", "anthropic", override)).toBe(
      "claude-sonnet-4-6"
    );
    expect(getModelForRole("classifier", "anthropic", override)).toBe(
      "claude-haiku-4-5"
    );
  });

  it("partial override on openai: classifier overridden, worker uses default", () => {
    const override = { classifier: "gpt-5.4" };
    expect(getModelForRole("classifier", "openai", override)).toBe("gpt-5.4");
    expect(getModelForRole("worker", "openai", override)).toBe("gpt-5.4-mini");
  });
});
