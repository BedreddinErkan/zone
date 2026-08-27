import type { LLMProvider, ModelCapabilities } from "./types.js";
import {
  costFromRates,
  totalCost,
  type ModelRates,
  type ProviderName,
  type TokenType,
} from "../usage/pricing.js";

/**
 * ProviderProfile — the seam between "which wire protocol" and "which endpoint identity".
 *
 * `docs/gateway-support-investigation.md` ("The seam, named") establishes that Zone fuses two
 * separate ideas into one two-valued `LLMProvider`: the protocol (which adapter class and
 * conversion modules run) and the endpoint identity (which base URL, credential, capability table
 * and pricing table apply). `OpenAIAdapter`'s constructor already takes both — the seam exists and
 * is one argument wide; what was missing was a caller that passes it. This record is that caller's
 * vocabulary. It is Option B step 3 of that document's recommendation.
 *
 * `LLMProvider` keeps its type and changes meaning: it is now the PROTOCOL SELECTOR, which is what
 * `openaiAdapter.ts`'s third constructor parameter already treats it as (proven by
 * `openaiAdapter.responses.test.ts:125`, which constructs the adapter with `"anthropic"` and
 * asserts the Responses branch stays off).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * CONSTRAINTS THIS MODULE AND ITS CALLERS ARE UNDER, AND THE TEST THAT ENFORCES EACH
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * These are not style preferences. Each was derived from a named, currently-green test that goes
 * red if the rule is dropped, during a nine-agent adversarial verification over the 15 test files
 * that pin provider resolution (ledger item 387). A future reader sees only the code, so the
 * reasoning is recorded here rather than left in a transcript. Evidence quality is stated per rule
 * — some were confirmed by running a trial edit, most are static predictions, and the difference
 * matters.
 *
 * R1. THIS MODULE IS AN IMPORT LEAF.  [CONFIRMED by trial edit]
 *     Allowed: type-only `LLMProvider`, and `../usage/pricing.js` (itself a two-module chain
 *     ending at the dependency-free `modelIdNormalize.ts`). FORBIDDEN, value or default:
 *     `factory.js`, `modelRegistry.js`, `openaiContext.js`, `modelRouting.js`,
 *     `recordingClient.js`.
 *     Why: four test files mock `./factory.js` with a factory exporting ONLY `createLLMClient`
 *     (`agentLoop.runUsdCap.test.ts:42`, `agentLoop.usdCap.test.ts:39`, `taskClassifier.test.ts:13`,
 *     `agentLoop.recordRunSummary.test.ts:35`). Confirmed by adding a second export to `factory.ts`
 *     and calling it from `agentLoop.ts`: `agentLoop.runUsdCap.test.ts` died at module-init with
 *     "Tests: no tests" — the whole file, not one case.
 *     REFINEMENT the static prediction missed: the break needs the second export to be ACCESSED at
 *     runtime. A merely-imported, unused binding is elided by the transform and does NOT break the
 *     mock. So the hazard is narrower than "any second import" — but it is real.
 *     `TokenBudgetMeter.test.ts` has no `vi.mock` at all and loads the real graph, so any cycle
 *     introduced here surfaces there first as a TDZ ReferenceError.
 *
 * R2. The resolver is never re-exported from `factory.ts`. It lives only here. [follows from R1]
 *
 * R3. `resolveProfile` takes `context` as a PURE PARAMETER — it never calls `getRequestContext()`
 *     itself. That keeps it testable and avoids the forbidden `openaiContext.js` value import.
 *     [static]
 *
 * R4. Resolve once per run and thread the profile OBJECT; never re-resolve a provider string
 *     downstream with a fallback. `TokenBudgetMeter`'s `provider as ProviderName` cast and
 *     `taskClassifier`'s pricing ternary both receive an already-resolved profile. Re-resolving
 *     would turn today's "unknown provider -> $0 plus a [zone-pricing] warning" into "unknown
 *     provider -> charged at anthropic rates", which is worse than the defect being fixed.
 *     [static]
 *
 * R5. `createLLMClient` keeps its throw. Today an unrecognized provider reaches
 *     `factory.ts`'s `throw new Error("Unsupported provider: ...")`; it passes `onUnrecognized`
 *     so that throw survives rather than silently becoming a warn-and-fall-back. Unreachable while
 *     `LLMProvider` is two-valued, and therefore not runnable — but still a behaviour change if
 *     dropped. [static, and unreachable by construction]
 *
 * R6. `getModelForRole` call sites stay at EXACTLY TWO arguments.  [CONFIRMED by trial edit]
 *     Five assertions pin the whole args array. Adding a third parameter spelled `undefined`
 *     produces `["worker","openai",undefined]`, which is not array-equal to `["worker","openai"]`.
 *     Confirmed: 2 of 3 failed in `subagentDispatch.test.ts` and 3 of 4 in
 *     `toolExecutor.workerModel.test.ts` — 5 total, exactly as predicted.
 *
 * R7. `cli/config.ts` compares via `providerOf(resolveProfile(...)) !== provider`, never object
 *     identity.  [CONFIRMED by trial edit]
 *     An identity comparison is always-true once profiles are cloned or frozen, which fires the
 *     model/provider conflict warning on AGREEING pairs. Confirmed by forcing that condition true:
 *     `config.test.ts` went to 5 failed / 40 passed. The static prediction named 3 tests; the real
 *     number is 5, so the estimate UNDERCOUNTED.
 *     Also, still at that site and [static]: interpolate the RAW `explicitProvider` in the conflict
 *     message rather than `profile.id` (`config.test.ts` pins the string byte-exact), and keep the
 *     model pin outranking context.
 *
 * R8. Every observable provider field stays a STRING, never the profile object — `UsageRecord`,
 *     `recordRunSummary({provider})`, `[zone-task-classifier-failure].provider`. [static]
 *
 * R9. The `RecordingLLMClient` site is the one rewired site with no static default: its "own
 *     current default" is `profileForProvider(inner.provider)`. [static]
 *
 * R10. The warn-once helpers below use `console.warn` with their own marker strings — not
 *      `utils/logger.js` (three test files mock it with exactly three exports). [static]
 *
 * R11. Both built-in constants carry `satisfies ProviderProfile`, and `ProfileCapabilities` is
 *      declared rather than referenced undeclared. [compile-enforced by tsc]
 */

