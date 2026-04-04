"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAuditSnapshot = buildAuditSnapshot;
const node_crypto_1 = require("node:crypto");
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Asserts that the provided reason codes are semantically consistent with the
 * execution mode. Mirrors the intent of assertReasonCodeParity in the decision
 * explanation module: throws an Error on parity violation, returns void on success.
 *
 * Parity rule: when reasonCodes is non-empty, at least one code must carry the
 * prefix that corresponds to the mode:
 *   blocked       → "BLOCKED_"
 *   preview_only  → "PREVIEW_"
 *   safe_to_apply → "SAFE_"
 */
function assertReasonCodeParity(mode, reasonCodes) {
    if (reasonCodes.length === 0) {
        return;
    }
    const modePrefixMap = {
        blocked: "BLOCKED_",
        preview_only: "PREVIEW_",
        safe_to_apply: "SAFE_",
    };
    const expectedPrefix = modePrefixMap[mode];
    const hasMatchingCode = reasonCodes.some((code) => code.startsWith(expectedPrefix));
    if (!hasMatchingCode) {
        throw new Error(`Reason code parity violation: mode "${mode}" expects at least one code ` +
            `prefixed with "${expectedPrefix}". Received: [${reasonCodes.join(", ")}]`);
    }
}
/**
 * Derives a deterministic, non-empty snapshotId from the serialized input and
 * the ISO timestamp. Uses base64 encoding and strips non-alphanumeric characters
 * to produce a compact, URL-safe identifier.
 */
function computeSnapshotId(input, timestamp) {
    const raw = JSON.stringify({
        timestamp,
        input,
    });
    return (0, node_crypto_1.createHash)("sha256").update(raw).digest("hex");
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Builds a frozen, serializable AuditSnapshot that captures the full decision
 * moment in a single immutable object.
 *
 * The function is pure: identical inputs (including timestamp) always produce
 * structurally identical snapshots. Only the timestamp varies between calls
 * when not overridden.
 *
 * @param input   - The original engine input (riskScore, confidenceScore, mode).
 * @param result  - The full DecisionEngineResult including contradictionFlags.
 * @param options - Optional reason codes, trace mapping, and timestamp override.
 * @returns A frozen AuditSnapshot.
 */
function buildAuditSnapshot(input, result, options = {}) {
    const timestamp = options.timestamp ?? new Date().toISOString();
    const reasonCodes = options.reasonCodes ?? [];
    const traceReasonMapping = options.traceReasonMapping ?? [];
    let parityValid;
    try {
        assertReasonCodeParity(result.mode, reasonCodes);
        parityValid = true;
    }
    catch {
        parityValid = false;
    }
    const snapshot = {
        snapshotId: computeSnapshotId(input, timestamp),
        timestamp,
        input,
        result,
        contradictionFlags: result.contradictionFlags,
        reasonCodes,
        traceReasonMapping,
        parityValid,
    };
    return Object.freeze(snapshot);
}
//# sourceMappingURL=auditSnapshot.js.map