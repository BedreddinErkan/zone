"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const output_js_1 = require("../output.js");
const index_js_1 = require("../index.js");
const auditSnapshot_js_1 = require("../../audit/auditSnapshot.js");
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const FIXED_TIMESTAMP = "2026-04-02T12:00:00.000Z";
function makeEngineInput(overrides = {}) {
    return {
        riskScore: 0.2,
        confidenceScore: 0.9,
        mode: "safe_to_apply",
        ...overrides,
    };
}
function makeEngineResult(overrides = {}) {
    return {
        riskScore: 0.2,
        confidenceScore: 0.9,
        mode: "safe_to_apply",
        contradictionFlags: [],
        ...overrides,
    };
}
function buildFixedSnapshot(inputOverrides = {}, resultOverrides = {}) {
    return (0, auditSnapshot_js_1.buildAuditSnapshot)(makeEngineInput(inputOverrides), makeEngineResult(resultOverrides), { timestamp: FIXED_TIMESTAMP });
}
// ---------------------------------------------------------------------------
// printAuditSnapshot — outputs valid JSON
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("printAuditSnapshot — JSON output", () => {
    let logSpy;
    (0, vitest_1.beforeEach)(() => {
        logSpy = vitest_1.vi.spyOn(console, "log").mockImplementation(() => undefined);
    });
    (0, vitest_1.it)("calls console.log exactly once with JSON when given a valid snapshot", () => {
        const snap = buildFixedSnapshot();
        (0, output_js_1.printAuditSnapshot)(snap);
        (0, vitest_1.expect)(logSpy).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("outputs a string that parses as valid JSON", () => {
        const snap = buildFixedSnapshot();
        (0, output_js_1.printAuditSnapshot)(snap);
        const raw = logSpy.mock.calls[0]?.[0];
        (0, vitest_1.expect)(() => JSON.parse(raw)).not.toThrow();
    });
    (0, vitest_1.it)("JSON output is pretty-printed (contains newlines)", () => {
        const snap = buildFixedSnapshot();
        (0, output_js_1.printAuditSnapshot)(snap);
        const raw = logSpy.mock.calls[0]?.[0];
        (0, vitest_1.expect)(raw).toContain("\n");
    });
    (0, vitest_1.it)("JSON output contains all 8 required snapshot fields", () => {
        const snap = buildFixedSnapshot();
        (0, output_js_1.printAuditSnapshot)(snap);
        const parsed = JSON.parse(logSpy.mock.calls[0]?.[0]);
        (0, vitest_1.expect)(parsed).toHaveProperty("snapshotId");
        (0, vitest_1.expect)(parsed).toHaveProperty("timestamp");
        (0, vitest_1.expect)(parsed).toHaveProperty("input");
        (0, vitest_1.expect)(parsed).toHaveProperty("result");
        (0, vitest_1.expect)(parsed).toHaveProperty("contradictionFlags");
        (0, vitest_1.expect)(parsed).toHaveProperty("reasonCodes");
        (0, vitest_1.expect)(parsed).toHaveProperty("traceReasonMapping");
        (0, vitest_1.expect)(parsed).toHaveProperty("parityValid");
    });
    (0, vitest_1.it)("JSON.snapshotId is a non-empty string", () => {
        const snap = buildFixedSnapshot();
        (0, output_js_1.printAuditSnapshot)(snap);
        const parsed = JSON.parse(logSpy.mock.calls[0]?.[0]);
        (0, vitest_1.expect)(typeof parsed["snapshotId"]).toBe("string");
        (0, vitest_1.expect)(parsed["snapshotId"].length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)("JSON.timestamp matches the ISO 8601 fixed timestamp", () => {
        const snap = buildFixedSnapshot();
        (0, output_js_1.printAuditSnapshot)(snap);
        const parsed = JSON.parse(logSpy.mock.calls[0]?.[0]);
        (0, vitest_1.expect)(parsed["timestamp"]).toBe(FIXED_TIMESTAMP);
    });
    (0, vitest_1.it)("JSON.parityValid is a boolean", () => {
        const snap = buildFixedSnapshot();
        (0, output_js_1.printAuditSnapshot)(snap);
        const parsed = JSON.parse(logSpy.mock.calls[0]?.[0]);
        (0, vitest_1.expect)(typeof parsed["parityValid"]).toBe("boolean");
    });
    (0, vitest_1.it)("output is deterministic: same snapshot always produces identical JSON", () => {
        const snap = buildFixedSnapshot();
        (0, output_js_1.printAuditSnapshot)(snap);
        const first = logSpy.mock.calls[0]?.[0];
        logSpy.mockClear();
        (0, output_js_1.printAuditSnapshot)(snap);
        const second = logSpy.mock.calls[0]?.[0];
        (0, vitest_1.expect)(first).toBe(second);
    });
    (0, vitest_1.it)("two independently built snapshots with same input+timestamp produce identical JSON", () => {
        const snap1 = buildFixedSnapshot();
        const snap2 = buildFixedSnapshot();
        (0, output_js_1.printAuditSnapshot)(snap1);
        const json1 = logSpy.mock.calls[0]?.[0];
        logSpy.mockClear();
        (0, output_js_1.printAuditSnapshot)(snap2);
        const json2 = logSpy.mock.calls[0]?.[0];
        (0, vitest_1.expect)(json1).toBe(json2);
    });
});
// ---------------------------------------------------------------------------
// printAuditSnapshot — no-op on null / undefined
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("printAuditSnapshot — no-op on falsy input", () => {
    let logSpy;
    (0, vitest_1.beforeEach)(() => {
        logSpy = vitest_1.vi.spyOn(console, "log").mockImplementation(() => undefined);
    });
    (0, vitest_1.it)("does not call console.log when snapshot is null", () => {
        (0, output_js_1.printAuditSnapshot)(null);
        (0, vitest_1.expect)(logSpy).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("does not call console.log when snapshot is undefined", () => {
        (0, output_js_1.printAuditSnapshot)(undefined);
        (0, vitest_1.expect)(logSpy).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("does not throw when called with null", () => {
        (0, vitest_1.expect)(() => (0, output_js_1.printAuditSnapshot)(null)).not.toThrow();
    });
    (0, vitest_1.it)("does not throw when called with undefined", () => {
        (0, vitest_1.expect)(() => (0, output_js_1.printAuditSnapshot)(undefined)).not.toThrow();
    });
});
// ---------------------------------------------------------------------------
// Snapshot is frozen before being passed to print
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("printAuditSnapshot — snapshot immutability", () => {
    let logSpy;
    (0, vitest_1.beforeEach)(() => {
        logSpy = vitest_1.vi.spyOn(console, "log").mockImplementation(() => undefined);
    });
    (0, vitest_1.it)("snapshot returned by buildAuditSnapshot is frozen", () => {
        const snap = buildFixedSnapshot();
        (0, vitest_1.expect)(Object.isFrozen(snap)).toBe(true);
    });
    (0, vitest_1.it)("printAuditSnapshot accepts a frozen snapshot without error", () => {
        const snap = buildFixedSnapshot();
        (0, vitest_1.expect)(Object.isFrozen(snap)).toBe(true);
        (0, vitest_1.expect)(() => (0, output_js_1.printAuditSnapshot)(snap)).not.toThrow();
        (0, vitest_1.expect)(logSpy).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("snapshot fields remain unchanged after printAuditSnapshot is called", () => {
        const snap = buildFixedSnapshot();
        const originalTimestamp = snap.timestamp;
        const originalId = snap.snapshotId;
        (0, output_js_1.printAuditSnapshot)(snap);
        (0, vitest_1.expect)(snap.timestamp).toBe(originalTimestamp);
        (0, vitest_1.expect)(snap.snapshotId).toBe(originalId);
    });
});
// ---------------------------------------------------------------------------
// resolveAuditFlag — argv parsing
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("resolveAuditFlag — --audit flag parsing from argv", () => {
    (0, vitest_1.it)("returns true when '--audit' is in argv", () => {
        (0, vitest_1.expect)((0, index_js_1.resolveAuditFlag)(["node", "zone", "--task", "do X", "--audit"])).toBe(true);
    });
    (0, vitest_1.it)("returns true when '--audit' is the only extra flag", () => {
        (0, vitest_1.expect)((0, index_js_1.resolveAuditFlag)(["--audit"])).toBe(true);
    });
    (0, vitest_1.it)("returns false when '--audit' is absent", () => {
        (0, vitest_1.expect)((0, index_js_1.resolveAuditFlag)(["node", "zone", "--task", "do X"])).toBe(false);
    });
    (0, vitest_1.it)("returns false for an empty argv", () => {
        (0, vitest_1.expect)((0, index_js_1.resolveAuditFlag)([])).toBe(false);
    });
    (0, vitest_1.it)("returns false for partial matches like '--auditing'", () => {
        (0, vitest_1.expect)((0, index_js_1.resolveAuditFlag)(["--auditing"])).toBe(false);
    });
    (0, vitest_1.it)("returns false for '--Audit' (case-sensitive)", () => {
        (0, vitest_1.expect)((0, index_js_1.resolveAuditFlag)(["--Audit"])).toBe(false);
    });
    (0, vitest_1.it)("returns true when '--audit' appears among many flags", () => {
        (0, vitest_1.expect)((0, index_js_1.resolveAuditFlag)([
            "node",
            "zone",
            "--task",
            "refactor service",
            "--ci",
            "--verbose",
            "--audit",
            "--format",
            "json",
        ])).toBe(true);
    });
});
//# sourceMappingURL=auditFlag.test.js.map