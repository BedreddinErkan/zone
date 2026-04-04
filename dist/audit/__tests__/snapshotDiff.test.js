"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const snapshotDiff_js_1 = require("../snapshotDiff.js");
function createSnapshot(overrides = {}) {
    const baseSnapshot = {
        snapshotId: "snapshot-1",
        timestamp: "2026-04-02T12:00:00.000Z",
        input: {
            riskScore: 0.4,
            confidenceScore: 0.7,
            mode: "preview_only",
        },
        result: {
            mode: "preview_only",
            riskScore: 0.4,
            confidenceScore: 0.7,
            contradictionFlags: [],
        },
        contradictionFlags: [],
        reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
        traceReasonMapping: [],
        parityValid: true,
    };
    return {
        ...baseSnapshot,
        ...overrides,
    };
}
(0, vitest_1.describe)("diffAuditSnapshots", () => {
    (0, vitest_1.it)("returns unchanged flags for identical snapshots", () => {
        const previous = createSnapshot();
        const current = createSnapshot();
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.modeChanged).toBe(false);
        (0, vitest_1.expect)(diff.confidenceChanged).toBe(false);
        (0, vitest_1.expect)(diff.riskChanged).toBe(false);
        (0, vitest_1.expect)(diff.parityChanged).toBe(false);
        (0, vitest_1.expect)(diff.reasonCodesAdded).toEqual([]);
        (0, vitest_1.expect)(diff.reasonCodesRemoved).toEqual([]);
        (0, vitest_1.expect)(diff.contradictionFlagsAdded).toEqual([]);
        (0, vitest_1.expect)(diff.contradictionFlagsRemoved).toEqual([]);
        (0, vitest_1.expect)(diff.traceReasonMappingChanged).toBe(false);
    });
    (0, vitest_1.it)("detects mode changes", () => {
        const previous = createSnapshot({
            result: {
                mode: "blocked",
                riskScore: 0.4,
                confidenceScore: 0.7,
                contradictionFlags: [],
            },
        });
        const current = createSnapshot({
            result: {
                mode: "safe_to_apply",
                riskScore: 0.4,
                confidenceScore: 0.7,
                contradictionFlags: [],
            },
        });
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.modeChanged).toBe(true);
        (0, vitest_1.expect)(diff.previous.mode).toBe("blocked");
        (0, vitest_1.expect)(diff.current.mode).toBe("safe_to_apply");
    });
    (0, vitest_1.it)("detects confidence changes", () => {
        const previous = createSnapshot({
            input: {
                riskScore: 0.4,
                confidenceScore: 0.3,
                mode: "preview_only",
            },
        });
        const current = createSnapshot({
            input: {
                riskScore: 0.4,
                confidenceScore: 0.9,
                mode: "preview_only",
            },
        });
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.confidenceChanged).toBe(true);
        (0, vitest_1.expect)(diff.previous.confidenceScore).toBe(0.3);
        (0, vitest_1.expect)(diff.current.confidenceScore).toBe(0.9);
    });
    (0, vitest_1.it)("detects risk changes", () => {
        const previous = createSnapshot({
            input: {
                riskScore: 0.8,
                confidenceScore: 0.7,
                mode: "preview_only",
            },
        });
        const current = createSnapshot({
            input: {
                riskScore: 0.2,
                confidenceScore: 0.7,
                mode: "preview_only",
            },
        });
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.riskChanged).toBe(true);
        (0, vitest_1.expect)(diff.previous.riskScore).toBe(0.8);
        (0, vitest_1.expect)(diff.current.riskScore).toBe(0.2);
    });
    (0, vitest_1.it)("detects added contradiction flags", () => {
        const previous = createSnapshot({
            contradictionFlags: [],
        });
        const current = createSnapshot({
            contradictionFlags: [
                "MODE_REASON_MISMATCH",
            ],
        });
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.contradictionFlagsAdded).toEqual(["MODE_REASON_MISMATCH"]);
        (0, vitest_1.expect)(diff.contradictionFlagsRemoved).toEqual([]);
    });
    (0, vitest_1.it)("detects removed contradiction flags", () => {
        const previous = createSnapshot({
            contradictionFlags: [
                "MODE_REASON_MISMATCH",
            ],
        });
        const current = createSnapshot({
            contradictionFlags: [],
        });
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.contradictionFlagsAdded).toEqual([]);
        (0, vitest_1.expect)(diff.contradictionFlagsRemoved).toEqual(["MODE_REASON_MISMATCH"]);
    });
    (0, vitest_1.it)("detects added reason codes", () => {
        const previous = createSnapshot({
            reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
        });
        const current = createSnapshot({
            reasonCodes: ["PREVIEW_LOW_CONFIDENCE", "SAFE_LOW_RISK"],
        });
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.reasonCodesAdded).toEqual(["SAFE_LOW_RISK"]);
        (0, vitest_1.expect)(diff.reasonCodesRemoved).toEqual([]);
    });
    (0, vitest_1.it)("detects removed reason codes", () => {
        const previous = createSnapshot({
            reasonCodes: ["BLOCKED_SCHEMA_RISK", "PREVIEW_LOW_CONFIDENCE"],
        });
        const current = createSnapshot({
            reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
        });
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.reasonCodesAdded).toEqual([]);
        (0, vitest_1.expect)(diff.reasonCodesRemoved).toEqual(["BLOCKED_SCHEMA_RISK"]);
    });
    (0, vitest_1.it)("does not treat reason code order as a change", () => {
        const previous = createSnapshot({
            reasonCodes: ["B_CODE", "A_CODE"],
        });
        const current = createSnapshot({
            reasonCodes: ["A_CODE", "B_CODE"],
        });
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.reasonCodesAdded).toEqual([]);
        (0, vitest_1.expect)(diff.reasonCodesRemoved).toEqual([]);
    });
    (0, vitest_1.it)("detects parity changes", () => {
        const previous = createSnapshot({ parityValid: true });
        const current = createSnapshot({ parityValid: false });
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.parityChanged).toBe(true);
        (0, vitest_1.expect)(diff.previous.parityValid).toBe(true);
        (0, vitest_1.expect)(diff.current.parityValid).toBe(false);
    });
    (0, vitest_1.it)("detects trace mapping changes", () => {
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
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.traceReasonMappingChanged).toBe(true);
    });
    (0, vitest_1.it)("does not treat trace mapping order as a change when content matches", () => {
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
        const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(previous, current);
        (0, vitest_1.expect)(diff.traceReasonMappingChanged).toBe(false);
    });
});
//# sourceMappingURL=snapshotDiff.test.js.map