import { describe, expect, it } from "vitest";
import {
  buildDecisionReasonDetails,
  DECISION_REASON_CODE_META,
  getDecisionReasonCodeMeta
} from "./decisionReasonCodeMeta.js";

describe("decisionReasonCodeMeta", () => {
  it("returns metadata for a known reason code", () => {
    const meta = getDecisionReasonCodeMeta("BLOCKED_DESTRUCTIVE_OPERATION");

    expect(meta.code).toBe("BLOCKED_DESTRUCTIVE_OPERATION");
    expect(meta.label).toBe("Destructive operation detected");
    expect(meta.severity).toBe("high");
    expect(meta.category).toBe("safety");
  });

  it("builds reason details in input order", () => {
    const result = buildDecisionReasonDetails([
      "BLOCKED_SCHEMA_RISK",
      "BLOCKED_HIGH_RISK_SCORE"
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].code).toBe("BLOCKED_SCHEMA_RISK");
    expect(result[1].code).toBe("BLOCKED_HIGH_RISK_SCORE");
  });

  it("exposes metadata for all supported reason codes", () => {
    expect(DECISION_REASON_CODE_META.BLOCKED_SCHEMA_RISK.label).toBe(
      "Schema risk detected"
    );
    expect(DECISION_REASON_CODE_META.PREVIEW_LOW_CONFIDENCE.severity).toBe(
      "medium"
    );
    expect(DECISION_REASON_CODE_META.SAFE_HIGH_CONFIDENCE.category).toBe(
      "confidence"
    );
  });
});