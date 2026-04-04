"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.diffAuditSnapshots = diffAuditSnapshots;
function sortStrings(values) {
    return [...values].sort();
}
function getAddedItems(previous, current) {
    const previousSet = new Set(previous);
    return sortStrings(current.filter((item) => !previousSet.has(item)));
}
function getRemovedItems(previous, current) {
    const currentSet = new Set(current);
    return sortStrings(previous.filter((item) => !currentSet.has(item)));
}
function serializeTraceReasonMapping(entries) {
    return sortStrings(entries.map((entry) => `${entry.code}|${entry.severity}|${entry.category}|${entry.message}`));
}
function diffAuditSnapshots(previous, current) {
    const previousReasonCodes = previous.reasonCodes ?? [];
    const currentReasonCodes = current.reasonCodes ?? [];
    const previousFlags = (previous.contradictionFlags ?? []).map(String);
    const currentFlags = (current.contradictionFlags ?? []).map(String);
    const previousTrace = serializeTraceReasonMapping(previous.traceReasonMapping);
    const currentTrace = serializeTraceReasonMapping(current.traceReasonMapping);
    const reasonCodesAdded = getAddedItems(previousReasonCodes, currentReasonCodes);
    const reasonCodesRemoved = getRemovedItems(previousReasonCodes, currentReasonCodes);
    const contradictionFlagsAdded = getAddedItems(previousFlags, currentFlags);
    const contradictionFlagsRemoved = getRemovedItems(previousFlags, currentFlags);
    return {
        modeChanged: previous.result.mode !== current.result.mode,
        confidenceChanged: previous.input.confidenceScore !== current.input.confidenceScore,
        riskChanged: previous.input.riskScore !== current.input.riskScore,
        parityChanged: previous.parityValid !== current.parityValid,
        contradictionFlagsAdded,
        contradictionFlagsRemoved,
        reasonCodesAdded,
        reasonCodesRemoved,
        traceReasonMappingChanged: JSON.stringify(previousTrace) !== JSON.stringify(currentTrace),
        previous: {
            mode: previous.result.mode,
            confidenceScore: previous.input.confidenceScore,
            riskScore: previous.input.riskScore,
            parityValid: previous.parityValid,
        },
        current: {
            mode: current.result.mode,
            confidenceScore: current.input.confidenceScore,
            riskScore: current.input.riskScore,
            parityValid: current.parityValid,
        },
    };
}
//# sourceMappingURL=snapshotDiff.js.map