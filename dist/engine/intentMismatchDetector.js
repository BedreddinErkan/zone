"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectIntentMismatch = detectIntentMismatch;
function detectCodeIntentMismatch(input) {
    const ci = input.codeIntent;
    const scope = input.patchScope;
    const reasonCodes = [];
    const warnings = [];
    if (ci === "bug_fix") {
        if (scope.changedFileCount > 3) {
            reasonCodes.push("BUG_FIX_SCOPE_OVERSHOOT");
            warnings.push("Bug fix expanded across too many files.");
        }
        if (scope.totalChangedLines > 40) {
            reasonCodes.push("LARGE_CHANGED_LINE_COUNT");
            warnings.push("Bug fix changed more lines than expected.");
        }
    }
    if (ci === "refactor") {
        if (scope.rewriteLikeSuspicion && scope.changedFileCount > 5) {
            reasonCodes.push("REFACTOR_FULL_REWRITE");
            warnings.push("Refactor looks like a full rewrite across many files.");
        }
    }
    if (ci === "feature_add") {
        if (scope.changedFileCount > 8) {
            reasonCodes.push("FEATURE_EXCESSIVE_FILE_COUNT");
            warnings.push("Feature touches an unusually high number of files.");
        }
    }
    if (ci === "style_change") {
        if (!scope.cssRewriteSuspicion && scope.changedFileCount > 2) {
            reasonCodes.push("STYLE_CHANGE_NON_CSS_EXPANSION");
            warnings.push("Style change expanded into non-style files.");
        }
    }
    if (ci === "config_change") {
        if (scope.changedFileCount > 2) {
            reasonCodes.push("CONFIG_MULTI_FILE_EXPANSION");
            warnings.push("Config change expanded across multiple files.");
        }
    }
    if (reasonCodes.length === 0) {
        return {
            hasMismatch: false,
            severity: "none",
            reasonCodes: [],
            warnings: [],
            forcePreviewOnly: false,
        };
    }
    const severity = reasonCodes.includes("REFACTOR_FULL_REWRITE") ||
        reasonCodes.includes("STYLE_CHANGE_NON_CSS_EXPANSION")
        ? "high"
        : reasonCodes.includes("BUG_FIX_SCOPE_OVERSHOOT") ||
            reasonCodes.includes("LARGE_CHANGED_LINE_COUNT")
            ? "medium"
            : "low";
    return {
        hasMismatch: true,
        severity,
        reasonCodes,
        warnings,
        confidenceCap: severity === "high" ? 60 : severity === "medium" ? 72 : undefined,
        forcePreviewOnly: severity === "high",
    };
}
function detectIntentMismatch(input) {
    if (input.taskIntent !== "micro_edit") {
        return detectCodeIntentMismatch(input);
    }
    const reasonCodes = [];
    const warnings = [];
    if (input.patchScope.rewriteLikeSuspicion) {
        reasonCodes.push("LARGE_REWRITE", "STRUCTURAL_LAYOUT_CHANGE");
    }
    if (input.patchScope.cssRewriteSuspicion) {
        reasonCodes.push("MASSIVE_STYLE_INJECTION");
    }
    if (input.patchScope.changedFileCount > 1) {
        reasonCodes.push("MULTI_FILE_EXPANSION");
    }
    if (input.patchScope.totalChangedLines > 15) {
        reasonCodes.push("LARGE_CHANGED_LINE_COUNT");
    }
    if (reasonCodes.length === 0) {
        return {
            hasMismatch: false,
            severity: "none",
            reasonCodes: [],
            warnings: [],
            forcePreviewOnly: false,
        };
    }
    warnings.push("Micro-edit task produced a larger-than-expected patch.");
    if (reasonCodes.includes("MASSIVE_STYLE_INJECTION")) {
        warnings.push("CSS patch scope is too large for a spacing-only request.");
    }
    let severity = "low";
    if (reasonCodes.includes("LARGE_REWRITE") ||
        reasonCodes.includes("STRUCTURAL_LAYOUT_CHANGE") ||
        reasonCodes.includes("MASSIVE_STYLE_INJECTION")) {
        severity = "high";
    }
    else if (reasonCodes.includes("MULTI_FILE_EXPANSION") ||
        input.patchScope.totalChangedLines > 30) {
        severity = "medium";
    }
    return {
        hasMismatch: true,
        severity,
        reasonCodes,
        warnings,
        confidenceCap: 55,
        forcePreviewOnly: severity === "high",
    };
}
//# sourceMappingURL=intentMismatchDetector.js.map