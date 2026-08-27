/**
 * The seed and the filter, tested TOGETHER — which is the case neither one's own test covers.
 *
 * Seeding `modelSelectedIndex` and filtering rows by configured key are separate changes, and each
 * is easy to test alone: seed against the full catalog, filter without seeding. Composed, they have
 * a failure the separate tests cannot see — if the seed indexes the unfiltered catalog while the
 * modal renders a filtered list, every index past the first hidden row is off by however many rows
 * were removed above it. With only an Anthropic key that offset is ZERO for every Anthropic model,
 * because the hidden group sits below them. So the bug is invisible in the configuration a
 * developer most likely has, and appears only when the hidden provider PRECEDES the current model.
 * That is the case pinned below.
 *
 * Self-reference guard: expectations are fixed literals, never a value read back out of
 * USER_FACING_MODELS or recomputed with the functions under test.
 */

import { describe, it, expect } from "vitest";
import { visibleModelRows, selectedIndexForCurrent, hiddenRowCount } from "./modelPickerList.js";
import type { ModelEntry } from "../../llm/modelRegistry.js";

/** A hand-built catalog with the hidden provider FIRST — the arrangement that exposes the offset. */
const OPENAI_FIRST: readonly ModelEntry[] = [
  { id: "o-1", displayName: "O One", provider: "openai", supportsEffort: false },
  { id: "o-2", displayName: "O Two", provider: "openai", supportsEffort: false },
  { id: "o-3", displayName: "O Three", provider: "openai", supportsEffort: false },
  { id: "a-1", displayName: "A One", provider: "anthropic", supportsEffort: false },
  { id: "a-2", displayName: "A Two", provider: "anthropic", supportsEffort: false },
];

describe("harness floor — proven before the composition claims are trusted", () => {
  it("the fixture actually places the filtered-out provider before the current model", () => {
    expect(OPENAI_FIRST[0]!.provider).toBe("openai");
    expect(OPENAI_FIRST.findIndex((m) => m.id === "a-1")).toBe(3);
  });
});

describe("filter alone", () => {
  it("keeps only providers with a key", () => {
    expect(visibleModelRows(OPENAI_FIRST, ["anthropic"], "a-1").map((m) => m.id)).toEqual(["a-1", "a-2"]);
  });

  it("no keys at all shows every row — an empty picker is worse than a long one", () => {
    expect(visibleModelRows(OPENAI_FIRST, [], "a-1")).toHaveLength(5);
    expect(hiddenRowCount(OPENAI_FIRST, visibleModelRows(OPENAI_FIRST, [], "a-1"))).toBe(0);
  });

  it("never hides the current model, and leaves it at its natural position in its own section", () => {
    const rows = visibleModelRows(OPENAI_FIRST, ["anthropic"], "o-2");
    expect(rows.map((m) => m.id)).toEqual(["o-2", "a-1", "a-2"]);
    // Its provider run is still contiguous, so ModelModal still emits exactly two section headers.
    expect(rows[0]!.provider).toBe("openai");
  });

  it("counts what it hid", () => {
    expect(hiddenRowCount(OPENAI_FIRST, visibleModelRows(OPENAI_FIRST, ["anthropic"], "a-1"))).toBe(3);
  });
});

describe("seed alone", () => {
  it("lands on the current model rather than row 0", () => {
    expect(selectedIndexForCurrent(OPENAI_FIRST, "a-2")).toBe(4);
  });

  it("falls back to 0 for an id outside the list — a custom --model, or a gateway model id", () => {
    expect(selectedIndexForCurrent(OPENAI_FIRST, "not-a-catalog-id")).toBe(0);
  });
});

describe("THE COMPOSITION — the case neither test above can see", () => {
  it("filtering a provider that PRECEDES the current model still lands the cursor on it", () => {
    const current = "a-1";
    const rows = visibleModelRows(OPENAI_FIRST, ["anthropic"], current);
    const idx = selectedIndexForCurrent(rows, current);

    // Fixed literals: a-1 is index 3 unfiltered, index 0 once the three openai rows are gone.
    expect(idx).toBe(0);
    expect(rows[idx]!.id).toBe("a-1");

    // And the failure this pins: seeding against the UNFILTERED list would give 3, which indexes
    // past the end of a 2-row list entirely.
    expect(selectedIndexForCurrent(OPENAI_FIRST, current)).toBe(3);
    expect(rows[3]).toBeUndefined();
  });

  it("the cursor lands on the current model for EVERY row, under every key configuration", () => {
    // Exhaustive rather than sampled: an off-by-N survives a single well-chosen case.
    for (const keys of [[], ["anthropic"], ["openai"], ["anthropic", "openai"]]) {
      for (const entry of OPENAI_FIRST) {
        const rows = visibleModelRows(OPENAI_FIRST, keys, entry.id);
        const idx = selectedIndexForCurrent(rows, entry.id);
        expect(rows[idx]?.id, `keys=[${keys.join(",")}] current=${entry.id}`).toBe(entry.id);
      }
    }
  });

  it("negative control — a filter that hides NOTHING leaves the unfiltered index correct", () => {
    // Guards against a fix that satisfies the cases above by always returning 0.
    const rows = visibleModelRows(OPENAI_FIRST, ["anthropic", "openai"], "a-2");
    expect(rows).toHaveLength(5);
    expect(selectedIndexForCurrent(rows, "a-2")).toBe(4);
  });
});
