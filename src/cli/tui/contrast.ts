/**
 * WCAG relative-luminance contrast, extracted so the theme's tests and any future runtime check
 * read one implementation rather than two copies of the same formula.
 *
 * It lived inside theme.test.ts, whose own comment explained why it was test-only: a contrast ratio
 * is computable only "once both sides of a pairing are real hex", and at the time exactly one
 * pairing qualified. A second pairing now does, which is what makes a shared module worth more than
 * a local helper.
 *
 * Deliberately imports nothing from theme.ts. It is colour arithmetic, not a consumer of the seam,
 * so it stays outside themeCoverage.test.ts's declared-importer sweep — that sweep's whole
 * mechanism is "a file consuming the seam is a file importing it", and a module that imports
 * nothing would have to be declared for a reason unrelated to what it does.
 *
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */

/** One sRGB channel (0-255) converted to its linear-light value. */
function hexToLinear(component: number): number {
  const c = component / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance of a `#rrggbb` colour. Throws on anything else rather than returning a
 *  plausible number for an unparseable input — a NaN here would silently pass every threshold
 *  comparison, since NaN >= 7 is false but NaN < 1.2 is also false. */
export function relativeLuminance(hex: string): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`relativeLuminance expects #rrggbb, got ${JSON.stringify(hex)}`);
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * hexToLinear(r) + 0.7152 * hexToLinear(g) + 0.0722 * hexToLinear(b);
}

/** Contrast ratio between two `#rrggbb` colours, 1 (identical) to 21 (black on white). Order of
 *  arguments does not matter. */
export function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  return (Math.max(lA, lB) + 0.05) / (Math.min(lA, lB) + 0.05);
}
