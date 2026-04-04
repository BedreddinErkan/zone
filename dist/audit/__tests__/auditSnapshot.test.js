"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const auditSnapshot_js_1 = require("../auditSnapshot.js");
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeInput(overrides = {}) {
    return {
        riskScore: 0.2,
        confidenceScore: 0.9,
        mode: "safe_to_apply",
        ...overrides,
    };
}
function makeResult(overrides = {}) {
    return {
        riskScore: 0.2,
        confidenceScore: 0.9,
        mode: "safe_to_apply",
        contradictionFlags: [],
        ...overrides,
    };
}
const FIXED_TIMESTAMP = "2026-04-02T12:00:00.000Z";
const SAMPLE_TRACE = [
    {
        code: "SAFE_HIGH_CONFIDENCE",
        severity: "low",
        category: "confidence",
        message: "Confidence score is strong enough to support safe auto-apply.",
    },
];
// ---------------------------------------------------------------------------
// Snapshot shape — all fields present
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildAuditSnapshot — snapshot shape", () => {
    (0, vitest_1.it)("returns an object with a snapshotId field", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(snap).toHaveProperty("snapshotId");
    });
    (0, vitest_1.it)("returns an object with a timestamp field", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(snap).toHaveProperty("timestamp");
    });
    (0, vitest_1.it)("returns an object with an input field matching the provided input", () => {
        const input = makeInput();
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(input, makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(snap.input).toEqual(input);
    });
    (0, vitest_1.it)("returns an object with a result field matching the provided result", () => {
        const result = makeResult();
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), result, {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(snap.result).toEqual(result);
    });
    (0, vitest_1.it)("returns an object with a contradictionFlags field (array)", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(Array.isArray(snap.contradictionFlags)).toBe(true);
    });
    (0, vitest_1.it)("contradictionFlags mirrors result.contradictionFlags", () => {
        const flags = [
            {
                type: "LOW_CONFIDENCE_ON_SAFE",
                severity: "warning",
                message: "test flag",
            },
        ];
        const result = makeResult({ contradictionFlags: flags });
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), result, {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(snap.contradictionFlags).toEqual(flags);
    });
    (0, vitest_1.it)("returns an object with a reasonCodes field (array)", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(Array.isArray(snap.reasonCodes)).toBe(true);
    });
    (0, vitest_1.it)("reasonCodes reflects the options.reasonCodes passed in", () => {
        const codes = ["SAFE_HIGH_CONFIDENCE", "SAFE_LOW_RISK_LOCALIZED"];
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: codes,
        });
        (0, vitest_1.expect)(snap.reasonCodes).toEqual(codes);
    });
    (0, vitest_1.it)("returns an object with a traceReasonMapping field (array)", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(Array.isArray(snap.traceReasonMapping)).toBe(true);
    });
    (0, vitest_1.it)("traceReasonMapping reflects the options.traceReasonMapping passed in", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
            traceReasonMapping: SAMPLE_TRACE,
        });
        (0, vitest_1.expect)(snap.traceReasonMapping).toEqual(SAMPLE_TRACE);
    });
    (0, vitest_1.it)("each traceReasonEntry has code, severity, category, and message", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
            traceReasonMapping: SAMPLE_TRACE,
        });
        const entry = snap.traceReasonMapping[0];
        (0, vitest_1.expect)(entry).toHaveProperty("code");
        (0, vitest_1.expect)(entry).toHaveProperty("severity");
        (0, vitest_1.expect)(entry).toHaveProperty("category");
        (0, vitest_1.expect)(entry).toHaveProperty("message");
    });
    (0, vitest_1.it)("returns an object with a parityValid boolean field", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(typeof snap.parityValid).toBe("boolean");
    });
});
// ---------------------------------------------------------------------------
// parityValid: true — clean/consistent inputs
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildAuditSnapshot — parityValid: true on clean input", () => {
    (0, vitest_1.it)("returns parityValid: true when reasonCodes is empty", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: [],
        });
        (0, vitest_1.expect)(snap.parityValid).toBe(true);
    });
    (0, vitest_1.it)("returns parityValid: true for safe_to_apply mode with SAFE_ reason codes", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ mode: "safe_to_apply" }), makeResult({ mode: "safe_to_apply" }), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
        });
        (0, vitest_1.expect)(snap.parityValid).toBe(true);
    });
    (0, vitest_1.it)("returns parityValid: true for blocked mode with BLOCKED_ reason codes", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ mode: "blocked", riskScore: 0.9 }), makeResult({ mode: "blocked", riskScore: 0.9 }), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"],
        });
        (0, vitest_1.expect)(snap.parityValid).toBe(true);
    });
    (0, vitest_1.it)("returns parityValid: true for preview_only mode with PREVIEW_ reason codes", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ mode: "preview_only", riskScore: 0.4 }), makeResult({ mode: "preview_only", riskScore: 0.4 }), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
        });
        (0, vitest_1.expect)(snap.parityValid).toBe(true);
    });
    (0, vitest_1.it)("returns parityValid: true when at least one matching code is present alongside others", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ mode: "blocked", riskScore: 0.9 }), makeResult({ mode: "blocked", riskScore: 0.9 }), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["BLOCKED_DESTRUCTIVE_OPERATION", "BLOCKED_HIGH_RISK_SCORE"],
        });
        (0, vitest_1.expect)(snap.parityValid).toBe(true);
    });
    (0, vitest_1.it)("returns parityValid: true when no options are passed (default empty codes)", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult());
        (0, vitest_1.expect)(snap.parityValid).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// parityValid: false — mismatched reason codes
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildAuditSnapshot — parityValid: false on mismatched reasonCodes", () => {
    (0, vitest_1.it)("returns parityValid: false for safe_to_apply mode with BLOCKED_ codes", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ mode: "safe_to_apply" }), makeResult({ mode: "safe_to_apply" }), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"],
        });
        (0, vitest_1.expect)(snap.parityValid).toBe(false);
    });
    (0, vitest_1.it)("returns parityValid: false for blocked mode with SAFE_ codes", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ mode: "blocked", riskScore: 0.9 }), makeResult({ mode: "blocked", riskScore: 0.9 }), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
        });
        (0, vitest_1.expect)(snap.parityValid).toBe(false);
    });
    (0, vitest_1.it)("returns parityValid: false for preview_only mode with SAFE_ codes", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ mode: "preview_only", riskScore: 0.4 }), makeResult({ mode: "preview_only", riskScore: 0.4 }), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["SAFE_LOW_RISK_LOCALIZED"],
        });
        (0, vitest_1.expect)(snap.parityValid).toBe(false);
    });
    (0, vitest_1.it)("returns parityValid: false for blocked mode with PREVIEW_ codes", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ mode: "blocked", riskScore: 0.9 }), makeResult({ mode: "blocked", riskScore: 0.9 }), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
        });
        (0, vitest_1.expect)(snap.parityValid).toBe(false);
    });
    (0, vitest_1.it)("returns parityValid: false for safe_to_apply mode with all PREVIEW_ codes", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ mode: "safe_to_apply" }), makeResult({ mode: "safe_to_apply" }), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["PREVIEW_MASS_SCOPE_CHANGE", "PREVIEW_LOW_CONFIDENCE"],
        });
        (0, vitest_1.expect)(snap.parityValid).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// Object.freeze
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildAuditSnapshot — immutability", () => {
    (0, vitest_1.it)("returns a frozen object (Object.isFrozen === true)", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(Object.isFrozen(snap)).toBe(true);
    });
    (0, vitest_1.it)("does not throw when built but mutation attempt is silently ignored in non-strict mode", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        // In strict mode this would throw; in non-strict mode it's a no-op.
        // Either way, the original value must be unchanged.
        const originalTimestamp = snap["timestamp"];
        try {
            snap["timestamp"] = "mutated";
        }
        catch {
            // strict mode — expected
        }
        (0, vitest_1.expect)(snap["timestamp"]).toBe(originalTimestamp);
    });
});
// ---------------------------------------------------------------------------
// snapshotId
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildAuditSnapshot — snapshotId", () => {
    (0, vitest_1.it)("snapshotId is a non-empty string", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(typeof snap.snapshotId).toBe("string");
        (0, vitest_1.expect)(snap.snapshotId.length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)("snapshotId contains only alphanumeric characters", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(snap.snapshotId).toMatch(/^[A-Za-z0-9]+$/);
    });
    (0, vitest_1.it)("snapshotId is deterministic for the same input and timestamp", () => {
        const input = makeInput();
        const result = makeResult();
        const opts = { timestamp: FIXED_TIMESTAMP };
        const snap1 = (0, auditSnapshot_js_1.buildAuditSnapshot)(input, result, opts);
        const snap2 = (0, auditSnapshot_js_1.buildAuditSnapshot)(input, result, opts);
        (0, vitest_1.expect)(snap1.snapshotId).toBe(snap2.snapshotId);
    });
    (0, vitest_1.it)("snapshotId differs when riskScore changes", () => {
        const snap1 = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ riskScore: 0.2 }), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        const snap2 = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ riskScore: 0.8 }), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(snap1.snapshotId).not.toBe(snap2.snapshotId);
    });
    (0, vitest_1.it)("snapshotId differs when timestamp changes", () => {
        const input = makeInput();
        const result = makeResult();
        const snap1 = (0, auditSnapshot_js_1.buildAuditSnapshot)(input, result, {
            timestamp: "2026-04-02T12:00:00.000Z",
        });
        const snap2 = (0, auditSnapshot_js_1.buildAuditSnapshot)(input, result, {
            timestamp: "2026-04-02T13:00:00.000Z",
        });
        (0, vitest_1.expect)(snap1.snapshotId).not.toBe(snap2.snapshotId);
    });
});
// ---------------------------------------------------------------------------
// timestamp
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildAuditSnapshot — timestamp", () => {
    (0, vitest_1.it)("timestamp is a valid ISO 8601 string when provided via options", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(snap.timestamp).toBe(FIXED_TIMESTAMP);
        (0, vitest_1.expect)(new Date(snap.timestamp).toISOString()).toBe(FIXED_TIMESTAMP);
    });
    (0, vitest_1.it)("timestamp defaults to a valid ISO 8601 string when not provided", () => {
        const before = Date.now();
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult());
        const after = Date.now();
        const ts = new Date(snap.timestamp).getTime();
        (0, vitest_1.expect)(ts).toBeGreaterThanOrEqual(before);
        (0, vitest_1.expect)(ts).toBeLessThanOrEqual(after);
    });
    (0, vitest_1.it)("timestamp matches the ISO 8601 pattern (YYYY-MM-DDTHH:mm:ss.sssZ)", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(snap.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
});
// ---------------------------------------------------------------------------
// Default / edge-case behaviour
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildAuditSnapshot — defaults and edge cases", () => {
    (0, vitest_1.it)("reasonCodes defaults to an empty array when not provided", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(snap.reasonCodes).toEqual([]);
    });
    (0, vitest_1.it)("traceReasonMapping defaults to an empty array when not provided", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
        });
        (0, vitest_1.expect)(snap.traceReasonMapping).toEqual([]);
    });
    (0, vitest_1.it)("is serializable to JSON without loss of shape", () => {
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(), makeResult(), {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
            traceReasonMapping: SAMPLE_TRACE,
        });
        const json = JSON.parse(JSON.stringify(snap));
        (0, vitest_1.expect)(json.snapshotId).toBe(snap.snapshotId);
        (0, vitest_1.expect)(json.timestamp).toBe(snap.timestamp);
        (0, vitest_1.expect)(json.reasonCodes).toEqual(snap.reasonCodes);
        (0, vitest_1.expect)(json.parityValid).toBe(snap.parityValid);
    });
    (0, vitest_1.it)("snapshot with blocked mode and no flags produces a structurally complete object", () => {
        const input = makeInput({ riskScore: 0.85, confidenceScore: 0.7, mode: "blocked" });
        const result = makeResult({
            riskScore: 0.85,
            confidenceScore: 0.7,
            mode: "blocked",
            contradictionFlags: [],
        });
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(input, result, {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"],
        });
        (0, vitest_1.expect)(snap.snapshotId).toBeTruthy();
        (0, vitest_1.expect)(snap.result.mode).toBe("blocked");
        (0, vitest_1.expect)(snap.contradictionFlags).toEqual([]);
        (0, vitest_1.expect)(snap.parityValid).toBe(true);
    });
    (0, vitest_1.it)("snapshot with preview_only mode is structurally sound", () => {
        const input = makeInput({ riskScore: 0.45, confidenceScore: 0.6, mode: "preview_only" });
        const result = makeResult({
            riskScore: 0.45,
            confidenceScore: 0.6,
            mode: "preview_only",
        });
        const snap = (0, auditSnapshot_js_1.buildAuditSnapshot)(input, result, {
            timestamp: FIXED_TIMESTAMP,
            reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
        });
        (0, vitest_1.expect)(snap.result.mode).toBe("preview_only");
        (0, vitest_1.expect)(snap.parityValid).toBe(true);
        (0, vitest_1.expect)(Object.isFrozen(snap)).toBe(true);
    });
});
//# sourceMappingURL=auditSnapshot.test.js.map