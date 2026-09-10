import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { role, glyph, spacing, width } from "./theme.js";
// Extracted to contrast.ts so this file and surfacePairing.test.ts read one implementation.
import { contrastRatio } from "./contrast.js";

const REPO_ROOT = path.resolve(__dirname, "../../..");

describe("theme — role values, pinned", () => {
  it("is exactly these eleven roles, so adding or removing one is a visible edit", () => {
    expect(Object.keys(role).sort()).toEqual(
      [
        "accent",
        "activity",
        "brand",
        "caution",
        "danger",
        "emphasis",
        "muted",
        "selectionBackground",
        "selectionForeground",
        "success",
        "surface",
        "surfaceForeground",
      ].sort()
    );
  });

  it("holds today's rendered values — a value change here is a palette decision, not a typo", () => {
    expect(role).toEqual({
      // Phase 2a: brand-teal accent. Unified with role.brand/role.activity/role.selectionBackground
      // so modal chrome, selection fills, and brand marks all resolve to the same hex.
      accent: "#22B3C4",
      caution: "yellow",
      danger: "red",
      success: "green",
      // The palette pass: was "magenta"; now the same brand teal as role.brand (independently
      // reasoned and independently revertible — see both roles' own doc comments in theme.ts).
      activity: "#22B3C4",
      // The selection-contrast pass: dropped "selected-row foreground" as a job — that moved to
      // role.selectionForeground. Stays theme-relative: its remaining jobs have no app-painted
      // background beneath them.
      emphasis: "white",
      // The selection-contrast pass: was "blue" (theme-relative, confirmed colliding with the
      // then-also-theme-relative role.emphasis on a real terminal). Same value as role.brand —
      // the landing's own CSS already pairs these two hexes together, independently reasoned and
      // independently revertible, same precedent as role.activity.
      selectionBackground: "#22B3C4",
      muted: "gray",
      // Fixed hex (the landing's --ink), not theme-relative — was "blackBright", which a real
      // terminal theme painted light grey instead of dark (this pass).
      surface: "#0B0E0F",
      // The palette pass: new tenth role, the landing site's teal brand identity.
      brand: "#22B3C4",
      // The selection-contrast pass: new eleventh role. Same value as role.surface — 7.67:1
      // contrast against role.selectionBackground, independently reasoned and independently
      // revertible, same precedent as role.activity.
      selectionForeground: "#0B0E0F",
      // This pass: new twelfth role. The second half of the class role.selectionForeground closed
      // for the selected-row pairing — an app-painted fill whose foreground the app did not set.
      // 16.35:1 against role.surface, past the 7:1 threshold stated before the value was chosen.
      surfaceForeground: "#E6EDEF",
    });
  });

});