/**
 * Per-profile capability overrides, consulted BEFORE the global per-model tables. Step 4 of the
 * recommendation; step 3 declared this as an empty placeholder and this is its real shape.
 *
 * NAMING HAZARD: `ModelCapabilities` (what a MODEL supports) is not `src/tools/capabilities.ts`'s
 * `Capability` (what a TOOL may do — `fs.write`, `shell.exec`). See that type's own note and ledger
 * item 393.
 *
 * Matching is EXACT on the model id as the caller passes it — no normalization, no prefix walk.
 * That is a deliberate third strategy, chosen because the two existing ones disagree: `models.ts`
 * does raw-exact-then-longest-prefix while `modelRegistry.ts` does normalize-then-exact, and they
 * already return different answers for the same id (a `-beta` suffix resolves a context window but
 * no effort levels). A profile author writes the id their endpoint actually uses, so predictable
 * beats clever here; `default` covers everything else this profile serves.
 */
export type ProfileCapabilities = {
  /** Keyed by the exact model id. Wins over `default`. */
  models?: Readonly<Record<string, ModelCapabilities>>;
  /** Applied to any model this profile serves with no entry in `models`. */
  default?: ModelCapabilities;
};

/**
 * The capability overrides this profile declares for `model`, or `undefined` when it declares none.
 *
 * `undefined` is the signal every consumer keys on: it means "this profile says nothing", and the
 * consumer falls through to the global table exactly as before. A profile that declares SOME fields
 * gets a merged object — per-model entries win field-by-field over `default`, so a profile can set
 * a shared context window once and override the output ceiling for one model.
 */
export function capabilitiesFor(
  profile: ProviderProfile | undefined,
  model: string
): ModelCapabilities | undefined {
  const caps = profile?.capabilities;
  if (!caps) return undefined;
  const perModel = caps.models?.[model];
  if (!perModel && !caps.default) return undefined;
  if (!perModel) return caps.default;
  if (!caps.default) return perModel;
  return { ...caps.default, ...perModel };
}

/** Which wire protocol an endpoint speaks. Decides the adapter class and conversion modules. */
export type WireProtocol = "anthropic-messages" | "openai-chat";

/**
 * How to find this profile's credential. Names the EXISTING env var and the EXISTING `keys.json`
 * `provider` value — this pass makes no key-store schema change (that is step 5).
 */
