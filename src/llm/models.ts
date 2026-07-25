import type { LLMProvider } from "./types.js";
import { formatCostNote } from "../usage/pricing.js";

export type ZoneModelTier = "high" | "standard";

export interface ModelOption {
  id: string;
  label: string;
  costNote?: string;
  recommendedTier?: ZoneModelTier;
  workerSuitable?: boolean;
  workerSuitabilityNote?: string;
  retention?: { minDays: number; zdrAvailable: boolean };
  /** When explicitly false, the model does not accept image input. Default: true (all current models support vision). */
  supportsVision?: boolean;
}

export const MODEL_CATALOG: Record<LLMProvider, ModelOption[]> = {
  openai: [
    { id: "gpt-4o",       label: "GPT-4o",       recommendedTier: "high",
      costNote: formatCostNote("openai", "gpt-4o") },
    {
      id: "gpt-4o-mini",
      label: "GPT-4o mini",
      recommendedTier: "standard",
      costNote: formatCostNote("openai", "gpt-4o-mini"),
      workerSuitable: false,
      workerSuitabilityNote: "Not recommended as Worker subagent — may corrupt file content during write_file operations",
    },
    { id: "gpt-5.4",      label: "GPT-5.4",
      costNote: formatCostNote("openai", "gpt-5.4") },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini",
      costNote: formatCostNote("openai", "gpt-5.4-mini") },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      costNote: formatCostNote("openai", "gpt-5.5"),
    },
    { id: "gpt-5.4-nano", label: "GPT-5.4 nano",
      costNote: formatCostNote("openai", "gpt-5.4-nano") },
  ],
  anthropic: [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
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

export const ESCALATION_LADDERS: Record<LLMProvider, readonly string[]> = {
  anthropic: ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"],
  openai:    ["gpt-4o-mini", "gpt-4o", "gpt-5.5"],
};

export function nextStrongerModel(
  provider: LLMProvider,
  currentModel: string,
): string | null {
  const ladder = ESCALATION_LADDERS[provider] ?? [];
  const idx = ladder.indexOf(currentModel);
  if (idx === -1 || idx === ladder.length - 1) return null;
  return ladder[idx + 1] ?? null;
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
  // Anthropic — Claude 4.x/5.x: all 1M context windows
  "claude-sonnet-5":   1_000_000,
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
};

/** Context window assumed for models absent from MODEL_CONTEXT_WINDOWS. Conservative:
 *  under-estimating compacts early, over-estimating would overflow the real window. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Model IDs already warned about — getContextWindow runs per iteration, and the
 *  fallback is a config gap, not a per-call event. */
const contextWindowFallbackWarned = new Set<string>();

/** Test-only: clear the once-per-model fallback-warning dedupe. */
export function _resetContextWindowFallbackWarningsForTest(): void {
  contextWindowFallbackWarned.clear();
}

/** Returns the model's context-window limit in tokens (chars/4 heuristic scale).
 *  Exact match first; then longest-prefix match (handles snapshot-suffixed IDs like
 *  "claude-sonnet-4-6-20260219"); falls back to DEFAULT_CONTEXT_WINDOW — conservative,
 *  never silently disables compaction. The fallback is announced: on a 1M-context model
 *  it would compact at 150k, and nothing else in a transcript reveals that. */
export function getContextWindow(modelId: string): number {
  if (modelId in MODEL_CONTEXT_WINDOWS) return MODEL_CONTEXT_WINDOWS[modelId];
  let best = "";
  for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (modelId.startsWith(key) && key.length > best.length) best = key;
  }
  if (best) return MODEL_CONTEXT_WINDOWS[best];

  if (!contextWindowFallbackWarned.has(modelId)) {
    contextWindowFallbackWarned.add(modelId);
    // stderr, matching [zone-effort-clamped] — the sibling "your config silently
    // degraded" warning in this layer.
    console.warn(
      "[zone-context-window-fallback]",
      JSON.stringify({
        modelId,
        assumedContextWindow: DEFAULT_CONTEXT_WINDOW,
        impact:
          "compaction triggers at 75% of the assumed window; add this model to " +
          "MODEL_CONTEXT_WINDOWS if its real window is larger",
      })
    );
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Maximum output tokens a model accepts in `max_tokens` — thinking tokens are spent
 * inside this same budget, so it is the ceiling for thinking + text + tool-call JSON.
 * Asking for more than a model allows is a hard 400, so these values double as the
 * clamp applied in the Anthropic adapter.
 *
 * Anthropic values marked "verified" were read back from the API on 2026-07-25 by
 * sending a deliberately oversized max_tokens, which returns:
 *   "max_tokens: 999999 > 128000, which is the maximum allowed number of output
 *    tokens for claude-sonnet-5"
 * Forward-dated catalog IDs (opus-4-8/4-7, sonnet-4-6) cannot be probed; they take
 * their family's verified ceiling.
 */
export const MODEL_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "claude-sonnet-5":   128_000, // verified
  "claude-opus-4-8":    64_000, // family value (claude-opus-4-5 verified at 64k)
  "claude-opus-4-7":    64_000, // family value
  "claude-sonnet-4-6":  64_000, // family value (claude-sonnet-4-5 verified at 64k)
  "claude-sonnet-4-5":  64_000, // verified
  "claude-haiku-4-5":   64_000, // verified
  "gpt-5.5":           128_000,
  "gpt-5.4":           128_000,
  "gpt-5.4-mini":      128_000,
  "gpt-5.4-nano":      128_000,
  "gpt-4o":             16_384,
  "gpt-4o-mini":        16_384,
};

/** Output budget used for models absent from MODEL_MAX_OUTPUT_TOKENS. Chosen as the
 *  smallest known ceiling so an unlisted ID can never 400 by over-asking. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/** The model's declared output ceiling, or undefined when the model is unlisted.
 *  Exact match first, then longest-prefix (dated snapshot IDs). Callers that must
 *  clamp use this; callers that just need a budget use getMaxOutputTokens. */
export function lookupMaxOutputTokens(modelId: string): number | undefined {
  if (modelId in MODEL_MAX_OUTPUT_TOKENS) return MODEL_MAX_OUTPUT_TOKENS[modelId];
  let best = "";
  for (const key of Object.keys(MODEL_MAX_OUTPUT_TOKENS)) {
    if (modelId.startsWith(key) && key.length > best.length) best = key;
  }
  return best ? MODEL_MAX_OUTPUT_TOKENS[best] : undefined;
}

/** Output-token budget for one call to `modelId`: its catalog ceiling, or the
 *  conservative default when unlisted. max_tokens is a ceiling, not a reservation —
 *  only tokens actually produced are billed. */
export function getMaxOutputTokens(modelId: string): number {
  return lookupMaxOutputTokens(modelId) ?? DEFAULT_MAX_OUTPUT_TOKENS;
}
