import { describe, expect, it } from "vitest";
import { convertParams } from "./convertParams.js";

function minimalInput(model: string) {
  return {
    model,
    messages: [{ role: "user" as const, content: "hi" }],
    temperature: 0.7,
    top_p: 0.9,
  };
}

describe("convertParams — adaptive thinking family (Opus 5 / Fable 5 / Opus 4.8 / Opus 4.7)", () => {
  for (const model of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-5", "claude-fable-5"]) {
    it(`${model} + effort:high → thinking:{type:"adaptive"} + output_config:{effort:"high"}`, () => {
      const { params } = convertParams(minimalInput(model), { effort: "high" });
      expect(params.thinking).toEqual({ type: "adaptive" });
      expect((params as Record<string, unknown>).output_config).toEqual({ effort: "high" });
    });

    it(`${model} + effort:high → NO temperature, top_p, or budget_tokens`, () => {
      const { params } = convertParams(minimalInput(model), { effort: "high" });
      expect(params.temperature).toBeUndefined();
      expect(params.top_p).toBeUndefined();
      expect((params.thinking as Record<string, unknown> | undefined)?.budget_tokens).toBeUndefined();
    });

    it(`${model} + no effort → no thinking key, no output_config (omit not disabled)`, () => {
      const { params } = convertParams(minimalInput(model));
      expect(params.thinking).toBeUndefined();
      expect((params as Record<string, unknown>).output_config).toBeUndefined();
    });

    it(`${model} + no effort → still NO temperature or top_p (adaptive family strips them)`, () => {
      const { params } = convertParams(minimalInput(model));
      expect(params.temperature).toBeUndefined();
      expect(params.top_p).toBeUndefined();
    });
  }

  it("explicit effort:low is passed through to output_config.effort", () => {
    const { params: lo } = convertParams(minimalInput("claude-opus-4-8"), { effort: "low" });
    expect((lo as Record<string, unknown>).output_config).toEqual({ effort: "low" });
  });
});

describe("convertParams — non-adaptive models unchanged", () => {
  it("claude-sonnet-4-6 + effort:high → budget_tokens path, temperature still sent", () => {
    const { params } = convertParams(minimalInput("claude-sonnet-4-6"), { effort: "high" });
    expect(params.thinking).toMatchObject({ type: "enabled" });
    expect((params.thinking as Record<string, unknown>).budget_tokens).toBeGreaterThan(0);
    expect((params as Record<string, unknown>).output_config).toBeUndefined();
  });

  it("claude-sonnet-4-6 no effort → temperature + top_p sent, no thinking key", () => {
    const { params } = convertParams(minimalInput("claude-sonnet-4-6"));
    expect(params.thinking).toBeUndefined();
    expect(params.temperature).toBeDefined();
    expect(params.top_p).toBeDefined();
  });

  it("gpt-5.4 (OpenAI) → temperature sent, no thinking key", () => {
    const { params } = convertParams(minimalInput("gpt-5.4"));
    expect(params.thinking).toBeUndefined();
    expect(params.temperature).toBeDefined();
  });
});

describe("convertParams — thinking is never disabled for the always-thinking models", () => {
  // Two API rules make a disabled-thinking request illegal for these models:
  //   claude-opus-5  — thinking:{type:"disabled"} is accepted only at effort ≤ high;
  //                    sending it with xhigh or max returns 400.
  //   claude-fable-5 — adaptive thinking is always on; disabled is not supported at
  //                    any effort.
  // Zone emits no disabled-thinking request anywhere today, so this pins the request
  // shape the API actually sees rather than a helper's opinion about it. If someone
  // later adds a "thinking off" path, these fail before the 400 reaches a user.
  const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

  for (const model of ["claude-opus-5", "claude-fable-5"]) {
    it(`${model} never emits thinking.type "disabled" at any effort`, () => {
      for (const effort of EFFORTS) {
        const { params } = convertParams(minimalInput(model), { effort });
        const thinking = params.thinking as { type?: string } | undefined;
        expect(thinking?.type, `${model} at effort=${effort}`).not.toBe("disabled");
      }
    });

    it(`${model} never emits thinking.type "disabled" with no effort configured`, () => {
      const { params } = convertParams(minimalInput(model));
      const thinking = params.thinking as { type?: string } | undefined;
      expect(thinking?.type).not.toBe("disabled");
    });
  }

  it("claude-opus-5 at xhigh and max sends adaptive thinking, the legal shape", () => {
    // The two levels where disabled would 400 are exactly the ones the ladder allows,
    // so this is the combination most likely to be reached in practice.
    for (const effort of ["xhigh", "max"] as const) {
      const { params } = convertParams(minimalInput("claude-opus-5"), { effort });
      expect(params.thinking).toEqual({ type: "adaptive" });
      expect((params as Record<string, unknown>).output_config).toEqual({ effort });
    }
  });
});
