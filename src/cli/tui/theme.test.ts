import { describe, expect, it } from "vitest";
import { role, glyph } from "./theme.js";

describe("theme — role values, pinned", () => {
  it("is exactly these nine roles, so adding or removing one is a visible edit", () => {
    expect(Object.keys(role).sort()).toEqual(
      [
        "accent",
        "activity",
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
      activity: "magenta",
      emphasis: "white",
      selectionBackground: "blue",
      muted: "gray",
      surface: "blackBright",
    });
  });

});

describe("theme — glyph values, pinned", () => {
  it("is exactly these glyphs, so adding or removing one is a visible edit", () => {
    expect(Object.keys(glyph).sort()).toEqual(["bullet", "cursor", "entryMarker", "separator"].sort());
  });

  it("holds today's rendered characters", () => {
    expect(glyph).toEqual({
      cursor: "▋",
      entryMarker: "◆ ",
      separator: "─",
      bullet: "• ",
    });
  });

  it("every glyph is a single visible character (plus trailing space where the site needs one), not a multi-glyph string", () => {
    for (const [name, value] of Object.entries(glyph)) {
      const bare = value.trimEnd();
      expect([...bare].length, `glyph "${name}" (${JSON.stringify(value)}) is not one visible character`).toBe(1);
    }
  });
});
