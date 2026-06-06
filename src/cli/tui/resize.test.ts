import { describe, it, expect } from "vitest";
import { shouldRedrawOnResize } from "./resize.js";

describe("shouldRedrawOnResize", () => {
  it("returns true on narrowing", () => {
    expect(shouldRedrawOnResize(100, 80)).toBe(true);
  });

  it("returns false on widening", () => {
    expect(shouldRedrawOnResize(80, 100)).toBe(false);
  });

  it("returns false on no change (height-only resize)", () => {
    expect(shouldRedrawOnResize(100, 100)).toBe(false);
  });

  it("returns false when prevCols is 0", () => {
    expect(shouldRedrawOnResize(0, 80)).toBe(false);
  });

  it("returns false when nextCols is 0", () => {
    expect(shouldRedrawOnResize(100, 0)).toBe(false);
  });

  it("returns false when prevCols is NaN", () => {
    expect(shouldRedrawOnResize(NaN, 80)).toBe(false);
  });

  it("returns false when nextCols is NaN", () => {
    expect(shouldRedrawOnResize(100, NaN)).toBe(false);
  });

  it("returns false when prevCols is negative", () => {
    expect(shouldRedrawOnResize(-1, 80)).toBe(false);
  });

  it("returns false when nextCols is negative", () => {
    expect(shouldRedrawOnResize(100, -1)).toBe(false);
  });
});
