import { describe, expect, it } from "vitest";
import { renderAuditDiff } from "../renderAuditDiff.js";
import type { AuditSnapshotDiff } from "../snapshotDiff.js";

function createBaseDiff(
  overrides: Partial<AuditSnapshotDiff> = {}
): AuditSnapshotDiff {
  return {
    modeChanged: false,
    confidenceChanged: false,
    riskChanged: false,
    parityChanged: false,
    contradictionFlagsAdded: [],
    contradictionFlagsRemoved: [],
    reasonCodesAdded: [],
    reasonCodesRemoved: [],
    traceReasonMappingChanged: false,
    previous: {
      mode: "preview_only",
      confidenceScore: 0.55,
      riskScore: 0.44,
      parityValid: true,
    },
    current: {
      mode: "preview_only",
      confidenceScore: 0.55,
      riskScore: 0.44,
      parityValid: true,
    },
    ...overrides,
  };
}

describe("renderAuditDiff", () => {
  it("renders the header", () => {
    const output = renderAuditDiff(createBaseDiff());
    expect(output).toContain("=== AUDIT DIFF ===");
  });

  it("renders unchanged mode", () => {
    const output = renderAuditDiff(createBaseDiff());
    expect(output).toContain("Mode: unchanged (preview_only)");
  });

  it("renders changed mode", () => {
    const output = renderAuditDiff(
      createBaseDiff({
        modeChanged: true,
        previous: {
          mode: "blocked",
          confidenceScore: 0.55,
          riskScore: 0.44,
          parityValid: true,
        },
        current: {
          mode: "safe_to_apply",
          confidenceScore: 0.55,
          riskScore: 0.44,
          parityValid: true,
        },
      })
    );

    expect(output).toContain("Mode: blocked -> safe_to_apply");
  });

  it("renders unchanged confidence", () => {
    const output = renderAuditDiff(createBaseDiff());
    expect(output).toContain("Confidence: unchanged (0.55)");
  });

  it("renders changed confidence", () => {
    const output = renderAuditDiff(
      createBaseDiff({
        confidenceChanged: true,
        previous: {
          mode: "preview_only",
          confidenceScore: 0.4,
          riskScore: 0.44,
          parityValid: true,
        },
        current: {
          mode: "preview_only",
          confidenceScore: 0.72,
          riskScore: 0.44,
          parityValid: true,
        },
      })
    );

    expect(output).toContain("Confidence: 0.4 -> 0.72");
  });

  it("renders unchanged risk", () => {
    const output = renderAuditDiff(createBaseDiff());
    expect(output).toContain("Risk: unchanged (0.44)");
  });

  it("renders changed risk", () => {
    const output = renderAuditDiff(
      createBaseDiff({
        riskChanged: true,
        previous: {
          mode: "preview_only",
          confidenceScore: 0.55,
          riskScore: 0.81,
          parityValid: true,
        },
        current: {
          mode: "preview_only",
          confidenceScore: 0.55,
          riskScore: 0.21,
          parityValid: true,
        },
      })
    );

    expect(output).toContain("Risk: 0.81 -> 0.21");
  });

  it("renders unchanged parity", () => {
    const output = renderAuditDiff(createBaseDiff());
    expect(output).toContain("Parity: unchanged (true)");
  });

  it("renders changed parity", () => {
    const output = renderAuditDiff(
      createBaseDiff({
        parityChanged: true,
        previous: {
          mode: "preview_only",
          confidenceScore: 0.55,
          riskScore: 0.44,
          parityValid: true,
        },
        current: {
          mode: "preview_only",
          confidenceScore: 0.55,
          riskScore: 0.44,
          parityValid: false,
        },
      })
    );

    expect(output).toContain("Parity: true -> false");
  });

  it("renders no reason code changes", () => {
    const output = renderAuditDiff(createBaseDiff());
    expect(output).toContain("Reason Codes: no changes");
  });

  it("renders added reason codes", () => {
    const output = renderAuditDiff(
      createBaseDiff({
        reasonCodesAdded: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"],
      })
    );

    expect(output).toContain("Reason Codes:");
    expect(output).toContain("+ SAFE_LOW_RISK");
    expect(output).toContain("+ SAFE_HIGH_CONFIDENCE");
  });

  it("renders removed reason codes", () => {
    const output = renderAuditDiff(
      createBaseDiff({
        reasonCodesRemoved: ["BLOCKED_SCHEMA_RISK"],
      })
    );

    expect(output).toContain("Reason Codes:");
    expect(output).toContain("- BLOCKED_SCHEMA_RISK");
  });

  it("renders no contradiction flag changes", () => {
    const output = renderAuditDiff(createBaseDiff());
    expect(output).toContain("Contradiction Flags: no changes");
  });

  it("renders added contradiction flags", () => {
    const output = renderAuditDiff(
      createBaseDiff({
        contradictionFlagsAdded: ["MODE_REASON_MISMATCH"],
      })
    );

    expect(output).toContain("Contradiction Flags:");
    expect(output).toContain("+ MODE_REASON_MISMATCH");
  });

  it("renders removed contradiction flags", () => {
    const output = renderAuditDiff(
      createBaseDiff({
        contradictionFlagsRemoved: ["TRACE_REASON_MISSING"],
      })
    );

    expect(output).toContain("Contradiction Flags:");
    expect(output).toContain("- TRACE_REASON_MISSING");
  });

  it("renders unchanged trace reason mapping", () => {
    const output = renderAuditDiff(createBaseDiff());
    expect(output).toContain("Trace Reason Mapping: unchanged");
  });

  it("renders changed trace reason mapping", () => {
    const output = renderAuditDiff(
      createBaseDiff({
        traceReasonMappingChanged: true,
      })
    );

    expect(output).toContain("Trace Reason Mapping: changed");
  });
});