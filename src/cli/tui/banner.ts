import chalk from "chalk";
import { role } from "./theme.js";

/**
 * The persistent startup line, written once to raw stdout before the Ink tree mounts so it stays
 * in native scrollback.
 *
 * Extracted from index.tsx purely so it is testable — the same reason resize.ts's own redraw pair
 * was extracted. A function that writes to process.stdout cannot be asserted on byte-for-byte
 * without capturing a global; a function that returns a string can.
 *
 * **Why this formats through chalk rather than a hardcoded escape.** It used to carry
 * `38;5;80` — the ANSI-256 index chalk produces for role.brand's hex — with a comment claiming it
 * matched what an Ink-rendered role.brand element "degrades to on the same terminal". That
 * generalised a measurement taken while chalk happened to be capped below truecolor. Chalk's level
 * is decided by an ordered chain of environment short-circuits (TTY, TERM, COLORTERM, CI), and on a
 * terminal reporting COLORTERM=truecolor Ink does not degrade at all: it emits the RGB components.
 * The banner and the brand colour beside it were therefore two visibly different teals.
 *
 * Ink's own `colorize` calls `chalk.hex(color)(str)` for a hex-shaped colour, and there is exactly
 * one hoisted chalk instance in this tree, so formatting here through the same call makes the
 * banner's bytes identical to any `<Text color={role.brand}>` at every level, by construction
 * rather than by a maintained approximation of one level's output.
 *
 * Weight is deliberate and pinned by the test, not incidental: the version is **bold** in
 * role.brand, and both the resumed marker and the path/branch tail are **dim**. That is what the
 * hardcoded escapes encoded before this change, preserved exactly.
 *
 * **Composition order is load-bearing and was measured, not assumed.** Ink's Text applies dim,
 * then colour, then bold — so bold ends up the OUTERMOST wrapper. A natural-looking
 * `chalk.hex(...).bold(...)` puts colour outside instead and emits the same styles in the opposite
 * nesting, which renders identically but is not the same bytes. Mirroring Ink's composition
 * literally is what keeps this byte-equal to a real `<Text color={role.brand} bold>`; the
 * divergence was caught only because the test compares against an Ink-rendered frame rather than
 * against a hand-rolled chalk call.
 */
export function buildBannerLine(opts: {
  version: string;
  cwd: string;
  branch: string;
  isResumed: boolean;
}): string {
  const cwdBranch = opts.branch ? `${opts.cwd} · ${opts.branch}` : opts.cwd;
  // Nesting mirrors Ink's Text: colour applied first, bold wrapped around it.
  const version = chalk.bold(chalk.hex(role.brand)(`Zone v${opts.version}`));
  const resumed = opts.isResumed ? ` ${chalk.dim("(resumed)")}` : "";
  // Model and cap are shown by the reactive StatusBar — not repeated here. No leading marker:
  // the splash's own mark was removed outright rather than replaced, and the diagonal carries the
  // font-substitution risk the palette pass measured, so this follows the landing's own header,
  // which carries no glyph either.
  return `${version}${resumed}  ${chalk.dim(cwdBranch)}\n\n`;
}
