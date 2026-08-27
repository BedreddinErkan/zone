import { MODEL_CATALOG, type ZoneModelTier } from "./models.js";
import { normalizeModelId } from "./modelIdNormalize.js";
import type { LLMProvider, ModelCapabilities } from "./types.js";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelEntry {
  id: string;
  displayName: string;
  provider: "anthropic" | "openai";
  supportsEffort: boolean;
  costNote?: string;
  retention?: { minDays: number; zdrAvailable: boolean };
  /** The catalog's own tier recommendation, carried through rather than dropped (ledger item 320).
   *  Populated on four of seventeen entries. NOT an ordering: two values over seventeen rows cannot
   *  rank them, and getDefaultModelForTier reads it as a first-match lookup key. Picker order comes
   *  from the catalog literal's own sequence — see MODEL_CATALOG's header. */
  recommendedTier?: ZoneModelTier;
}

const EFFORT_SUPPORTED_MODELS = new Set([
  "claude-opus-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  // claude-haiku-4-5 excluded: does not support extended thinking in Claude 4 series
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  // gpt-5.4-nano added 2026-08-20 on live evidence, correcting an exclusion that never stated a
  // reason. It was excluded here, and that bare exclusion was then cited three times (the Responses
  // params converter, ledger item 237, commit 64060503) as if it established a fact about the
  // model. It did not. Measured against the real API: nano ACCEPTS reasoning.effort and
  // reasoning.summary at low/medium/high, and returns a genuine reasoning item with readable
  // summary prose at every one (35/37/40 reasoning tokens on the same prompt). An earlier probe
  // that reported zero reasoning was an artifact of an easy prompt at low effort, not a property
  // of the model — which is why the levels below are the accepted range, not the range that
  // happened to produce output on one question.
  "gpt-5.4-nano",
  // gpt-4o, gpt-4o-mini excluded — not reasoning models.
]);

// Models that use adaptive thinking only (thinking:{type:"adaptive"} + output_config.effort).
// budget_tokens / temperature / top_p / stop_sequences are all removed on this family.
const ADAPTIVE_THINKING_MODELS = new Set([
  // @unverified-probe(claude-opus-5) family inferred, never measured: thinking is on
  // by default, the ladder runs to xhigh/max, and thinking:{type:"disabled"} is
  // accepted only at effort ≤ high — all three are the adaptive surface. The probe
  // that would confirm it is blocked on the Anthropic credit balance. If this is
  // wrong, every Opus 5 request 400s immediately rather than degrading quietly.
  "claude-opus-5",
  // @unverified-probe(claude-fable-5) adaptive thinking is documented as always on
  // and thinking:{type:"disabled"} as unsupported, which is exactly the adaptive
  // surface — but like Opus 5 it is unmeasured while the credit balance blocks
  // every probe.
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
]);

export function usesAdaptiveThinking(id: string, caps?: ModelCapabilities): boolean {
  if (caps?.adaptiveThinking !== undefined) return caps.adaptiveThinking;
  return ADAPTIVE_THINKING_MODELS.has(normalizeModelId(id));
}

export const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Re-exported so the many call sites here and in openaiAdapter.ts keep their existing import
 *  path. The implementation moved to modelIdNormalize.ts when it was unified with pricing.ts's
 *  own copy — which stripped BOTH snapshot spellings while this one stripped only Anthropic's,
 *  so a dated OpenAI id silently resolved to no capability entry at all. See that module. */
export { normalizeModelId };

