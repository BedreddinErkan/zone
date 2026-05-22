import { describe, expect, it } from "vitest";
import { getModelForRole } from "./modelRouting.js";
import { getPresetOverride, presetToTierModels } from "./presets.js";

describe("getPresetOverride", () => {
  it("speed/anthropic → all roles mapped to Haiku 4.5", () => {
    const override = getPresetOverride("speed", "anthropic");
    expect(override.agent).toBe("claude-haiku-4-5");
    expect(override.worker).toBe("claude-haiku-4-5");
    expect(override.planner).toBe("claude-haiku-4-5");
  });

  it("quality/anthropic → all roles mapped to Sonnet 4.6", () => {
    const override = getPresetOverride("quality", "anthropic");
    expect(override.agent).toBe("claude-sonnet-4-6");
    expect(override.worker).toBe("claude-sonnet-4-6");
    expect(override.planner).toBe("claude-sonnet-4-6");
  });

  it("zone_default/anthropic → empty override (uses getModelForRole defaults)", () => {
    const override = getPresetOverride("zone_default", "anthropic");
    expect(Object.keys(override).length).toBe(0);
  });

  it("speed/openai → all roles mapped to gpt-5.4-mini", () => {
    const override = getPresetOverride("speed", "openai");
    expect(override.agent).toBe("gpt-5.4-mini");
    expect(override.worker).toBe("gpt-5.4-mini");
  });

  it("quality/openai → all roles mapped to gpt-5.4", () => {
    const override = getPresetOverride("quality", "openai");
    expect(override.agent).toBe("gpt-5.4");
    expect(override.worker).toBe("gpt-5.4");
  });

  it("custom → returns provided customOverrides", () => {
    const custom = { worker: "claude-sonnet-4-6" };
    const override = getPresetOverride("custom", "anthropic", custom);
    expect(override.worker).toBe("claude-sonnet-4-6");
    expect(override.planner).toBeUndefined();
  });

  it("custom with no customOverrides → returns empty object", () => {
    const override = getPresetOverride("custom", "anthropic");
    expect(Object.keys(override).length).toBe(0);
  });
});

describe("getModelForRole + getPresetOverride integration", () => {
  it("speed: agent on anthropic → claude-haiku-4-5", () => {
    expect(
      getModelForRole("agent", "anthropic", getPresetOverride("speed", "anthropic"))
    ).toBe("claude-haiku-4-5");
  });

  it("quality: worker on anthropic → claude-sonnet-4-6", () => {
    expect(
      getModelForRole("worker", "anthropic", getPresetOverride("quality", "anthropic"))
    ).toBe("claude-sonnet-4-6");
  });

  it("zone_default: worker on anthropic → claude-haiku-4-5 (default mapping)", () => {
    expect(
      getModelForRole("worker", "anthropic", getPresetOverride("zone_default", "anthropic"))
    ).toBe("claude-haiku-4-5");
  });

  it("zone_default: agent on anthropic → claude-sonnet-4-6 (default mapping)", () => {
    expect(
      getModelForRole("agent", "anthropic", getPresetOverride("zone_default", "anthropic"))
    ).toBe("claude-sonnet-4-6");
  });

  it("speed: worker on openai → gpt-5.4-mini", () => {
    expect(
      getModelForRole("worker", "openai", getPresetOverride("speed", "openai"))
    ).toBe("gpt-5.4-mini");
  });

  it("quality: worker on openai → gpt-5.4", () => {
    expect(
      getModelForRole("worker", "openai", getPresetOverride("quality", "openai"))
    ).toBe("gpt-5.4");
  });
});

describe("presetToTierModels", () => {
  it("zone_default → empty (no headers, server uses defaults)", () => {
    const tiers = presetToTierModels("zone_default", "anthropic");
    expect(tiers.high).toBeUndefined();
    expect(tiers.standard).toBeUndefined();
  });

  it("speed/anthropic → high=haiku, standard=haiku", () => {
    const tiers = presetToTierModels("speed", "anthropic");
    expect(tiers.high).toBe("claude-haiku-4-5");
    expect(tiers.standard).toBe("claude-haiku-4-5");
  });

  it("quality/anthropic → high=sonnet, standard=sonnet", () => {
    const tiers = presetToTierModels("quality", "anthropic");
    expect(tiers.high).toBe("claude-sonnet-4-6");
    expect(tiers.standard).toBe("claude-sonnet-4-6");
  });

  it("custom → passes through customOverrides", () => {
    const tiers = presetToTierModels("custom", "anthropic", { high: "claude-opus-4-7" });
    expect(tiers.high).toBe("claude-opus-4-7");
    expect(tiers.standard).toBeUndefined();
  });
});
