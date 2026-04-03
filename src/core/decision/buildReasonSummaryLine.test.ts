import { describe, expect, it } from "vitest";
import { buildReasonSummaryLine } from "./buildReasonSummaryLine.js";

describe("buildReasonSummaryLine", () => {
  it("returns fallback when no reason codes exist", () => {
    expect(buildReasonSummaryLine([])).toBe(
      "Why: no explicit decision reasons."
    );
  });

  it("returns deterministic blocked summary line from metadata summaries", () => {
    const output = buildReasonSummaryLine([
      "BLOCKED_DESTRUCTIVE_OPERATION",
      "BLOCKED_SCHEMA_RISK",
      "BLOCKED_HIGH_RISK_SCORE"
    ]);

    expect(output).toBe(
      "Why: Task includes destructive intent and should not be auto-applied; Task touches schema-sensitive areas and may break existing contracts; Overall risk score exceeded the blocked threshold for auto-apply."
    );
  });

  it("returns deterministic preview summary line from metadata summaries", () => {
    const output = buildReasonSummaryLine([
      "PREVIEW_MASS_SCOPE_CHANGE",
      "PREVIEW_LOW_CONFIDENCE"
    ]);

    expect(output).toBe(
      "Why: Task appears to affect many records or a broad surface area; Confidence score is below the safe threshold, so preview is safer."
    );
  });

  it("returns deterministic safe summary line from metadata summaries", () => {
    const output = buildReasonSummaryLine([
      "SAFE_LOW_RISK_LOCALIZED",
      "SAFE_HIGH_CONFIDENCE"
    ]);

    expect(output).toBe(
      "Why: Task appears narrowly scoped and low risk for automatic application; Confidence score is strong enough to support safe auto-apply."
    );
  });

  it("deduplicates repeated reason codes", () => {
    const output = buildReasonSummaryLine([
      "BLOCKED_DESTRUCTIVE_OPERATION",
      "BLOCKED_DESTRUCTIVE_OPERATION",
      "BLOCKED_HIGH_RISK_SCORE"
    ]);

    expect(output).toBe(
      "Why: Task includes destructive intent and should not be auto-applied; Overall risk score exceeded the blocked threshold for auto-apply."
    );
  });

  it("returns the same output for the same input", () => {
    const input = [
      "BLOCKED_DESTRUCTIVE_OPERATION",
      "BLOCKED_SCHEMA_RISK",
      "BLOCKED_HIGH_RISK_SCORE"
    ] as const;

    expect(buildReasonSummaryLine(input)).toBe(buildReasonSummaryLine(input));
  });
});