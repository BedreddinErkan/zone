import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { role, glyph } from "./theme.js";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * WCAG relative-luminance contrast formula (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio).
 * Test-only: nothing in src/ needs this outside verifying a fixed-hex colour pair is legible by
 * construction, which only became possible once both sides of a pairing are real hex rather than
 * a theme-relative name the terminal resolves.
 */
function hexToLinear(component: number): number {
  const c = component / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * hexToLinear(r) + 0.7152 * hexToLinear(g) + 0.0722 * hexToLinear(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

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
      ].sort()
    );
  });

  it("holds today's rendered values — a value change here is a palette decision, not a typo", () => {
    expect(role).toEqual({
      accent: "cyan",
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
});

describe("selection-contrast pass — the migrated call sites, not just the pinned values", () => {
  // A wrong-but-consistent value would pass the pinned snapshot above; this checks the six call
  // sites actually moved, which the value-level tests above cannot see.
  const MIGRATED_FILES = [
    "src/cli/tui/components/EffortModal.tsx",
    "src/cli/tui/components/SummaryModal.tsx",
    "src/cli/tui/components/PlanModeModal.tsx",
    "src/cli/tui/components/SessionMemoryModal.tsx",
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
