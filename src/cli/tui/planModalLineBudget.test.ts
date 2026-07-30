import { describe, it, expect } from "vitest";
import { planModalLineBudget } from "./planModalLineBudget.js";

// footerLines fixed at 3, siblingLines fixed at 0 throughout — this module
// doesn't know about mode-derived footers or the real sibling reservation,
// those are the caller's own parameters. contentBudget = rows − 9 − 3 − 0,
// using FRAME_CHROME_LINES's measured value (9, PlanReadyModal.test.tsx
// pin 1 — direct measurement against the degenerate-fixture frame).
describe("planModalLineBudget — valid rows", () => {
  it.each([
    [24, { contentBudget: 12, compact: true, rowsValid: true, receivedRows: 24 }],
    [29, { contentBudget: 17, compact: true, rowsValid: true, receivedRows: 29 }],
    [30, { contentBudget: 18, compact: false, rowsValid: true, receivedRows: 30 }],
    [50, { contentBudget: 38, compact: false, rowsValid: true, receivedRows: 50 }],
    [200, { contentBudget: 188, compact: false, rowsValid: true, receivedRows: 200 }],
  ] as const)("rows=%d", (rows, expected) => {
    expect(planModalLineBudget(rows, 3, 0)).toEqual(expected);
  });
});

// Implausible input reaches the DEFAULT_ROWS=24 fallback (contentBudget=12,
// compact=true) but rowsValid/receivedRows report the truth about what came
// in — including `null`, which is also a legitimate JS value elsewhere, and
// distinguished here only by rowsValid being false, never by receivedRows
// itself being null-checked.
describe("planModalLineBudget — implausible rows", () => {
  it.each([
    ["undefined", undefined],
    ["0", 0],
    ["-5", -5],
    ["10.5", 10.5],
    ["NaN", NaN],
    ["null", null],
    ['"80" (string)', "80"],
  ] as const)("rows=%s", (_label, rows) => {
    expect(planModalLineBudget(rows, 3, 0)).toEqual({
      contentBudget: 12,
      compact: true,
      rowsValid: false,
      receivedRows: rows,
    });
  });
});
