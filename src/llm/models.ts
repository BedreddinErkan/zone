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
  gemini: [
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash",
      costNote: "Fast and cost-efficient — $1.5/$9 per MTok", recommendedTier: "standard" },
    { id: "gemini-3.1-pro",   label: "Gemini 3.1 Pro",
      costNote: "Frontier — 2M context, $4/$18 per MTok (conservative flat)", recommendedTier: "high" },
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

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic — Claude 4.x: all 1M context windows
  "claude-opus-4-8":   1_000_000,
  "claude-opus-4-7":   1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-5": 1_000_000,
  "claude-haiku-4-5":    200_000,
  // OpenAI — 128k conservative for GPT-5.x; exact values vary by release
  "gpt-5.4":             128_000,
  "gpt-5.4-mini":        128_000,
  "gpt-5.5":             128_000,
  "gpt-5.4-nano":        128_000,
  "gpt-4o":              128_000,
  "gpt-4o-mini":         128_000,
  // Gemini
  "gemini-3.5-flash":  1_000_000,
  "gemini-3.1-pro":    2_000_000,
};

/** Returns the model's context-window limit in tokens (chars/4 heuristic scale).
 *  Exact match first; then longest-prefix match (handles snapshot-suffixed IDs like
 *  "claude-sonnet-4-6-20260219"); falls back to 200k — conservative, never silently
 *  disables compaction. */
export function getContextWindow(modelId: string): number {
  if (modelId in MODEL_CONTEXT_WINDOWS) return MODEL_CONTEXT_WINDOWS[modelId];
  let best = "";
  for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (modelId.startsWith(key) && key.length > best.length) best = key;
  }
  return best ? MODEL_CONTEXT_WINDOWS[best] : 200_000;
}
