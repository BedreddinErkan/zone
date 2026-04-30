"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestCommandApproval = requestCommandApproval;
exports.resolveCommandApproval = resolveCommandApproval;
exports.rejectPendingApprovalsForRun = rejectPendingApprovalsForRun;
const node_crypto_1 = __importDefault(require("node:crypto"));
const pendingApprovals = new Map();
function requestCommandApproval(input) {
    const runId = String(input.runId || "").trim();
    const command = String(input.command || "");
    const approvalId = node_crypto_1.default.randomUUID();
    const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : 5 * 60 * 1000;
    input.emit({ type: "command_approval_required", runId, command, approvalId });
    return new Promise((resolve) => {
        const finish = (approved) => {
            const entry = pendingApprovals.get(approvalId);
            if (entry) {
                try {
                    clearTimeout(entry.timeout);
                }
                catch { }
                pendingApprovals.delete(approvalId);
            }
            resolve({ approvalId, approved });
        };
        const timeout = setTimeout(() => finish(false), timeoutMs);
        pendingApprovals.set(approvalId, { runId, command, resolve: finish, timeout });
        if (input.abortSignal) {
            if (input.abortSignal.aborted) {
                finish(false);
                return;
            }
            const onAbort = () => {
                try {
                    input.abortSignal?.removeEventListener("abort", onAbort);
                }
                catch { }
                finish(false);
            };
            try {
                input.abortSignal.addEventListener("abort", onAbort, { once: true });
            }
            catch { }
        }
    });
}
function resolveCommandApproval(input) {
    const approvalId = String(input.approvalId || "").trim();
    const approved = !!input.approved;
    const runId = String(input.runId || "").trim();
    const entry = pendingApprovals.get(approvalId);
    if (!entry)
        return { ok: false, message: "unknown_approval_id" };
    if (runId && entry.runId && runId !== entry.runId)
        return { ok: false, message: "run_id_mismatch" };
    entry.resolve(approved);
    return { ok: true };
}
function rejectPendingApprovalsForRun(runIdRaw) {
    const runId = String(runIdRaw || "").trim();
    if (!runId)
        return 0;
    let n = 0;
    for (const [approvalId, entry] of Array.from(pendingApprovals.entries())) {
        if (entry.runId === runId) {
            n += 1;
            try {
                entry.resolve(false);
            }
            catch { }
            pendingApprovals.delete(approvalId);
            try {
                clearTimeout(entry.timeout);
            }
            catch { }
        }
    }
    return n;
}
//# sourceMappingURL=commandApprovals.js.map