"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readAuditSnapshot = readAuditSnapshot;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
/**
 * Reads an audit snapshot JSON file from disk and parses it.
 *
 * Behavior:
 * - Returns parsed AuditSnapshot on success
 * - Returns null on any failure (file not found, invalid JSON, etc.)
 * - Logs error to stderr
 * - NEVER throws
 */
function readAuditSnapshot(filePath) {
    try {
        const absolutePath = node_path_1.default.resolve(filePath);
        const raw = node_fs_1.default.readFileSync(absolutePath, "utf8");
        const parsed = JSON.parse(raw);
        return parsed;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[audit] Failed to read snapshot: ${message}`);
        return null;
    }
}
//# sourceMappingURL=snapshotReader.js.map