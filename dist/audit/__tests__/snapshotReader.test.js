"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const snapshotReader_js_1 = require("../snapshotReader.js");
const TEST_FILE = node_path_1.default.join(__dirname, "test-snapshot.json");
(0, vitest_1.describe)("readAuditSnapshot", () => {
    (0, vitest_1.it)("reads and parses a valid snapshot file", () => {
        const data = {
            snapshotId: "id-1",
            timestamp: "2026-04-02T00:00:00.000Z",
            input: { riskScore: 0.4, confidenceScore: 0.7, mode: "preview_only" },
            result: {
                mode: "preview_only",
                riskScore: 0.4,
                confidenceScore: 0.7,
                contradictionFlags: [],
            },
            contradictionFlags: [],
            reasonCodes: [],
            traceReasonMapping: [],
            parityValid: true,
        };
        node_fs_1.default.writeFileSync(TEST_FILE, JSON.stringify(data, null, 2));
        const result = (0, snapshotReader_js_1.readAuditSnapshot)(TEST_FILE);
        (0, vitest_1.expect)(result).not.toBeNull();
        (0, vitest_1.expect)(result?.snapshotId).toBe("id-1");
        node_fs_1.default.unlinkSync(TEST_FILE);
    });
    (0, vitest_1.it)("returns null if file does not exist", () => {
        const result = (0, snapshotReader_js_1.readAuditSnapshot)("non-existent-file.json");
        (0, vitest_1.expect)(result).toBeNull();
    });
    (0, vitest_1.it)("returns null for invalid JSON", () => {
        node_fs_1.default.writeFileSync(TEST_FILE, "{ invalid json");
        const result = (0, snapshotReader_js_1.readAuditSnapshot)(TEST_FILE);
        (0, vitest_1.expect)(result).toBeNull();
        node_fs_1.default.unlinkSync(TEST_FILE);
    });
});
//# sourceMappingURL=snapshotReader.test.js.map