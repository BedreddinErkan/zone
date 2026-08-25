/**
 * The picker's row order, pinned.
 *
 * Nothing asserted this before: no test referenced USER_FACING_MODELS by index or asserted any id
 * sequence, so the order was whatever the catalog literal happened to be and a misplaced new entry
 * would ship silently. The order is EDITORIAL — a judgment about what a coding agent's user wants
 * to see first — and no field in the data model encodes it. `recommendedTier` cannot: it has two
 * values, four of seventeen entries carry it, and it is a lookup key rather than a rank.
 * `ESCALATION_LADDERS` covers three ids per provider. So the array literal's order IS the order,
 * and this file is the only thing that can catch a misplacement.
 *
 * Self-reference guard: EXPECTED_ORDER is a fixed literal written HERE. It is never derived from
 * MODEL_CATALOG, from USER_FACING_MODELS, or from any sort — a pin computed from its own subject
 * asserts nothing, which this series has shipped three times.
 *
 * One assertion covers two producers: the literal's own order AND buildModels()'s provider
 * iteration order (Object.entries over MODEL_CATALOG). Swapping the two provider keys and swapping
 * two entries within one provider are both caught here, from one source.
 */

import { describe, it, expect } from "vitest";
import { MODEL_CATALOG, getDefaultModelForTier, type ZoneModelTier } from "./models.js";
import { USER_FACING_MODELS, getDefaultModelId } from "./modelRegistry.js";

/**
 * The intended row order, top to bottom, as the /model picker renders it.
 *
 * Anthropic first (Zone's default provider), then OpenAI. Within Anthropic: three pinned leaders,
 * then each family newest-first with the pinned member not repeated. Within OpenAI: newest family
 * first, strongest first inside a family, legacy families last. Both groups are hand-ordered
 * judgments, not computed — see the header.
 */
const EXPECTED_ORDER: readonly string[] = [
  // — Anthropic —
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  // — OpenAI —
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-4o",
  "gpt-4o-mini",
];

describe("harness floor — proven before the order claims below are trusted", () => {
  it("USER_FACING_MODELS is non-empty and carries string ids", () => {
    expect(USER_FACING_MODELS.length).toBeGreaterThan(0);
    for (const m of USER_FACING_MODELS) expect(typeof m.id).toBe("string");
  });

  it("EXPECTED_ORDER has no duplicates — a repeated id would make the comparison below misleading", () => {
    expect(new Set(EXPECTED_ORDER).size).toBe(EXPECTED_ORDER.length);
  });
});

describe("model picker — row order is pinned, because nothing else can catch a misplacement", () => {
  it("renders exactly this sequence", () => {
    expect(USER_FACING_MODELS.map((m) => m.id)).toEqual([...EXPECTED_ORDER]);
  });

  it("keeps each provider contiguous — ModelModal emits a section header on every provider change", () => {
    // Not a restatement of the sequence above: this is the structural property the picker's own
    // header logic depends on, and it would survive a future reorder that the pin was updated for.
    const seen = new Set<string>();
    let previous: string | null = null;
    for (const m of USER_FACING_MODELS) {
      if (m.provider !== previous) {
        expect(seen.has(m.provider), `provider ${m.provider} appears in more than one run`).toBe(false);
        seen.add(m.provider);
        previous = m.provider;
      }
    }
    expect(seen.size).toBe(2);
  });

  it("puts Anthropic first — Zone's default provider and the default model's provider", () => {
    expect(USER_FACING_MODELS[0]?.provider).toBe("anthropic");
    expect(getDefaultModelId().startsWith("claude-")).toBe(true);
  });
});

/**
 * The `.find` trap, guarded rather than decoupled.
 *
 * getDefaultModelForTier does MODEL_CATALOG[provider].find(m => m.recommendedTier === tier), which
 * returns the FIRST match. Today exactly one entry per (provider, tier) carries each value, so
 * reordering the literal cannot change any tier default — but that margin is one entry wide and
 * invisible in the source. A second entry carrying a value would make display order silently decide
 * tier lookup.
 *
 * SCOPE, stated so a later reader does not mistake this for a catalog-wide invariant and delete it
 * as redundant: this guards the `.find` lookup specifically. It is NOT a claim that recommendedTier
 * must be unique in general — it is a claim that while lookup is first-match, uniqueness within the
 * searched scope is what keeps display order and lookup order independent.
 */
describe("recommendedTier uniqueness — the guard that lets the literal be reordered safely", () => {
  const TIERS: ZoneModelTier[] = ["high", "standard"];

  it("each provider carries at most one entry per tier, so first-match cannot depend on order", () => {
    for (const [provider, models] of Object.entries(MODEL_CATALOG)) {
      for (const tier of TIERS) {
        const carriers = models.filter((m) => m.recommendedTier === tier).map((m) => m.id);
        expect(
          carriers.length,
          `${provider} has ${carriers.length} entries with recommendedTier="${tier}" (${carriers.join(", ")}) — ` +
            `while getDefaultModelForTier uses .find, a second carrier makes catalog ORDER decide the tier default`
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it("resolves to these exact ids — fixed literals, not values read back from the catalog", () => {
    expect(getDefaultModelForTier("anthropic", "high")).toBe("claude-sonnet-4-6");
    expect(getDefaultModelForTier("anthropic", "standard")).toBe("claude-haiku-4-5");
    expect(getDefaultModelForTier("openai", "high")).toBe("gpt-4o");
    expect(getDefaultModelForTier("openai", "standard")).toBe("gpt-4o-mini");
  });
});

/**
 * Item 320: `buildModels()` dropped `recommendedTier` between `ModelOption` and `ModelEntry`, so
 * the picker could not see a field the catalog populated. Carried through now.
 *
 * Stated because the entry is easy to over-read: carrying it is NOT what orders the list, and item
 * 320 never claimed it was. Two values across seventeen rows cannot rank them, and the field is a
 * first-match lookup key for getDefaultModelForTier. Order comes from the literal's own sequence.
 */
describe("item 320 — recommendedTier survives the ModelEntry projection", () => {
  it("carries the value for exactly the ids that declare it, with no invention", () => {
    const carried = USER_FACING_MODELS
      .filter((m) => m.recommendedTier !== undefined)
      .map((m) => `${m.id}:${m.recommendedTier}`)
      .sort();
    // Fixed literals — not read back from MODEL_CATALOG, which is the producer under test.
    expect(carried).toEqual([
      "claude-haiku-4-5:standard",
      "claude-sonnet-4-6:high",
      "gpt-4o-mini:standard",
      "gpt-4o:high",
    ]);
  });

  it("leaves every other entry undefined rather than defaulting it", () => {
    const without = USER_FACING_MODELS.filter((m) => m.recommendedTier === undefined);
    expect(without).toHaveLength(13);
  });
});
