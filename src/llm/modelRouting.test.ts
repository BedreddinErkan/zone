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

  it("worker on openai → gpt-4o-mini", () => {
    expect(getModelForRole("worker", "openai")).toBe("gpt-4o-mini");
  });

  it("agent on openai → gpt-4o", () => {
    expect(getModelForRole("agent", "openai")).toBe("gpt-4o");
  });

  it("classifier on openai → gpt-4o-mini", () => {
    expect(getModelForRole("classifier", "openai")).toBe("gpt-4o-mini");
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
    expect(getModelForRole("worker", "openai", override)).toBe("gpt-4o-mini");
  });
});

describe("getModelForRole — verifier and intent roles (BYOM.1)", () => {
  it("verifier on anthropic → claude-sonnet-4-6", () => {
    expect(getModelForRole("verifier", "anthropic")).toBe("claude-sonnet-4-6");
  });

  it("verifier on openai → gpt-4o", () => {
    expect(getModelForRole("verifier", "openai")).toBe("gpt-4o");
  });

  it("intent on anthropic → claude-sonnet-4-6", () => {
    expect(getModelForRole("intent", "anthropic")).toBe("claude-sonnet-4-6");
  });

  it("intent on openai → gpt-4o", () => {
    expect(getModelForRole("intent", "openai")).toBe("gpt-4o");
  });

  it("planner on openai → gpt-4o", () => {
    expect(getModelForRole("planner", "openai")).toBe("gpt-4o");
  });
});

describe("getModelForRole — investigator role (Phase D.1)", () => {
  it("Zone Default (no override): Anthropic → claude-sonnet-4-6", () => {
    expect(getModelForRole("investigator", "anthropic")).toBe("claude-sonnet-4-6");
  });

  it("Speed preset override → claude-haiku-4-5 (lighter, faster)", () => {
    expect(
      getModelForRole("investigator", "anthropic", { investigator: "claude-haiku-4-5" })
    ).toBe("claude-haiku-4-5");
  });

  it("Quality preset override → claude-opus-4-7 (deepest, memory directive)", () => {
    expect(
      getModelForRole("investigator", "anthropic", { investigator: "claude-opus-4-7" })
    ).toBe("claude-opus-4-7");
  });

  it("OpenAI Zone Default → gpt-4o", () => {
    expect(getModelForRole("investigator", "openai")).toBe("gpt-4o");
  });

  it("Custom preset: override takes precedence over default", () => {
    expect(
      getModelForRole("investigator", "anthropic", { investigator: "my-custom-model" })
    ).toBe("my-custom-model");
  });

  it("override only affects investigator; other roles keep defaults", () => {
    const override = { investigator: "claude-opus-4-7" };
    expect(getModelForRole("agent", "anthropic", override)).toBe("claude-sonnet-4-6");
    expect(getModelForRole("worker", "anthropic", override)).toBe("claude-haiku-4-5");
  });
});

