import type { RoleModelMapping, RoutingProvider } from "./modelRouting.js";

export type PresetMode = "zone_default" | "speed" | "quality" | "custom";

const ANTHROPIC_PRESETS: Record<Exclude<PresetMode, "custom">, Partial<RoleModelMapping>> = {
  zone_default: {},
  speed: {
    planner: "claude-haiku-4-5",
    agent: "claude-haiku-4-5",
    worker: "claude-haiku-4-5",
    verifier: "claude-haiku-4-5",
    classifier: "claude-haiku-4-5",
    intent: "claude-haiku-4-5",
  },
  quality: {
    planner: "claude-sonnet-4-6",
    agent: "claude-sonnet-4-6",
    worker: "claude-sonnet-4-6",
    verifier: "claude-sonnet-4-6",
    classifier: "claude-sonnet-4-6",
    intent: "claude-sonnet-4-6",
  },
};

const OPENAI_PRESETS: Record<Exclude<PresetMode, "custom">, Partial<RoleModelMapping>> = {
  zone_default: {},
  speed: {
    planner: "gpt-5.4-mini",
    agent: "gpt-5.4-mini",
    worker: "gpt-5.4-mini",
    verifier: "gpt-5.4-mini",
    classifier: "gpt-5.4-mini",
    intent: "gpt-5.4-mini",
  },
  quality: {
    planner: "gpt-5.4",
    agent: "gpt-5.4",
    worker: "gpt-5.4",
    verifier: "gpt-5.4",
    classifier: "gpt-5.4",
    intent: "gpt-5.4",
  },
};

export function getPresetOverride(
  preset: PresetMode,
  provider: RoutingProvider,
  customOverrides?: Partial<RoleModelMapping>
): Partial<RoleModelMapping> {
  if (preset === "custom") return customOverrides ?? {};
  const table = provider === "anthropic" ? ANTHROPIC_PRESETS : OPENAI_PRESETS;
  return table[preset];
}

export function presetToTierModels(
  preset: PresetMode,
  provider: RoutingProvider,
  customOverrides?: { high?: string; standard?: string }
): { high?: string; standard?: string } {
  if (preset === "zone_default") return {};
  if (preset === "custom") return customOverrides ?? {};
  const override = getPresetOverride(preset, provider);
  return {
    high: override.agent,
    standard: override.worker,
  };
}
