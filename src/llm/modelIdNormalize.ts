/**
 * The single model-id normalizer. One implementation, two consumers — `modelRegistry.ts`
 * (capability lookups) and `usage/pricing.ts` (rate lookups).
 *
 * **Why this module exists rather than a shared constant in either consumer.** Two independent
 * normalizations existed and had already silently diverged: `modelRegistry.ts` stripped only the
 * Anthropic snapshot spelling, while `pricing.ts` stripped both. The consequence was measured, not
 * theorised — `supportsEffort("gpt-5.5-2026-04-23")` returned false, so a dated OpenAI id received
 * no `reasoning` object at all: no `effort`, and (once it shipped) no `summary`. Pricing resolved
 * the same id correctly the whole time. Aligning the two copies would have fixed today's symptom
 * and left the actual defect — two implementations free to diverge again — fully intact.
 *
 * **Why a third module rather than putting it in one of the two.** Import direction forbids it,
 * measured: `pricing.ts` imports nothing (it is a leaf) and the existing chain runs
 * `modelRegistry -> models -> pricing`. Exporting from `modelRegistry` and importing that from
 * `pricing` closes a cycle. A leaf both can point at is the only direction that does not.
 *
 * **What the patterns cover, and what they deliberately do not** (the standing rule for any stored
 * pattern in this repo):
 *   - `-YYYYMMDD`   — the Anthropic snapshot spelling, e.g. `claude-sonnet-4-6-20260219`.
 *   - `-YYYY-MM-DD` — the OpenAI snapshot spelling, e.g. `gpt-5.5-2026-04-23`.
 *   - **Not validated as dates.** `-\d{4}-\d{2}-\d{2}$` matches `-9999-99-99`, and `-\d{8}$`
 *     matches any eight digits at all — `x-12345678` normalizes to `x` (both measured). Validating
 *     them is deliberately out of scope: the id space is the provider's, a stricter pattern would
 *     reject a snapshot spelling the provider is free to invent, and the failure mode of over-
 *     matching here is a lookup miss that falls back to a default, not a wrong rate or capability.
 *   - **No other transformation.** No casing change, no trimming, no provider-prefix stripping.
 *     Both former implementations did exactly these replacements and nothing else; this is a
 *     lift, not a redesign.
 *
 * **Order is irrelevant, and that is a measured property rather than an accident of the current
 * arrangement.** The two patterns have zero overlap across every shape either consumer sees —
 * an eight-digit run contains no hyphens, so it cannot match the hyphen-separated form, and vice
 * versa — so both orders produce identical output on every id tested, including adversarial ones.
 * A mutation that reverses them is therefore expected to survive; that survivor is inert by
 * construction, not a gap in coverage.
 */

/** Anthropic snapshot suffix: `-` followed by exactly eight digits, anchored to the end. */
const ANTHROPIC_SNAPSHOT_SUFFIX = /-\d{8}$/;

/** OpenAI snapshot suffix: `-YYYY-MM-DD`, anchored to the end. Not date-validated — see the
 *  module comment for why over-matching is the safe direction here. */
const OPENAI_SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

/**
 * Strip a trailing snapshot suffix in either provider's spelling so a dated id resolves to the
 * same catalog entry as its base alias. A no-op for ids that carry neither suffix.
 *
 * `"claude-sonnet-4-6-20260219"` → `"claude-sonnet-4-6"`
 * `"gpt-5.5-2026-04-23"`         → `"gpt-5.5"`
 * `"gpt-5.4-nano"`               → `"gpt-5.4-nano"`
 */
export function normalizeModelId(id: string): string {
  return id.replace(ANTHROPIC_SNAPSHOT_SUFFIX, "").replace(OPENAI_SNAPSHOT_SUFFIX, "");
}
