"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.printContradictionFlags = printContradictionFlags;
exports.printAuditSnapshot = printAuditSnapshot;
/**
 * Prints contradiction flags to stdout.
 * Each flag is prefixed with a warning emoji and shows its type and message.
 * No-ops when the flags array is empty.
 */
function printContradictionFlags(flags) {
    if (flags.length === 0) {
        return;
    }
    for (const flag of flags) {
        console.log(`\u26a0\ufe0f [${flag.type}] ${flag.message}`);
    }
}
/**
 * Serializes a full AuditSnapshot to stdout as pretty-printed JSON.
 * No-ops silently when snapshot is null or undefined.
 * Never throws — any serialization errors are swallowed.
 */
function printAuditSnapshot(snapshot) {
    if (snapshot == null) {
        return;
    }
    try {
        console.log(JSON.stringify(snapshot, null, 2));
    }
    catch {
        // serialization errors must never propagate from a print helper
    }
}
//# sourceMappingURL=output.js.map