describe("theme — selection contrast is a computable fact, not a terminal guess", () => {
  /**
   * The one class of mistake the pinned-value snapshot above cannot catch: a wrong value pinned
   * consistently the first time passes that snapshot by construction. This asserts the actual
   * invariant — the two colours a selected row stacks together must contrast — which only became
   * checkable once both sides became real hex instead of a bare name the terminal resolves.
   */
  it("selectionForeground on selectionBackground clears the WCAG AA floor for normal text", () => {
    expect(contrastRatio(role.selectionBackground, role.selectionForeground)).toBeGreaterThanOrEqual(4.5);
  });

  it("surfaceForeground on surface clears the AAA floor for normal text", () => {
    // Threshold stated before the value was chosen: 7:1, the same bar selectionForeground already
    // clears. Fixed literal, not a figure read back out of the pair being checked.
    expect(contrastRatio(role.surface, role.surfaceForeground)).toBeGreaterThanOrEqual(7);
  });

  it("and the pairing it replaces does NOT — this is the defect, stated as a number", () => {
    // "#000000" is a light-themed terminal's default foreground, which is what sits on role.surface
    // today. Nothing in the app chooses it, which is why no ratio existed before this role.
    expect(contrastRatio(role.surface, "#000000")).toBeLessThan(1.2);
  });

  it("Phase 2a — accent (brand teal) on surface clears the WCAG AA floor (4.5:1)", () => {
    // role.accent moved from theme-relative "cyan" (terminal-resolved, no computable ratio) to
    // a fixed brand-teal hex. Once both sides are real hex, the pairing becomes a computable
    // fact the test can pin — same mechanism as selectionForeground/selectionBackground above.
    // The threshold is the WCAG AA floor for normal-sized text (the dominant accent use is
    // entry-marker glyphs and prompt markers, both normal-sized).
    expect(contrastRatio(role.accent, role.surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("selection-contrast pass — the migrated call sites, not just the pinned values", () => {
  // A wrong-but-consistent value would pass the pinned snapshot above; this checks the six call
  // sites actually moved, which the value-level tests above cannot see.
  // Phase 2d — the old modal files were retired; the content components that replaced them
  // carry the selection-contrast treatment forward.
  const MIGRATED_FILES = [
    "src/cli/tui/components/EffortPicker.tsx",
    "src/cli/tui/components/SummaryPicker.tsx",
    "src/cli/tui/components/PlanModePicker.tsx",
    "src/cli/tui/components/SessionMemoryPicker.tsx",
  ];

  it("no longer references role.emphasis at all — its only job in these files was the selected-row foreground, now role.selectionForeground", () => {
    for (const rel of MIGRATED_FILES) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(text, `${rel} still references role.emphasis`).not.toMatch(/role\.emphasis\b/);
      expect(text, `${rel} does not reference role.selectionForeground`).toMatch(/role\.selectionForeground\b/);
    }
  });

  it("ModelModal.tsx keeps exactly one role.emphasis — its section header, a different job that was never part of the collision", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, "src/cli/tui/components/ModelModal.tsx"), "utf8");
    const emphasisHits = text.match(/role\.emphasis\b/g) ?? [];
    expect(
      emphasisHits.length,
      "ModelModal.tsx's role.emphasis count changed — check the header line wasn't swept into the migration"
    ).toBe(1);
    expect(text).toMatch(/role\.selectionForeground\b/);
  });
});

describe("theme — glyph values, pinned", () => {
  it("is exactly these glyphs, so adding or removing one is a visible edit", () => {
    expect(Object.keys(glyph).sort()).toEqual(
      [
        "bullet",
        "cursor",
        "detailConnector",
        "entryMarker",
        "failureMark",
        "groupMarker",
        "navigateArrows",
        "pendingMark",
        "promptMarker",
        "radioSelected",
        "radioUnselected",
        "selectionCursor",
        "separator",
        "successMark",
        "warningMark",
      ].sort()
    );
  });

  it("holds today's rendered characters", () => {
    expect(glyph).toEqual({
      cursor: "▋",
      entryMarker: "◆ ",
      separator: "─",
      bullet: "• ",
      warningMark: "⚠",
      groupMarker: "●",
      failureMark: "✗",
      detailConnector: "└ ",
      successMark: "✓",
      selectionCursor: "▸ ",
      promptMarker: "▸ ",
      pendingMark: "○",
      navigateArrows: "↑↓",
      radioSelected: "(•)",
      radioUnselected: "( )",
    });
  });

  /**
   * Corrected, not just extended. This originally asserted every glyph was exactly one visible
   * character after trimming trailing space — true of the first four glyphs (Part 1), false of
   * two real ones added here: navigateArrows ("↑↓", two characters, no trailing space to trim)
   * and the radioSelected/radioUnselected pair (three characters each, parens included). The
   * original assertion encoded an assumption that happened to hold for its first four examples,
   * not a real constraint — a glyph is a named, shared UI unit, not necessarily one code point.
   * What actually matters: no glyph is empty, and no glyph is accidentally a whole sentence.
   */
  it("every glyph is a short, non-empty visible unit — not empty, not accidentally a sentence", () => {
    for (const [name, value] of Object.entries(glyph)) {
      const bare = value.trim();
      expect(bare.length, `glyph "${name}" (${JSON.stringify(value)}) is empty once trimmed`).toBeGreaterThan(0);
      expect([...bare].length, `glyph "${name}" (${JSON.stringify(value)}) is suspiciously long for a glyph`).toBeLessThanOrEqual(3);
    }
  });

  it("radioSelected and radioUnselected are the same length — a UI pair must line up in a fixed-width column", () => {
    expect([...glyph.radioSelected].length).toBe([...glyph.radioUnselected].length);
  });
});

describe("theme — Phase 2a layout tokens, pinned", () => {
  it("spacing scale is exactly five named steps, 0..4 — adding a step is a visible edit", () => {
    expect(spacing).toEqual({ xs: 0, sm: 1, md: 2, lg: 3, xl: 4 });
    expect(Object.keys(spacing).sort()).toEqual(["lg", "md", "sm", "xl", "xs"]);
  });

  it("width policies cap down gracefully at narrow terminals", () => {
    // Wide terminal: every policy returns its cap.
    expect(width.narrow(200)).toBe(72);
    expect(width.wide(200)).toBe(110);
    expect(width.full(200)).toBe(198);
    // Narrow terminal (60 cols): caps fall through to cols-4 / cols-2.
    expect(width.narrow(60)).toBe(56);
    expect(width.wide(60)).toBe(56);
    expect(width.full(60)).toBe(58);
    // Edge: very narrow terminal may collapse the gutter entirely (width.narrow(4) = 0),
    // which is correct — a 4-col terminal cannot host a 72-col capped panel minus a 4-col
    // gutter. Ink/Box handles the zero case gracefully; a real terminal that narrow is not
    // a supported deployment anyway.
    expect(width.narrow(4)).toBe(0);
    expect(width.full(4)).toBe(2);
  });

  it("width.narrow never exceeds width.wide for any column count", () => {
    for (const cols of [40, 60, 80, 120, 200]) {
      expect(width.narrow(cols), `narrow > wide at cols=${cols}`).toBeLessThanOrEqual(width.wide(cols));
    }
  });
});
