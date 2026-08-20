import React from "react";
import chalk from "chalk";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { buildBannerLine } from "./banner.js";
import { role } from "./theme.js";

/**
 * The banner is raw stdout, outside the Ink tree, so nothing else in the suite can catch it
 * drifting from the colour the Ink tree renders beside it. It drifted once already: a hardcoded
 * 256-colour escape matched Ink only while chalk happened to be capped below truecolor, and on a
 * terminal reporting COLORTERM=truecolor the two were visibly different teals.
 *
 * **These tests set `chalk.level` themselves rather than inheriting it.** The suite's own baseline
 * runs at level 0, where every colour byte vanishes and a colour assertion passes vacuously — the
 * failure mode is silent, so the regime is declared here per case instead of being borrowed from
 * whatever the shell happens to export.
 *
 * **The comparison is against an Ink-rendered frame, not against a hand-rolled `chalk.hex` call.**
 * Ink's `colorize` dispatches on the *shape* of the colour value — hex, rgb(), ansi256, otherwise a
 * chalk keyword — so asserting against `chalk.hex(role.brand)` would pin this test to the
 * assumption that role.brand stays hex-shaped, not to Ink's actual behaviour. Rendering a real
 * `<Text color={role.brand}>` exercises that dispatch. The direct chalk call is kept below as a
 * second, independent instrument; the two disagreeing is itself a finding.
 */

const LEVELS = [0, 2, 3] as const;

function withLevel<T>(level: number, fn: () => T): T {
  const prev = chalk.level;
  try {
    chalk.level = level;
    return fn();
  } finally {
    chalk.level = prev;
  }
}

/** What Ink itself emits for this colour and weight — the behaviour, not a reimplementation. */
function inkSpan(text: string, props: { bold?: boolean; dimColor?: boolean }): string {
  return render(<Text color={role.brand} {...props}>{text}</Text>).lastFrame() ?? "";
}

function inkDimSpan(text: string): string {
  return render(<Text dimColor>{text}</Text>).lastFrame() ?? "";
}

const OPTS = { version: "9.9.9", cwd: "/repo", branch: "main", isResumed: true };

describe("banner — matches what Ink renders for the same role, at every colour level", () => {
  for (const level of LEVELS) {
    it(`the version span equals an Ink-rendered role.brand bold Text at chalk level ${level}`, () => {
      const { banner, ink } = withLevel(level, () => ({
        banner: buildBannerLine(OPTS),
        ink: inkSpan("Zone v9.9.9", { bold: true }),
      }));
      expect(banner).toContain(ink);
    });
  }

  /**
   * The second instrument, and the reason it is written this way. `chalk.hex(...).bold(...)` — the
   * obvious spelling — does NOT equal Ink's output: Ink applies dim, then colour, then bold, so
   * bold is the outermost wrapper, while that chain puts colour outermost. Identical rendering,
   * different bytes. The Ink-frame instrument caught it; a hand-rolled chalk assertion would have
   * pinned the wrong composition and stayed green.
   */
  it("second instrument: chalk composed in Ink's own order agrees with the Ink frame at level 3", () => {
    const { ink, sameOrder, wrongOrder } = withLevel(3, () => ({
      ink: inkSpan("Zone v9.9.9", { bold: true }),
      sameOrder: chalk.bold(chalk.hex(role.brand)("Zone v9.9.9")),
      wrongOrder: chalk.hex(role.brand).bold("Zone v9.9.9"),
    }));
    expect(sameOrder).toBe(ink);
    expect(wrongOrder).not.toBe(ink);
  });
});

describe("banner — weight per segment is deliberate, not incidental", () => {
  /**
   * The escapes this replaced encoded exactly this: bold brand for the version, dim for the
   * resumed marker, dim for the path/branch tail. Pinned so a future edit cannot quietly flatten
   * the banner to one weight while the colour assertions above still pass.
   */
  for (const level of [2, 3] as const) {
    it(`the resumed marker and the path tail are both dim at level ${level}`, () => {
      const { banner, dimResumed, dimTail } = withLevel(level, () => ({
        banner: buildBannerLine(OPTS),
        dimResumed: inkDimSpan("(resumed)"),
        dimTail: inkDimSpan("/repo · main"),
      }));
      expect(banner).toContain(dimResumed);
      expect(banner).toContain(dimTail);
    });
  }

  it("at level 0 the banner is plain text — no escapes at all", () => {
    const banner = withLevel(0, () => buildBannerLine(OPTS));
    expect(banner).not.toContain(String.fromCharCode(27));
    expect(banner).toContain("Zone v9.9.9");
    expect(banner).toContain("(resumed)");
    expect(banner).toContain("/repo · main");
  });

  it("omits the resumed marker when not resuming, and the separator when there is no branch", () => {
    const plain = withLevel(0, () => buildBannerLine({ ...OPTS, isResumed: false, branch: "" }));
    expect(plain).not.toContain("(resumed)");
    expect(plain).not.toContain("·");
    expect(plain).toContain("/repo");
  });
});
