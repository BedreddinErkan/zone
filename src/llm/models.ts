import type { LLMProvider } from "./types.js";

export type ZoneModelTier = "high" | "standard";

export interface ModelOption {
  id: string;
  label: string;
  costNote?: string;
  recommendedTier?: ZoneModelTier;
  workerSuitable?: boolean;
  workerSuitabilityNote?: string;
}

export const MODEL_CATALOG: Record<LLMProvider, ModelOption[]> = {
  openai: [
    { id: "gpt-5.4",      label: "GPT-5.4",      recommendedTier: "high" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini", recommendedTier: "standard" },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      costNote: "Frontier model — higher cost, best for complex multi-step work",
    },
    { id: "gpt-5.4-nano", label: "GPT-5.4 nano", costNote: "Ultra-budget — for classification/routing" },
    { id: "gpt-4o",       label: "GPT-4o",       costNote: "Legacy — GPT-5.4 recommended" },
    {
      id: "gpt-4o-mini",
      label: "GPT-4o mini",
      costNote: "Legacy — GPT-5.4 mini recommended",
      workerSuitable: false,
      workerSuitabilityNote: "Not recommended as Worker subagent — may corrupt file content during write_file operations",
    },
  ],
  anthropic: [
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      recommendedTier: "high",
    },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      recommendedTier: "standard",
    },
    {
      id: "claude-opus-4-8",
      label: "Claude Opus 4.8",
      costNote: "Frontier model — ~1.7× Sonnet output cost; verify usage budget",
    },
    {
      id: "claude-opus-4-7",
      label: "Claude Opus 4.7",
      costNote: "Frontier model — ~1.7× Sonnet output cost; verify usage budget",
    },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", costNote: "Legacy — Sonnet 4.6 recommended" },
  ],
};

export function isValidModelId(provider: LLMProvider, modelId: string): boolean {
  if (!modelId) return false;
  const catalog = MODEL_CATALOG[provider];
  if (!catalog) return false;
  return catalog.some((m) => m.id === modelId);
}

export function getDefaultModelForTier(
  provider: LLMProvider,
  tier: ZoneModelTier
): string {
  const catalog = MODEL_CATALOG[provider] ?? [];
  const recommended = catalog.find((m) => m.recommendedTier === tier);
  if (recommended) return recommended.id;
  return catalog[0]?.id ?? "";
}
