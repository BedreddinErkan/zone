import { describe, expect, it } from "vitest";
import { detectDesignSystemSignals } from "../designSystemSignals.js";

describe("detectDesignSystemSignals", () => {
  it("returns no inline-style signals when none are present", () => {
    const result = detectDesignSystemSignals({
      addedLines: [
        '<div className="card">',
        '<span className="label">Zone</span>',
      ],
    });

    expect(result).toEqual({
      inlineStyleCount: 0,
      styleAttributeLines: 0,
      addedClassNameCount: 2,
      excessiveInlineStyles: false,
      reusableClassPreferenceMissed: false,
    });
  });

  it("counts a single inline style line", () => {
    const result = detectDesignSystemSignals({
      addedLines: ['<div style={{ padding: 8 }} className="card" />'],
    });

    expect(result.inlineStyleCount).toBe(1);
    expect(result.styleAttributeLines).toBe(1);
    expect(result.addedClassNameCount).toBe(1);
    expect(result.excessiveInlineStyles).toBe(false);
  });

  it("flags excessive inline styles when multiple inline styles are added", () => {
    const result = detectDesignSystemSignals({
      addedLines: [
        '<div style={{ padding: 8 }} />',
        '<div style={{ margin: 8 }} />',
        '<div style={{ gap: 8 }} />',
      ],
    });

    expect(result.inlineStyleCount).toBe(3);
    expect(result.excessiveInlineStyles).toBe(true);
  });

  it("flags missed reusable class preference when inline styles have no className", () => {
    const result = detectDesignSystemSignals({
      addedLines: [
        '<div style={{ padding: 8 }} />',
        '<section style={{ margin: 12 }} />',
      ],
    });

    expect(result.reusableClassPreferenceMissed).toBe(true);
    expect(result.addedClassNameCount).toBe(0);
  });
});
