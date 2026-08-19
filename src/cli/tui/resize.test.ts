import { describe, it, expect, vi } from "vitest";
import { shouldRedrawOnResize, applyResizeRedraw, CLEAR_SCREEN_AND_SCROLLBACK } from "./resize.js";

describe("shouldRedrawOnResize", () => {
  it("returns true on narrowing", () => {
    expect(shouldRedrawOnResize(100, 80)).toBe(true);
  });

  /**
   * Was `false` until the width-staleness pass. Widening was skipped on the premise that Ink
   * self-corrects it; measured, Ink recalculates Yoga layout on resize but never re-renders React,
   * so committed history stayed laid out for the old width and every width computed inside a
   * component body stayed frozen. The clear+remount path already fixed that — it just never fired
   * in this direction.
   */
  it("returns true on widening — the direction that used to be skipped", () => {
    expect(shouldRedrawOnResize(80, 100)).toBe(true);
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

/**
 * The clear and the remount are load-bearing together. Deleting the clear while keeping the
 * remount survived the entire suite when the two were inline in index.tsx — a real gap, not an
 * inert mutation: without the wipe, the remount's re-emission lands below the copy already on
 * screen, putting a second whole transcript there at every resize. That matters more after this
 * pass, which fires the path on widening too.
 */
describe("applyResizeRedraw — the clear and the remount stay paired", () => {
  it("writes the clear sequence and remounts", () => {
    const write = vi.fn();
    const remount = vi.fn();
    applyResizeRedraw(write, remount);

    expect(write).toHaveBeenCalledWith(CLEAR_SCREEN_AND_SCROLLBACK);
    expect(remount).toHaveBeenCalledTimes(1);
  });

  it("clears BEFORE remounting — the reverse order would wipe the fresh copy", () => {
    const order: string[] = [];
    applyResizeRedraw(() => order.push("clear"), () => order.push("remount"));

    expect(order).toEqual(["clear", "remount"]);
  });

  it("the clear sequence erases scrollback, not just the visible screen", () => {
    // \x1b[3J is the half that drops scrollback. Without it the old copy stays reachable by
    // scrolling, which is the same duplicate the pairing exists to prevent.
    expect(CLEAR_SCREEN_AND_SCROLLBACK).toContain("\x1b[3J");
  });
});
