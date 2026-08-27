/**
 * The one place that decides which model rows the picker shows, and therefore the one place that
 * decides what an index into that list means.
 *
 * This module exists because two consumers need the SAME list and would otherwise each derive it.
 * `store-core.ts` seeds `modelSelectedIndex` when the modal opens; `ModelModal.tsx` renders the
 * rows and maps that index back to an entry. If one indexed the unfiltered catalog while the other
 * rendered a filtered list, every index past the first hidden row would be off by the number of
 * rows hidden above it — and with only an Anthropic key configured the Anthropic group is
 * untouched, so the cursor would look correct in exactly the case a developer tests by hand and
 * wrong only when the hidden provider precedes the current model. Both callers import from here.
 */

import type { ModelEntry } from "../../llm/modelRegistry.js";

/**
 * The rows to render, in catalog order.
 *
 * - No provider has a resolved key ⇒ every row. An empty picker is worse than a long one, and a
 *   user with no keys still needs to see what they could configure.
 * - Otherwise: rows whose provider has a resolved key, PLUS the current model whatever its
 *   provider. Never hiding the current model is what keeps the seed below meaningful — a cursor
 *   cannot land on a row that is not rendered. A current model belonging to a filtered provider
 *   renders at its natural position, as the only row in its own provider section.
 *
 * Filtering only ever removes; it never reorders, so `modelCatalogOrder.test.ts`'s pinned sequence
 * still describes the relative order of whatever survives.
 */
export function visibleModelRows(
  all: readonly ModelEntry[],
  providersWithKey: readonly string[],
  currentModelId: string
): readonly ModelEntry[] {
  // Defensive on absence, not just on empty: a component rendered against a partially-mocked
  // store has no such field, and an unguarded `.length` blanks the entire modal instead of
  // degrading. "Not known" and "none configured" both correctly mean show every row.
  if (!providersWithKey || providersWithKey.length === 0) return all;
  const keyed = new Set(providersWithKey);
  return all.filter((m) => keyed.has(m.provider) || m.id === currentModelId);
}

/**
 * Where the cursor goes when the modal opens: the current model's row.
 *
 * Before this existed the index stayed at its initial 0, so opening /model put the cursor on the
 * first row while the model in use sat further down — twelve arrow presses away at the catalog
 * order this shipped with. Returns 0 when the current id is absent from the rows, which happens for
 * an id outside the catalog entirely, since the current model is never filtered out.
 *
 * That used to read "only for … a custom `--model`". It is no longer only that: `/model`'s free-text
 * entry can now set an off-catalog id from inside the modal itself, routed through a gateway
 * profile. The fallback behaviour is unchanged — a gateway model has no catalog row to seek to, so
 * the cursor starts at 0 — but the CAUSE is no longer unique, and the sentence claimed it was.
 */
export function selectedIndexForCurrent(
  rows: readonly ModelEntry[],
  currentModelId: string
): number {
  const idx = rows.findIndex((m) => m.id === currentModelId);
  return idx === -1 ? 0 : idx;
}

/** Rows removed by the filter. Zero when nothing is hidden, which is what suppresses the notice. */
export function hiddenRowCount(all: readonly ModelEntry[], rows: readonly ModelEntry[]): number {
  return all.length - rows.length;
}
