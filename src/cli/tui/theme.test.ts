import { describe, expect, it } from "vitest";
import { role, glyph } from "./theme.js";

describe("theme — role values, pinned", () => {
  it("is exactly these ten roles, so adding or removing one is a visible edit", () => {
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
      emphasis: "white",
      selectionBackground: "blue",
      muted: "gray",
      // Fixed hex (the landing's --ink), not theme-relative — was "blackBright", which a real
      // terminal theme painted light grey instead of dark (this pass).
      surface: "#0B0E0F",
      // The palette pass: new tenth role, the landing site's teal brand identity.
      brand: "#22B3C4",
    });
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
