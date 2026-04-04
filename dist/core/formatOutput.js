"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatOutput = formatOutput;
const renderRunAgentResult_js_1 = require("./renderRunAgentResult.js");
const buildDecisionAuditSnapshot_js_1 = require("./buildDecisionAuditSnapshot.js");
const decisionReasonCodeMeta_js_1 = require("./decision/decisionReasonCodeMeta.js");
function formatOutput(result, format, options = {}) {
    const { showTrace = false, verbose = false } = options;
    const includeTrace = showTrace || verbose;
    const typedReasonCodes = (result.reasonCodes ?? []);
    const reasonDetails = verbose && typedReasonCodes.length > 0
        ? (0, decisionReasonCodeMeta_js_1.buildDecisionReasonDetails)(typedReasonCodes)
        : undefined;
    const auditSnapshot = verbose
        ? (0, buildDecisionAuditSnapshot_js_1.buildDecisionAuditSnapshot)({
            decision: result.decision,
            risk: result.risk,
            topRisks: result.topRisks,
            reasonCodes: typedReasonCodes,
            trace: result.trace
        })
        : undefined;
    if (format === "json") {
        const baseResult = includeTrace
            ? result
            : (() => {
                const { trace: _trace, ...resultWithoutTrace } = result;
                return resultWithoutTrace;
            })();
        const output = {
            ...baseResult,
            ...(reasonDetails ? { reasonDetails } : {}),
            ...(auditSnapshot ? { auditSnapshot } : {})
        };
        return JSON.stringify(output, null, 2);
    }
    const base = (0, renderRunAgentResult_js_1.renderRunAgentResult)({
        ...result,
        reasonCodes: typedReasonCodes,
        ...(auditSnapshot ? { auditSnapshot } : {})
    }, { verbose });
    if (!includeTrace || !result.trace) {
        return base;
    }
    const lines = [base, "", "--- Decision Trace ---", "Path:"];
    for (const step of result.trace.decisionPath) {
        lines.push(`→ ${step}`);
    }
    lines.push(`Formula: ${result.trace.confidenceFormula}`);
    lines.push(`Triggered by: ${result.trace.decisionFactors.triggeredBy.join(", ") || "none"}`);
    return lines.join("\n");
}
//# sourceMappingURL=formatOutput.js.map