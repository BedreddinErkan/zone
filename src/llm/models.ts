import type { LLMProvider, ModelCapabilities } from "./types.js";
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

/**
 * Row order is EDITORIAL and this literal is the only thing that encodes it: `buildModels()`
 * iterates, nothing sorts, so the array's order is the picker's order. Anthropic first (Zone's
 * default provider); within it three pinned leaders, then each family newest-first with the pinned
 * member not repeated. OpenAI second: newest family first, strongest first inside a family, legacy
 * families last. `modelCatalogOrder.test.ts` pins the exact sequence — a new entry dropped in the
 * wrong place fails there, which is the only place it can be caught.
 *
 * Reordering is safe against `getDefaultModelForTier`'s first-match `.find` ONLY while each
 * provider carries at most one entry per `recommendedTier` value; that same test guards it.
 */
export const MODEL_CATALOG: Record<LLMProvider, ModelOption[]> = {
  anthropic: [
    {
      id: "claude-fable-5",
      label: "Claude Fable 5",
      // Deliberately says nothing about retention: the structured field below drives
      // the picker's own disclosure, and repeating it here would say it twice.
      costNote: "Opt-in frontier — $10/$50 per MTok · verify budget",
      retention: { minDays: 30, zdrAvailable: false },
    },
    {
      id: "claude-opus-5",
      label: "Claude Opus 5",
      costNote: "Frontier — $5/$25 per MTok",
    },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
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
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      recommendedTier: "high",
    },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", costNote: "Legacy — Sonnet 4.6 recommended" },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      recommendedTier: "standard",
    },
  ],
  openai: [
    { id: "gpt-5.6-sol",   label: "GPT-5.6 Sol",
      costNote: formatCostNote("openai", "gpt-5.6-sol") },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra",
      costNote: formatCostNote("openai", "gpt-5.6-terra") },
    { id: "gpt-5.6-luna",  label: "GPT-5.6 Luna",
      costNote: formatCostNote("openai", "gpt-5.6-luna") },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      costNote: formatCostNote("openai", "gpt-5.5"),
    },
    { id: "gpt-5.4",      label: "GPT-5.4",
      costNote: formatCostNote("openai", "gpt-5.4") },
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini",
      costNote: formatCostNote("openai", "gpt-5.4-mini") },
    { id: "gpt-5.4-nano", label: "GPT-5.4 nano",
      costNote: formatCostNote("openai", "gpt-5.4-nano") },
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
  "claude-opus-5":     1_000_000, // default AND maximum — no smaller variant
  "claude-fable-5":    1_000_000,
  "claude-sonnet-5":   1_000_000,
  "claude-opus-4-8":   1_000_000,
  "claude-opus-4-7":   1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-sonnet-4-5": 1_000_000,
  "claude-haiku-4-5":    200_000,
  // OpenAI — 128k conservative for GPT-5.x; exact values vary by release
  "gpt-5.6-sol":       1_050_000,
  "gpt-5.6-terra":     1_050_000,
  "gpt-5.6-luna":      1_050_000,
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
export function getContextWindow(modelId: string, caps?: ModelCapabilities): number {
  // Profile override → global table → conservative default. Checked first so a gateway model id
  // the table cannot match still gets its real window instead of the 200k assumption, and so the
  // fallback warning below does not fire for a model the profile has actually declared.
  if (caps?.contextWindow !== undefined) return caps.contextWindow;
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
  // @unverified-probe(claude-opus-5) ceiling documented, never measured — the
  // Anthropic account's credit balance is exhausted, and the billing check runs
  // BEFORE parameter validation, so no probe of any shape returns a ceiling.
  "claude-opus-5":     128_000,
  // @unverified-probe(claude-fable-5) ceiling documented, never measured — same
  // blocker as Opus 5: the Anthropic credit check precedes parameter validation.
  "claude-fable-5":    128_000,
  "claude-sonnet-5":   128_000, // verified
  "claude-opus-4-8":    64_000, // family value (claude-opus-4-5 verified at 64k)
  "claude-opus-4-7":    64_000, // family value
  "claude-sonnet-4-6":  64_000, // family value (claude-sonnet-4-5 verified at 64k)
  "claude-sonnet-4-5":  64_000, // verified
  "claude-haiku-4-5":   64_000, // verified
  // @unverified-probe(gpt-5.6-sol) documented ceiling; the Responses API accepts any
  // max_output_tokens without validating it (999999 was echoed back and the request
  // completed), so over-asking yields no error to read a real limit from.
  "gpt-5.6-sol":       128_000,
  // @unverified-probe(gpt-5.6-terra) same: no ceiling error is obtainable from the API.
  "gpt-5.6-terra":     128_000,
  // @unverified-probe(gpt-5.6-luna) same: no ceiling error is obtainable from the API.
  "gpt-5.6-luna":      128_000,
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

/**
 * Output budget for auxiliary one-shot calls — plan generation, the compaction
 * summarizer, the final run report. Each produces a bounded artifact and none needs
 * the model's full ceiling, but passing no budget makes convertParams inject that
 * ceiling (up to 128k) onto a single held non-streaming connection.
 *
 * The value is anchored to a recorded failure rather than an estimate of typical
 * size. When this defaulted to 4096, a real plan-gen call on claude-sonnet-5 came
 * back with stop_reason "max_tokens" and JSON that threw
 * `Unterminated string in JSON at position 5338`. This is four times the budget that
 * demonstrably truncated, and it coincides with the high-effort thinking floor, so
 * thinking models are unaffected at default effort.
 *
 * A ceiling, not a floor: convertParams still applies Math.max(budget,
 * effortFloor), so xhigh/max raise it to 32000/64000 as before.
 */
export const AUX_CALL_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Models whose catalog parameters were taken from vendor documentation and never
 * measured against the live API, with the parameters in question.
 *
 * Every entry here has a matching marker at the value it describes: an at-sign
 * "unverified-probe" tag followed by the model id in parentheses. Grepping that tag
 * yields the exact re-probe checklist — nothing more, nothing less, which is why no
 * prose anywhere writes the tag literally, including this sentence. Clear the marker
 * and the entry together;
 * `models.unverified.test.ts` fails if the two drift apart, both when an unmarked
 * entry appears and when a probe clears one and the checklist is left behind.
 *
 * A documented-but-unmeasured ceiling is recorded at its documented value rather
 * than a conservative guess: convertParams clamps to it, so a too-high value
 * produces a loud 400 naming the real limit, while a too-low one truncates output
 * silently. Being wrong loudly is the better failure.
 */
export const UNVERIFIED_MODEL_PARAMS: Record<string, readonly string[]> = {
  "claude-opus-5": ["maxOutputTokens", "adaptiveThinking"],
  "claude-fable-5": ["maxOutputTokens", "adaptiveThinking"],
  "gpt-5.6-sol": ["maxOutputTokens"],
  "gpt-5.6-terra": ["maxOutputTokens"],
  "gpt-5.6-luna": ["maxOutputTokens"],
};

/**
 * Claims carrying the same marker that are NOT about a model's catalog parameters,
 * keyed by the id used in the marker. They share the checklist so that grepping the
 * tag stays a complete to-do list, but they drive no runtime warning — there is no
 * model selection to hang one off.
 */
export const UNVERIFIED_NON_MODEL_PROBES: Record<string, string> = {
  "transport:long-request":
    "That a non-streaming request actually survives past ten minutes end to end. " +
    "The derived timeout and the undici dispatcher prove Zone asks for it; only a " +
    "live long generation proves the vendor's edge holds the connection.",
  "remote:ask-user-unwired":
    "That a remote client can answer an ask_user question. The event now crosses " +
    "the wire with its body intact and toWireFrame no longer drops unmapped fields " +
    "silently, but NO remote client renders the question or routes an answer back, " +
    "and the loop refuses to park for any channel that is not the TUI. Wiring it " +
    "means adding the channel to the allowlist AND a client that can reply — the " +
    "allowlist is the safety property; do not relax it to make a client appear to work.",
  "model:ask-user-judgement":
    "That the model uses ask_user with judgement — asking only when the answer " +
    "changes what it builds and the repo cannot supply it. Every mechanism here is " +
    "unit-proven; only a live run shows whether the prompt discipline holds. Watch " +
    "[zone-ask-user] clustering after investigation rather than at iter 0, and " +
    "[zone-ask-user-refused] reason=pre_investigation trending to zero.",
};

/** Model IDs already warned about — resolution runs per request, the gap is per config. */
const unverifiedParamsWarned = new Set<string>();

/** Test-only: clear the once-per-model unverified-params warning dedupe. */
export function _resetUnverifiedModelWarningsForTest(): void {
  unverifiedParamsWarned.clear();
}

/** Exact match, then longest-prefix, so dated snapshot IDs resolve to their alias. */
function resolveUnverifiedKey(modelId: string): string | undefined {
  if (modelId in UNVERIFIED_MODEL_PARAMS) return modelId;
  let best = "";
  for (const key of Object.keys(UNVERIFIED_MODEL_PARAMS)) {
    if (modelId.startsWith(key) && key.length > best.length) best = key;
  }
  return best || undefined;
}

/**
 * Announce, once per model, that a model in use carries assumed rather than measured
 * parameters. Called from getMaxOutputTokens because every request path resolves an
 * output budget, so this covers TUI selection, `--model`, and subagents alike.
 */
export function warnIfUnverifiedModelParams(modelId: string): void {
  const key = resolveUnverifiedKey(modelId);
  if (!key || unverifiedParamsWarned.has(key)) return;
  unverifiedParamsWarned.add(key);
  console.warn(
    "[zone-unverified-model-params]",
    JSON.stringify({
      modelId: key,
      unverified: UNVERIFIED_MODEL_PARAMS[key],
      impact:
        "these values come from vendor documentation, not from a live probe; " +
        "re-probe and clear the matching unverified-probe markers",
    })
  );
}

/** The model's declared output ceiling, or undefined when the model is unlisted.
 *  Exact match first, then longest-prefix (dated snapshot IDs). Callers that must
 *  clamp use this; callers that just need a budget use getMaxOutputTokens. */
export function lookupMaxOutputTokens(
  modelId: string,
  caps?: ModelCapabilities
): number | undefined {
  if (caps?.maxOutputTokens !== undefined) return caps.maxOutputTokens;
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
export function getMaxOutputTokens(modelId: string, caps?: ModelCapabilities): number {
  // The warn stays FIRST and unconditional: it reports a known-but-unprobed catalog model, which is
  // a fact about the catalog and not about which ceiling this call ends up using. Moving the
  // override above it would silence that report for a profile-declared model.
  warnIfUnverifiedModelParams(modelId);
  return lookupMaxOutputTokens(modelId, caps) ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Smallest prompt a model will actually cache, in characters (4 chars ≈ 1 token).
 * Below the vendor's minimum the API silently no-ops the cache_control marker, so
 * asking for a breakpoint there costs nothing but gains nothing.
 *
 * Only models whose minimum differs from the default belong here.
 */
export const MODEL_CACHE_MIN_CHARS: Record<string, number> = {
  "claude-opus-5": 2_048, // 512-token minimum, a quarter of the Sonnet-era 2048
};

/** Cache minimum for models absent from MODEL_CACHE_MIN_CHARS: the ~2048-token
 *  figure Sonnet 4.x requires, which is what every model used before this map. */
export const DEFAULT_CACHE_MIN_CHARS = 8_200;

/** Exact match, then longest-prefix, so dated snapshot IDs resolve to their alias. */
export function getCacheMinChars(modelId: string, caps?: ModelCapabilities): number {
  if (caps?.cacheMinChars !== undefined) return caps.cacheMinChars;
  if (modelId in MODEL_CACHE_MIN_CHARS) return MODEL_CACHE_MIN_CHARS[modelId];
  let best = "";
  for (const key of Object.keys(MODEL_CACHE_MIN_CHARS)) {
    if (modelId.startsWith(key) && key.length > best.length) best = key;
  }
  return best ? MODEL_CACHE_MIN_CHARS[best] : DEFAULT_CACHE_MIN_CHARS;
}
