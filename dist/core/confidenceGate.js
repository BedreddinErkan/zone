"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkConfidenceGate = checkConfidenceGate;
exports.renderConfidenceGateBlock = renderConfidenceGateBlock;
const THRESHOLDS = {
    developer: 60,
    test_engineer: 50,
    data_analyst: 70,
    default: 60,
};
const ROLE_RISK_DESCRIPTIONS = {
    developer: [
        "Low confidence may indicate unclear task scope",
        "Existing code patterns may not be well understood",
        "Generated code may not follow project conventions",
    ],
    test_engineer: [
        "Test framework may not be fully detected",
        "Page object method names may be inaccurate",
        "Test file paths may not match project structure",
    ],
    data_analyst: [
        "Schema changes are irreversible without a backup",
        "Column types may not match existing data",
        "Foreign key constraints may be violated",
    ],
};
function getThreshold(role) {
    if (!role)
        return THRESHOLDS.default;
    return THRESHOLDS[role] ?? THRESHOLDS.default;
}
function getRisks(role, warnings) {
    const roleRisks = ROLE_RISK_DESCRIPTIONS[role ?? "developer"] ??
        ROLE_RISK_DESCRIPTIONS["developer"];
    const warningRisks = (warnings ?? [])
        .filter(Boolean)
        .map(w => `Warning: ${w}`);
    return [...roleRisks, ...warningRisks];
}
function getRecommendation(confidenceScore, threshold, role) {
    const gap = threshold - confidenceScore;
    if (gap > 30) {
        return "Confidence is too low to proceed safely. " +
            "Provide more context in your task description, " +
            "or manually specify the target files.";
    }
    if (role === "test_engineer") {
        return "Review the detected framework and page objects before applying. " +
            "Consider running with --verbose to see what was detected.";
    }
    if (role === "data_analyst") {
        return "Review the generated SQL carefully before applying. " +
            "Ensure a database backup exists before running migrations.";
    }
    return "Review the patch preview carefully before applying. " +
        "Consider using --format detailed to see full output.";
}
function checkConfidenceGate(input) {
    const threshold = getThreshold(input.role);
    if (input.confidenceScore >= threshold) {
        return { pass: true };
    }
    return {
        pass: false,
        reason: `Confidence score ${input.confidenceScore} is below the ${input.role ?? "default"} threshold of ${threshold}.`,
        risks: getRisks(input.role, input.warnings),
        recommendation: getRecommendation(input.confidenceScore, threshold, input.role),
    };
}
function renderConfidenceGateBlock(result) {
    const lines = [];
    lines.push("=== CONFIDENCE GATE ===");
    lines.push(`Status: BLOCKED`);
    lines.push(`Reason: ${result.reason}`);
    lines.push("");
    lines.push("Risks:");
    result.risks.forEach(r => lines.push(`- ${r}`));
    lines.push("");
    lines.push(`Recommendation: ${result.recommendation}`);
    return lines.join("\n");
}
//# sourceMappingURL=confidenceGate.js.map