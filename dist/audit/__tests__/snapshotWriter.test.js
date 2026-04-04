"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const snapshotWriter_js_1 = require("../snapshotWriter.js");
const auditSnapshot_js_1 = require("../auditSnapshot.js");
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const FIXED_TIMESTAMP = "2026-04-02T12:00:00.000Z";
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
function buildFixedSnapshot(inputOverrides = {}, resultOverrides = {}) {
    return (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput(inputOverrides), makeResult(resultOverrides), {
        timestamp: FIXED_TIMESTAMP,
        reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
    });
}
/** Creates a unique temp directory path for each test, cleaning up after. */
function makeTmpDir() {
    return node_fs_1.default.mkdtempSync(node_path_1.default.join(node_os_1.default.tmpdir(), "zone-audit-test-"));
}
// ---------------------------------------------------------------------------
// resolveAuditOutFlag
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("resolveAuditOutFlag — flag parsing", () => {
    (0, vitest_1.it)("returns the path string when --audit-out=<path> is present", () => {
        const result = (0, snapshotWriter_js_1.resolveAuditOutFlag)(["--audit-out=output/audit.json"]);
        (0, vitest_1.expect)(result).toBe("output/audit.json");
    });
    (0, vitest_1.it)("returns null when --audit-out is absent from argv", () => {
        const result = (0, snapshotWriter_js_1.resolveAuditOutFlag)(["node", "zone", "--task", "do X"]);
        (0, vitest_1.expect)(result).toBeNull();
    });
    (0, vitest_1.it)("returns null for an empty argv array", () => {
        (0, vitest_1.expect)((0, snapshotWriter_js_1.resolveAuditOutFlag)([])).toBeNull();
    });
    (0, vitest_1.it)("returns null when --audit-out= has no value (empty string after =)", () => {
        const result = (0, snapshotWriter_js_1.resolveAuditOutFlag)(["--audit-out="]);
        (0, vitest_1.expect)(result).toBeNull();
    });
    (0, vitest_1.it)("returns the path when the flag appears among many other flags", () => {
        const argv = [
            "node",
            "zone",
            "--task",
            "refactor service",
            "--audit",
            "--audit-out=reports/snap.json",
            "--format",
            "json",
        ];
        (0, vitest_1.expect)((0, snapshotWriter_js_1.resolveAuditOutFlag)(argv)).toBe("reports/snap.json");
    });
    (0, vitest_1.it)("returns the first matching path when the flag appears multiple times", () => {
        const argv = ["--audit-out=first.json", "--audit-out=second.json"];
        (0, vitest_1.expect)((0, snapshotWriter_js_1.resolveAuditOutFlag)(argv)).toBe("first.json");
    });
    (0, vitest_1.it)("returns null when only --audit (not --audit-out) is present", () => {
        (0, vitest_1.expect)((0, snapshotWriter_js_1.resolveAuditOutFlag)(["--audit"])).toBeNull();
    });
    (0, vitest_1.it)("handles absolute paths correctly", () => {
        const result = (0, snapshotWriter_js_1.resolveAuditOutFlag)(["--audit-out=/tmp/audit/snapshot.json"]);
        (0, vitest_1.expect)(result).toBe("/tmp/audit/snapshot.json");
    });
    (0, vitest_1.it)("is case-sensitive — does not match --Audit-Out=<path>", () => {
        (0, vitest_1.expect)((0, snapshotWriter_js_1.resolveAuditOutFlag)(["--Audit-Out=path.json"])).toBeNull();
    });
    (0, vitest_1.it)("returns null for partial prefix --audit-out (no = sign)", () => {
        // Space-separated form is not supported by resolveAuditOutFlag
        (0, vitest_1.expect)((0, snapshotWriter_js_1.resolveAuditOutFlag)(["--audit-out", "path.json"])).toBeNull();
    });
});
// ---------------------------------------------------------------------------
// writeAuditSnapshot — successful writes
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("writeAuditSnapshot — file writing", () => {
    let tmpDir;
    (0, vitest_1.beforeEach)(() => {
        tmpDir = makeTmpDir();
    });
    (0, vitest_1.afterEach)(() => {
        node_fs_1.default.rmSync(tmpDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)("creates the output file at the specified path", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "audit.json");
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        (0, vitest_1.expect)(node_fs_1.default.existsSync(filePath)).toBe(true);
    });
    (0, vitest_1.it)("written file content is valid JSON (parseable without throwing)", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "audit.json");
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        const raw = node_fs_1.default.readFileSync(filePath, "utf8");
        (0, vitest_1.expect)(() => JSON.parse(raw)).not.toThrow();
    });
    (0, vitest_1.it)("written content matches JSON.stringify(snapshot, null, 2) exactly", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "audit.json");
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        const raw = node_fs_1.default.readFileSync(filePath, "utf8");
        (0, vitest_1.expect)(raw).toBe(JSON.stringify(snapshot, null, 2));
    });
    (0, vitest_1.it)("written JSON contains the snapshotId field", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "audit.json");
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        const parsed = JSON.parse(node_fs_1.default.readFileSync(filePath, "utf8"));
        (0, vitest_1.expect)(parsed).toHaveProperty("snapshotId");
    });
    (0, vitest_1.it)("written JSON contains all 8 required snapshot fields", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "audit.json");
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        const parsed = JSON.parse(node_fs_1.default.readFileSync(filePath, "utf8"));
        (0, vitest_1.expect)(parsed).toHaveProperty("snapshotId");
        (0, vitest_1.expect)(parsed).toHaveProperty("timestamp");
        (0, vitest_1.expect)(parsed).toHaveProperty("input");
        (0, vitest_1.expect)(parsed).toHaveProperty("result");
        (0, vitest_1.expect)(parsed).toHaveProperty("contradictionFlags");
        (0, vitest_1.expect)(parsed).toHaveProperty("reasonCodes");
        (0, vitest_1.expect)(parsed).toHaveProperty("traceReasonMapping");
        (0, vitest_1.expect)(parsed).toHaveProperty("parityValid");
    });
    (0, vitest_1.it)("creates parent directories when they do not exist", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "nested", "deep", "audit.json");
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        (0, vitest_1.expect)(node_fs_1.default.existsSync(filePath)).toBe(true);
    });
    (0, vitest_1.it)("creates parent directories three levels deep without error", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "a", "b", "c", "snap.json");
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        const raw = node_fs_1.default.readFileSync(filePath, "utf8");
        (0, vitest_1.expect)(() => JSON.parse(raw)).not.toThrow();
    });
    (0, vitest_1.it)("does not throw when parent directory already exists", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "audit.json");
        // Parent dir already exists (tmpDir itself)
        (0, vitest_1.expect)(() => (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath)).not.toThrow();
    });
    (0, vitest_1.it)("returns undefined (void — no return value)", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "audit.json");
        const returnVal = (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        (0, vitest_1.expect)(returnVal).toBeUndefined();
    });
    (0, vitest_1.it)("snapshot object is not mutated by writeAuditSnapshot", () => {
        const snapshot = buildFixedSnapshot();
        const originalId = snapshot.snapshotId;
        const originalTimestamp = snapshot.timestamp;
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, node_path_1.default.join(tmpDir, "audit.json"));
        (0, vitest_1.expect)(snapshot.snapshotId).toBe(originalId);
        (0, vitest_1.expect)(snapshot.timestamp).toBe(originalTimestamp);
    });
    (0, vitest_1.it)("preserves snapshotId in written JSON matching the original snapshot", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "audit.json");
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        const parsed = JSON.parse(node_fs_1.default.readFileSync(filePath, "utf8"));
        (0, vitest_1.expect)(parsed["snapshotId"]).toBe(snapshot.snapshotId);
    });
    (0, vitest_1.it)("preserves timestamp in written JSON matching the original snapshot", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "audit.json");
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        const parsed = JSON.parse(node_fs_1.default.readFileSync(filePath, "utf8"));
        (0, vitest_1.expect)(parsed["timestamp"]).toBe(FIXED_TIMESTAMP);
    });
    (0, vitest_1.it)("written JSON is pretty-printed (contains newlines)", () => {
        const snapshot = buildFixedSnapshot();
        const filePath = node_path_1.default.join(tmpDir, "audit.json");
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        const raw = node_fs_1.default.readFileSync(filePath, "utf8");
        (0, vitest_1.expect)(raw).toContain("\n");
    });
    (0, vitest_1.it)("works correctly with a blocked-mode snapshot", () => {
        const snapshot = (0, auditSnapshot_js_1.buildAuditSnapshot)(makeInput({ riskScore: 0.9, confidenceScore: 0.7, mode: "blocked" }), makeResult({ riskScore: 0.9, confidenceScore: 0.7, mode: "blocked" }), { timestamp: FIXED_TIMESTAMP, reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"] });
        const filePath = node_path_1.default.join(tmpDir, "blocked-audit.json");
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, filePath);
        const parsed = JSON.parse(node_fs_1.default.readFileSync(filePath, "utf8"));
        const result = parsed["result"];
        (0, vitest_1.expect)(result["mode"]).toBe("blocked");
    });
});
// ---------------------------------------------------------------------------
// writeAuditSnapshot — failure handling
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("writeAuditSnapshot — failure handling (bad path / I/O error)", () => {
    (0, vitest_1.it)("does not throw when writeFileSync fails", () => {
        const snapshot = buildFixedSnapshot();
        const writeFileSpy = vitest_1.vi
            .spyOn(node_fs_1.default, "writeFileSync")
            .mockImplementationOnce(() => {
            throw new Error("ENOSPC: no space left on device");
        });
        (0, vitest_1.expect)(() => (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, "/tmp/test-no-throw.json")).not.toThrow();
        writeFileSpy.mockRestore();
    });
    (0, vitest_1.it)("logs to stderr when writeFileSync fails", () => {
        const snapshot = buildFixedSnapshot();
        const stderrSpy = vitest_1.vi.spyOn(console, "error").mockImplementation(() => undefined);
        const writeFileSpy = vitest_1.vi
            .spyOn(node_fs_1.default, "writeFileSync")
            .mockImplementationOnce(() => {
            throw new Error("ENOSPC: no space left on device");
        });
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, "/tmp/test-stderr.json");
        (0, vitest_1.expect)(stderrSpy).toHaveBeenCalled();
        stderrSpy.mockRestore();
        writeFileSpy.mockRestore();
    });
    (0, vitest_1.it)("error log message contains '[audit] Failed to write snapshot:'", () => {
        const snapshot = buildFixedSnapshot();
        let capturedMessage = "";
        const stderrSpy = vitest_1.vi
            .spyOn(console, "error")
            .mockImplementation((msg) => {
            capturedMessage = msg;
        });
        const writeFileSpy = vitest_1.vi
            .spyOn(node_fs_1.default, "writeFileSync")
            .mockImplementationOnce(() => {
            throw new Error("disk is full");
        });
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, "/tmp/test-msg.json");
        (0, vitest_1.expect)(capturedMessage).toContain("[audit] Failed to write snapshot:");
        stderrSpy.mockRestore();
        writeFileSpy.mockRestore();
    });
    (0, vitest_1.it)("error log message includes the original error text", () => {
        const snapshot = buildFixedSnapshot();
        let capturedMessage = "";
        const stderrSpy = vitest_1.vi
            .spyOn(console, "error")
            .mockImplementation((msg) => {
            capturedMessage = msg;
        });
        const writeFileSpy = vitest_1.vi
            .spyOn(node_fs_1.default, "writeFileSync")
            .mockImplementationOnce(() => {
            throw new Error("permission denied");
        });
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, "/tmp/test-errmsg.json");
        (0, vitest_1.expect)(capturedMessage).toContain("permission denied");
        stderrSpy.mockRestore();
        writeFileSpy.mockRestore();
    });
    (0, vitest_1.it)("does not log to stdout (console.log) on success", () => {
        const tmpDir = makeTmpDir();
        const snapshot = buildFixedSnapshot();
        const logSpy = vitest_1.vi.spyOn(console, "log").mockImplementation(() => undefined);
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, node_path_1.default.join(tmpDir, "audit.json"));
        (0, vitest_1.expect)(logSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
        node_fs_1.default.rmSync(tmpDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)("does not log to stdout (console.log) on failure", () => {
        const snapshot = buildFixedSnapshot();
        const logSpy = vitest_1.vi.spyOn(console, "log").mockImplementation(() => undefined);
        const writeFileSpy = vitest_1.vi
            .spyOn(node_fs_1.default, "writeFileSync")
            .mockImplementationOnce(() => {
            throw new Error("error");
        });
        (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, "/tmp/test-no-stdout.json");
        (0, vitest_1.expect)(logSpy).not.toHaveBeenCalled();
        logSpy.mockRestore();
        writeFileSpy.mockRestore();
    });
});
//# sourceMappingURL=snapshotWriter.test.js.map