export type KeyRef = {
  envVar: string;
  keyStoreProvider?: ProviderName;
  /** Shown in the ApiKeyError text when a key looks like a placeholder. */
  keyExample: string;
};

/**
 * How this endpoint's calls are priced. ABSENT means the profile cannot price at all — cost for it
 * is UNKNOWN, never `0`.
 *
 * `rates` is consulted before `table`, so a gateway can declare rates for model ids no global table
 * knows without needing an entry added to `PRICING_USD_PER_MTOK`. Both are optional: a profile with
 * neither is the unpriceable case.
 */
export type PricingRef = {
  /** Names a table in `usage/pricing.ts`. Consulted only when `rates` has no entry for the model. */
  table?: ProviderName;
  /** Inline per-model rates, keyed by exact model id. Consulted first. */
  rates?: Readonly<Record<string, ModelRates>>;
};

export type ProviderProfile = {
  id: string;
  protocol: WireProtocol;
  baseUrl?: string;
  keyRef: KeyRef;
  /**
   * The `LLMProvider` handed to the adapter. Today this equals the identity as well — the very
   * fusion this record exists to split. A gateway profile would need a third `LLMProvider` member
   * to keep the Responses branch off, which is Option A's widening and is out of scope here; so
   * only the two built-ins are expressible today. Recorded as a known limitation in item 387.
   */
  adapterProvider: LLMProvider;
  capabilities?: ProfileCapabilities;
  /** Absent => this profile cannot price. Cost for it is UNKNOWN, never 0. */
  pricing?: PricingRef;
};

export const ANTHROPIC_PROFILE = {
  id: "anthropic",
  protocol: "anthropic-messages",
  adapterProvider: "anthropic",
  keyRef: {
    envVar: "ANTHROPIC_API_KEY",
    keyStoreProvider: "anthropic",
    keyExample: "sk-ant-…",
  },
  pricing: { table: "anthropic" },
} satisfies ProviderProfile;

export const OPENAI_PROFILE = {
  id: "openai",
  protocol: "openai-chat",
  adapterProvider: "openai",
  keyRef: {
    envVar: "OPENAI_API_KEY",
    keyStoreProvider: "openai",
    keyExample: "sk-…",
  },
  pricing: { table: "openai" },
} satisfies ProviderProfile;

const BUILTIN_PROFILES: Record<LLMProvider, ProviderProfile> = {
  anthropic: ANTHROPIC_PROFILE,
  openai: OPENAI_PROFILE,
};

/** The protocol selector for a profile — what the adapter layer and every existing string-typed
 *  provider field still expect (R8). */
export function providerOf(profile: ProviderProfile): LLMProvider {
  return profile.adapterProvider;
}

export function profileForProvider(provider: LLMProvider): ProviderProfile {
  return BUILTIN_PROFILES[provider];
}

function isBuiltinId(value: string): value is LLMProvider {
  return value === "anthropic" || value === "openai";
}

/**
 * True for a profile that came from user configuration rather than being one of the two built-ins.
 *
 * The one behavioural consequence today is in `getModelName`: Zone's model catalog describes the two
 * VENDORS, so for a gateway an id absent from it is UNKNOWN, not INVALID, and substituting a vendor
 * default would send the call to an endpoint that does not serve that model. Measured before the
 * distinction was drawn: `openai/gpt-4o-mini` — the id the LiteLLM lab proxy actually serves —
 * resolved to `gpt-4o-mini` under provider "openai" and to `claude-haiku-4-5` under "anthropic".
 */
export function isGatewayProfile(profile: ProviderProfile | undefined): boolean {
  return profile !== undefined && !isBuiltinId(profile.id);
}

/**
 * The one resolver the defaulting sites delegate to.
 *
 * `fallback` is a REQUIRED, EXPLICIT argument rather than a constant inside this function, and that
 * is the whole point. The twelve sites `docs/gateway-support-investigation.md` §2.4 counted do not
 * agree on a default — six fall back to `"anthropic"` and six to `"openai"` — so a resolver with
 * one built-in default would change behaviour at six of them and break the characterization
 * baseline item 386 established. Passing each site's own default preserves the divergence exactly
 * while making it visible at one grep (`resolveProfile(` callers) instead of twelve hidden
 * literals. Unifying the fallbacks later becomes a single deliberate decision rather than twelve.
 *
 * Precedence, matching what every one of those sites already does:
 *   1. `explicit` (a raw, possibly-unrecognized string)
 *   2. `context` (the per-request provider)
 *   3. `fallback` (this site's own current default)
 */
