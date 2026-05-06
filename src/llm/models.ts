import type { LLMProvider } from "./types.js";

export type ZoneModelTier = "high" | "standard";

export interface ModelOption {
  id: string;
  label: string;
  costNote?: string;
  recommendedTier?: ZoneModelTier;
}

export const MODEL_CATALOG: Record<LLMProvider, ModelOption[]> = {
  openai: [
    { id: "gpt-4o", label: "GPT-4o", recommendedTier: "high" },
    { id: "gpt-4o-mini", label: "GPT-4o mini", recommendedTier: "standard" },
    { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
    {
      id: "o1",
      label: "o1 (reasoning)",
      costNote:
        "Slower, more expensive — best for complex multi-step reasoning",
    },
  ],
  anthropic: [
    {
      id: "claude-sonnet-4-5",
      label: "Claude Sonnet 4.5",
      recommendedTier: "high",
    },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      recommendedTier: "standard",
    },
    {
      id: "claude-opus-4-5",
      label: "Claude Opus 4.5",
      costNote: "~5× more expensive than Sonnet — verify your usage budget",
    },
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
