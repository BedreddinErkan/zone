import { MODEL_CATALOG } from "./models.js";
import type { LLMProvider } from "./types.js";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelEntry {
  id: string;
  displayName: string;
  provider: "anthropic" | "openai";
  supportsEffort: boolean;
  costNote?: string;
  retention?: { minDays: number; zdrAvailable: boolean };
}

const EFFORT_SUPPORTED_MODELS = new Set([
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  // claude-haiku-4-5 excluded: does not support extended thinking in Claude 4 series
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  // gpt-5.4-nano, gpt-4o, gpt-4o-mini excluded
]);

// Models that use adaptive thinking only (thinking:{type:"adaptive"} + output_config.effort).
// budget_tokens / temperature / top_p / stop_sequences are all removed on this family.
const ADAPTIVE_THINKING_MODELS = new Set([
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
]);

export function usesAdaptiveThinking(id: string): boolean {
  return ADAPTIVE_THINKING_MODELS.has(normalizeModelId(id));
}

export const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Strip trailing -YYYYMMDD snapshot suffix so dated IDs hit the same map entries as their aliases.
 *  "claude-sonnet-4-6-20260219" → "claude-sonnet-4-6". No-op for non-snapshot IDs. */
export function normalizeModelId(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

// Keys MUST exactly match model IDs in models.ts MODEL_CONTEXT_WINDOWS.
// A missing entry ⇒ effortLevelsFor returns [] ⇒ effort silently disabled (the intended Haiku behavior).
// claude-sonnet-4-5: stays at low/med/high (budget_tokens path; output_config.effort unverified on 4.5).
// gpt-5.5/gpt-5.4/gpt-5.4-mini: reasoning_effort caps at "high" per OpenAI API (no xhigh/max).
const MODEL_EFFORT_LEVELS: Record<string, EffortLevel[]> = {
  // Bucket 1 — adaptive (output_config.effort required), full 5-level range
  "claude-fable-5":    ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8":   ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7":   ["low", "medium", "high", "xhigh", "max"],
  // Bucket 2 — output_config.effort or budget_tokens; NO xhigh
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
  "claude-sonnet-4-5": ["low", "medium", "high"],  // budget_tokens only; output_config unverified
  // Bucket 3 — Haiku: absent ⇒ resolver returns undefined ⇒ no effort sent (400 guard)
  // OpenAI — reasoning_effort; caps at "high" (xhigh/max narrowed in openaiAdapter.ts)
  "gpt-5.5":      ["low", "medium", "high"],
  "gpt-5.4":      ["low", "medium", "high"],
  "gpt-5.4-mini": ["low", "medium", "high"],
};

export function effortLevelsFor(model: string): EffortLevel[] {
  return MODEL_EFFORT_LEVELS[normalizeModelId(model)] ?? [];
}

export function resolveEffortForModel(
  model: string,
  requested: EffortLevel | undefined
): EffortLevel | undefined {
  const allowed = effortLevelsFor(model);
  if (!requested || allowed.length === 0) return undefined;  // Haiku / no-effort ⇒ drop
  if (allowed.includes(requested)) return requested;          // exact match ⇒ pass
  // clamp DOWN to the highest allowed level ≤ requested
  const want = EFFORT_ORDER.indexOf(requested);
  let best: EffortLevel | undefined;
  for (const lvl of allowed) {
    const i = EFFORT_ORDER.indexOf(lvl);
    if (i <= want && (best === undefined || i > EFFORT_ORDER.indexOf(best))) best = lvl;
  }
  // If no allowed level ≤ requested (unreachable with current map — all entries include "low"),
  // return undefined rather than clamping UP (cost-unsafe).
  if (best !== undefined && best !== requested) {
    console.warn("[zone-effort-clamped]", { model, requested, resolved: best });
  }
  return best;  // undefined ⇒ no effort (strict clamp-down semantics)
}

function buildModels(): readonly ModelEntry[] {
  const result: ModelEntry[] = [];
  for (const [provider, models] of Object.entries(MODEL_CATALOG) as [LLMProvider, typeof MODEL_CATALOG[LLMProvider]][]) {
    for (const m of models) {
      result.push({
        id: m.id,
        displayName: m.label,
        provider: provider as "anthropic" | "openai",
        supportsEffort: EFFORT_SUPPORTED_MODELS.has(m.id),
        costNote: m.costNote,
        retention: m.retention,
      });
    }
  }
  return result;
}

export const USER_FACING_MODELS: readonly ModelEntry[] = buildModels();

export function getProviderForModel(id: string): "anthropic" | "openai" {
  const entry = USER_FACING_MODELS.find((m) => m.id === id);
  return entry?.provider ?? "anthropic";
}

export function supportsEffort(id: string): boolean {
  return EFFORT_SUPPORTED_MODELS.has(normalizeModelId(id));
}

export function getDefaultModelId(): string {
  return "claude-sonnet-4-6";
}

/** True when `id` is an exact match for a catalog model (any provider). Unlike
 *  getProviderForModel (which defaults unknown ids to "anthropic"), this lets
 *  callers distinguish a known catalog id from an unknown/custom/snapshot id —
 *  e.g. to decide whether the model can authoritatively pin its provider. */
export function isKnownModelId(id: string): boolean {
  return USER_FACING_MODELS.some((m) => m.id === id);
}
