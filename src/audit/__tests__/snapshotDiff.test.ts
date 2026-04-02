import { describe, expect, it } from "vitest";
import { diffAuditSnapshots } from "../snapshotDiff.js";
import type { AuditSnapshot } from "../auditSnapshot.js";

function createSnapshot(
  overrides: Partial<AuditSnapshot> = {}
): AuditSnapshot {
  const baseSnapshot: AuditSnapshot = {
    snapshotId: "snapshot-1",
    timestamp: "2026-04-02T12:00:00.000Z",
    input: {
      riskScore: 0.4,
      confidenceScore: 0.7,
      mode: "preview_only",
    } as AuditSnapshot["input"],
    result: {
      mode: "preview_only",
      riskScore: 0.4,
      confidenceScore: 0.7,
      contradictionFlags: [],
    } as AuditSnapshot["result"],
    contradictionFlags: [] as AuditSnapshot["contradictionFlags"],
    reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
    traceReasonMapping: [],
    parityValid: true,
  };

  return {
    ...baseSnapshot,
    ...overrides,
  } as AuditSnapshot;
}

describe("diffAuditSnapshots", () => {
  it("returns unchanged flags for identical snapshots", () => {
    const previous = createSnapshot();
    const current = createSnapshot();

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.modeChanged).toBe(false);
    expect(diff.confidenceChanged).toBe(false);
    expect(diff.riskChanged).toBe(false);
    expect(diff.parityChanged).toBe(false);
    expect(diff.reasonCodesAdded).toEqual([]);
    expect(diff.reasonCodesRemoved).toEqual([]);
    expect(diff.contradictionFlagsAdded).toEqual([]);
    expect(diff.contradictionFlagsRemoved).toEqual([]);
    expect(diff.traceReasonMappingChanged).toBe(false);
  });

  it("detects mode changes", () => {
    const previous = createSnapshot({
      result: {
        mode: "blocked",
        riskScore: 0.4,
        confidenceScore: 0.7,
        contradictionFlags: [],
      } as AuditSnapshot["result"],
    });

    const current = createSnapshot({
      result: {
        mode: "safe_to_apply",
        riskScore: 0.4,
        confidenceScore: 0.7,
        contradictionFlags: [],
      } as AuditSnapshot["result"],
    });

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.modeChanged).toBe(true);
    expect(diff.previous.mode).toBe("blocked");
    expect(diff.current.mode).toBe("safe_to_apply");
  });

  it("detects confidence changes", () => {
    const previous = createSnapshot({
      input: {
        riskScore: 0.4,
        confidenceScore: 0.3,
        mode: "preview_only",
      } as AuditSnapshot["input"],
    });

    const current = createSnapshot({
      input: {
        riskScore: 0.4,
        confidenceScore: 0.9,
        mode: "preview_only",
      } as AuditSnapshot["input"],
    });

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.confidenceChanged).toBe(true);
    expect(diff.previous.confidenceScore).toBe(0.3);
    expect(diff.current.confidenceScore).toBe(0.9);
  });

  it("detects risk changes", () => {
    const previous = createSnapshot({
      input: {
        riskScore: 0.8,
        confidenceScore: 0.7,
        mode: "preview_only",
      } as AuditSnapshot["input"],
    });

    const current = createSnapshot({
      input: {
        riskScore: 0.2,
        confidenceScore: 0.7,
        mode: "preview_only",
      } as AuditSnapshot["input"],
    });

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.riskChanged).toBe(true);
    expect(diff.previous.riskScore).toBe(0.8);
    expect(diff.current.riskScore).toBe(0.2);
  });

  it("detects added contradiction flags", () => {
    const previous = createSnapshot({
      contradictionFlags: [] as AuditSnapshot["contradictionFlags"],
    });

    const current = createSnapshot({
      contradictionFlags: [
        "MODE_REASON_MISMATCH",
      ] as unknown as AuditSnapshot["contradictionFlags"],
    });

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.contradictionFlagsAdded).toEqual(["MODE_REASON_MISMATCH"]);
    expect(diff.contradictionFlagsRemoved).toEqual([]);
  });

  it("detects removed contradiction flags", () => {
    const previous = createSnapshot({
      contradictionFlags: [
        "MODE_REASON_MISMATCH",
      ] as unknown as AuditSnapshot["contradictionFlags"],
    });

    const current = createSnapshot({
      contradictionFlags: [] as AuditSnapshot["contradictionFlags"],
    });

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.contradictionFlagsAdded).toEqual([]);
    expect(diff.contradictionFlagsRemoved).toEqual(["MODE_REASON_MISMATCH"]);
  });

  it("detects added reason codes", () => {
    const previous = createSnapshot({
      reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
    });

    const current = createSnapshot({
      reasonCodes: ["PREVIEW_LOW_CONFIDENCE", "SAFE_LOW_RISK"],
    });

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.reasonCodesAdded).toEqual(["SAFE_LOW_RISK"]);
    expect(diff.reasonCodesRemoved).toEqual([]);
  });

  it("detects removed reason codes", () => {
    const previous = createSnapshot({
      reasonCodes: ["BLOCKED_SCHEMA_RISK", "PREVIEW_LOW_CONFIDENCE"],
    });

    const current = createSnapshot({
      reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
    });

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.reasonCodesAdded).toEqual([]);
    expect(diff.reasonCodesRemoved).toEqual(["BLOCKED_SCHEMA_RISK"]);
  });

  it("does not treat reason code order as a change", () => {
    const previous = createSnapshot({
      reasonCodes: ["B_CODE", "A_CODE"],
    });

    const current = createSnapshot({
      reasonCodes: ["A_CODE", "B_CODE"],
    });

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.reasonCodesAdded).toEqual([]);
    expect(diff.reasonCodesRemoved).toEqual([]);
  });

  it("detects parity changes", () => {
    const previous = createSnapshot({ parityValid: true });
    const current = createSnapshot({ parityValid: false });

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.parityChanged).toBe(true);
    expect(diff.previous.parityValid).toBe(true);
    expect(diff.current.parityValid).toBe(false);
  });

  it("detects trace mapping changes", () => {
    const previous = createSnapshot({
      traceReasonMapping: [],
    });

    const current = createSnapshot({
      traceReasonMapping: [
        {
          code: "PREVIEW_LOW_CONFIDENCE",
          severity: "warning",
          category: "confidence",
          message: "Confidence too low",
        },
      ],
    });

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.traceReasonMappingChanged).toBe(true);
  });

  it("does not treat trace mapping order as a change when content matches", () => {
    const previous = createSnapshot({
      traceReasonMapping: [
        {
          code: "A_CODE",
          severity: "info",
          category: "risk",
          message: "alpha",
        },
        {
          code: "B_CODE",
          severity: "warning",
          category: "confidence",
          message: "beta",
        },
      ],
    });

    const current = createSnapshot({
      traceReasonMapping: [
        {
          code: "B_CODE",
          severity: "warning",
          category: "confidence",
          message: "beta",
        },
        {
          code: "A_CODE",
          severity: "info",
          category: "risk",
          message: "alpha",
        },
      ],
    });

    const diff = diffAuditSnapshots(previous, current);

    expect(diff.traceReasonMappingChanged).toBe(false);
  });
});