export function resolveProfile(input: {
  explicit?: string;
  context?: LLMProvider;
  fallback: LLMProvider;
  onUnrecognized?: (value: string) => void;
}): ProviderProfile {
  const { explicit, context, fallback, onUnrecognized } = input;
  if (explicit !== undefined && explicit !== "") {
    if (isBuiltinId(explicit)) return BUILTIN_PROFILES[explicit];
    onUnrecognized?.(explicit);
    return BUILTIN_PROFILES[fallback];
  }
  if (context) return BUILTIN_PROFILES[context];
  return BUILTIN_PROFILES[fallback];
}

/**
 * A priced amount, or an explicit statement that this profile cannot price.
 *
 * The distinction exists at the type level because today "cannot price" and "free" are the same
 * value — `0` — which is why an unpriceable run records as free and slips past every dollar gate.
 * `totalCost`'s own `!rates` branch keeps returning `0` for an unknown MODEL inside a KNOWN table;
 * that is item 299's separate concern and is deliberately untouched here.
 */
export type PricedUsd =
  | { known: true; usd: number }
  | { known: false; reason: "no_pricing_for_profile" };

/**
 * Price a usage breakdown against a profile's own table.
 *
 * Deliberately does NOT round — rounding stays at the existing call sites, and importing `round4`
 * from `usageTracker.js` would break `recordingClient.test.ts`'s one-export mock of that module.
 */
export function priceForProfile(
  profile: ProviderProfile,
  model: string,
  breakdown: Record<TokenType, number>
): PricedUsd {
  const pricing = profile.pricing;
  if (!pricing) return { known: false, reason: "no_pricing_for_profile" };
  // Inline rates first — a gateway declares rates for ids no global table knows. Uses the same
  // arithmetic totalCost does (long-context threshold included), via the helper both share, so an
  // inline-priced call and a table-priced one cannot drift apart.
  const inline = pricing.rates?.[model];
  if (inline) return { known: true, usd: costFromRates(inline, breakdown) };
  if (pricing.table) return { known: true, usd: totalCost(pricing.table, model, breakdown) };
  // Declared a pricing block but nothing in it answers for this model: still unknown, not zero.
  return { known: false, reason: "no_pricing_for_profile" };
}

// ─── Warn-once helpers ───────────────────────────────────────────────────────────────────────
//
// Mirrors the house idiom: a module-level Set plus a `_reset…ForTest` export, as
// `webSearchWarning.ts` and `recordingClient.ts`'s usage-partition warning already do. Uses
// `console.warn` with its own marker strings rather than `utils/logger.js` (R10).

const _warnedNoPricing = new Set<string>();
const _warnedInertBudget = new Set<string>();

/**
 * Fired once per profile when a profile that cannot price is selected. Without it, an unpriceable
 * endpoint records every run as `$0` and nothing anywhere says so.
 */
export function warnProfileCannotPriceOnce(profile: ProviderProfile): void {
  if (profile.pricing) return;
  if (_warnedNoPricing.has(profile.id)) return;
  _warnedNoPricing.add(profile.id);
  console.warn(
    `[zone-profile-no-pricing] provider profile "${profile.id}" has no pricing table; ` +
      `cost for this run is recorded as unknown, not $0.`
  );
}

/**
 * Fired once per profile when `--max-budget-usd` is set on a run whose profile cannot price.
 * Separate from the warning above because the consequence is different and worse: the per-run
 * ceiling compares against a cost that never leaves zero, so the gate never fires and an
 * ostensibly capped run proceeds to its iteration limit.
 */
export function warnBudgetGateInertOnce(profile: ProviderProfile, capUsd: number): void {
  if (profile.pricing) return;
  if (_warnedInertBudget.has(profile.id)) return;
  _warnedInertBudget.add(profile.id);
  console.warn(
    `[zone-budget-gate-inert] --max-budget-usd $${capUsd.toFixed(2)} cannot be enforced: ` +
      `provider profile "${profile.id}" has no pricing table, so this run's spend is unknown ` +
      `and the ceiling will never trigger.`
  );
}

export function _resetProviderProfileWarningsForTest(): void {
  _warnedNoPricing.clear();
  _warnedInertBudget.clear();
}