// Keys MUST exactly match model IDs in models.ts MODEL_CONTEXT_WINDOWS.
// A missing entry ⇒ effortLevelsFor returns [] ⇒ effort silently disabled (the intended Haiku behavior).
// claude-sonnet-4-5: stays at low/med/high (budget_tokens path; output_config.effort unverified on 4.5).
// gpt-5.5/gpt-5.4/gpt-5.4-mini: reasoning_effort caps at "high" per OpenAI API (no xhigh/max).
const MODEL_EFFORT_LEVELS: Record<string, EffortLevel[]> = {
  // Bucket 1 — adaptive (output_config.effort required), full 5-level range
  "claude-opus-5":     ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5":    ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8":   ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7":   ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5":   ["low", "medium", "high", "xhigh", "max"],
  // Bucket 2 — output_config.effort or budget_tokens; NO xhigh
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
  "claude-sonnet-4-5": ["low", "medium", "high"],  // budget_tokens only; output_config unverified
  // Bucket 3 — Haiku: absent ⇒ resolver returns undefined ⇒ no effort sent (400 guard)
  // OpenAI — reasoning_effort; caps at "high" (xhigh/max narrowed in openaiAdapter.ts)
  "gpt-5.6-sol":   ["low", "medium", "high"],
  "gpt-5.6-terra": ["low", "medium", "high"],
  "gpt-5.6-luna":  ["low", "medium", "high"],
  "gpt-5.5":      ["low", "medium", "high"],
  "gpt-5.4":      ["low", "medium", "high"],
  "gpt-5.4-mini": ["low", "medium", "high"],
  // Same accepted range as its siblings, confirmed live rather than assumed — see the
  // EFFORT_SUPPORTED_MODELS comment above for the measurement that corrected its exclusion.
  "gpt-5.4-nano": ["low", "medium", "high"],
};

/**
 * `caps.effortLevels` overrides the global table. An explicitly empty array is honoured as "this
 * model takes no effort" — a different statement from omitting the field, which defers to the
 * table. That distinction is why the check is on `!== undefined` rather than on truthiness.
 */
export function effortLevelsFor(model: string, caps?: ModelCapabilities): EffortLevel[] {
  if (caps?.effortLevels !== undefined) return [...caps.effortLevels];
  return MODEL_EFFORT_LEVELS[normalizeModelId(model)] ?? [];
}

export function resolveEffortForModel(
  model: string,
  requested: EffortLevel | undefined,
  caps?: ModelCapabilities
): EffortLevel | undefined {
  const allowed = effortLevelsFor(model, caps);
  if (!requested || allowed.length === 0) return undefined;  // Haiku / no-effort ⇒ drop
  if (allowed.includes(requested)) return requested;          // exact match ⇒ pass
  // clamp DOWN to the highest allowed level ≤ requested
  const want = EFFORT_ORDER.indexOf(requested);
  let best: EffortLevel | undefined;
  for (const lvl of allowed) {
    const i = EFFORT_ORDER.indexOf(lvl);
    if (i <= want && (best === undefined || i > EFFORT_ORDER.indexOf(best))) best = lvl;
  }
  if (best !== undefined && best !== requested) {
    console.warn("[zone-effort-clamped]", { model, requested, resolved: best });
  } else if (best === undefined) {
    // No allowed level at or below the request, so the effort is dropped rather than clamped UP
    // (clamping up is cost-unsafe). This branch was unreachable while every table row contained
    // "low"; a profile declaring a truncated ladder such as ["high","max"] reaches it, and a drop
    // that says nothing is exactly the silent degradation this layer exists to remove. Reported
    // through the existing marker with a null resolution rather than a new marker name.
    console.warn("[zone-effort-clamped]", { model, requested, resolved: null });
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
        recommendedTier: m.recommendedTier,
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

/**
 * MUST take the same override as `effortLevelsFor`, and this is not defensive symmetry.
 *
 * These two read INDEPENDENT sets — `EFFORT_SUPPORTED_MODELS` and `MODEL_EFFORT_LEVELS` — and every
 * consumer gates on both in sequence (`resolvedEffort && supportsEffort(model)`). Overriding only
 * the levels would let an effort resolve and then be silently discarded one line later: a brand-new
 * silent drop manufactured by the override layer itself. A profile that declares a non-empty ladder
 * is by definition declaring that the model supports effort.
 */
export function supportsEffort(id: string, caps?: ModelCapabilities): boolean {
  if (caps?.effortLevels !== undefined) return caps.effortLevels.length > 0;
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

/** True when the model accepts image input. Defaults to true for unknown/unlisted models. */
export function supportsVision(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  for (const options of Object.values(MODEL_CATALOG)) {
    const entry = options.find((m) => normalizeModelId(m.id) === normalized);
    if (entry) return entry.supportsVision !== false;
  }
  return true; // unknown model: optimistic default
}
