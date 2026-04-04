import { describe, expect, it } from "vitest";
import { badge, c, colorize } from "./colors.js";

describe("cli colors", () => {
  it("colorize wraps text with ansi codes and reset", () => {
    expect(colorize("Zone", c.bold, c.orange)).toBe(
      `${c.bold}${c.orange}Zone${c.reset}`
    );
  });

  it("badge wraps padded text with bold and color", () => {
    expect(badge("READY", c.bgGreen)).toBe(
      `${c.bold}${c.bgGreen} READY ${c.reset}`
    );
  });
});
