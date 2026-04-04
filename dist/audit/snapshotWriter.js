"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeAuditSnapshot = writeAuditSnapshot;
exports.resolveAuditOutFlag = resolveAuditOutFlag;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// ---------------------------------------------------------------------------
// writeAuditSnapshot
// ---------------------------------------------------------------------------
/**
 * Writes a serialized AuditSnapshot to disk as pretty-printed JSON.
 *
 * Side-effect only: no return value, no mutation of the snapshot.
 * Parent directories are created automatically when missing.
 *
 * On failure the error is logged to stderr and the function returns normally —
 * it never throws and never affects stdout.
 *
 * @param snapshot - The AuditSnapshot to serialize.
 * @param filePath - Absolute or relative path for the output file.
 */
function writeAuditSnapshot(snapshot, filePath) {
    try {
        const dir = node_path_1.default.dirname(filePath);
        node_fs_1.default.mkdirSync(dir, { recursive: true });
        node_fs_1.default.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf8");
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[audit] Failed to write snapshot: ${message}`);
    }
}
// ---------------------------------------------------------------------------
// resolveAuditOutFlag
// ---------------------------------------------------------------------------
/**
 * Parses the `--audit-out=<path>` flag from a raw argv array.
 *
 * Accepts only the `--audit-out=value` form (equals-delimited). A flag with
 * an empty value (`--audit-out=`) is treated as absent and returns null.
 *
 * @param argv - The raw argument vector to inspect (e.g. process.argv).
 * @returns The path string when the flag is present with a non-empty value,
 *          or null when absent / empty.
 */
function resolveAuditOutFlag(argv) {
    const prefix = "--audit-out=";
    for (const arg of argv) {
        if (arg.startsWith(prefix)) {
            const value = arg.slice(prefix.length);
            return value.length > 0 ? value : null;
        }
    }
    return null;
}
//# sourceMappingURL=snapshotWriter.js.map