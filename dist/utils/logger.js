"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.LOG_LEVEL = void 0;
exports.logInfo = logInfo;
exports.logSuccess = logSuccess;
exports.logWarn = logWarn;
exports.logError = logError;
exports.printFeatureAgentReport = printFeatureAgentReport;
exports.LOG_LEVEL = (() => {
    const raw = String(process.env.ZONE_LOG_LEVEL || "debug")
        .trim()
        .toLowerCase();
    if (raw === "info" || raw === "quiet")
        return raw;
    return "debug";
})();
exports.logger = {
    debug: (...args) => {
        if (exports.LOG_LEVEL === "debug")
            console.log(...args);
    },
    info: (...args) => {
        if (exports.LOG_LEVEL === "debug" || exports.LOG_LEVEL === "info")
            console.log(...args);
    },
    error: (...args) => {
        console.error(...args);
    },
};
function timestamp() {
    return new Date().toISOString();
}
function logInfo(message) {
    console.log(`[INFO ${timestamp()}] ${message}`);
}
function logSuccess(message) {
    console.log(`[SUCCESS ${timestamp()}] ${message}`);
}
function logWarn(message) {
    console.warn(`[WARN ${timestamp()}] ${message}`);
}
function logError(message) {
    console.error(`[ERROR ${timestamp()}] ${message}`);
}
function printSection(title) {
    console.log(`\n=== ${title} ===`);
}
function printKeyValue(label, value) {
    console.log(`${label.padEnd(18)}: ${value}`);
}
function truncate(value, maxLength = 180) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 3)}...`;
}
function uniqueStrings(items = []) {
    return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
function printIssueList(issues = [], options) {
    const limit = options?.limit ?? 5;
    const emptyMessage = options?.emptyMessage ?? "No issues.";
    if (!issues.length) {
        console.log(emptyMessage);
        return;
    }
    const visible = issues.slice(0, limit);
    for (const issue of visible) {
        const fileText = issue.file ? ` [${issue.file}]` : "";
        const detailsRaw = Array.isArray(issue.details)
            ? issue.details.join("; ")
            : issue.details;
        const detailsText = detailsRaw ? ` | ${truncate(detailsRaw, 120)}` : "";
        console.log(`- [${issue.severity.toUpperCase()}] ${issue.code}: ${truncate(issue.message, 180)}${fileText}${detailsText}`);
    }
    if (issues.length > visible.length) {
        console.log(`- ...and ${issues.length - visible.length} more`);
    }
}
function printStringList(items = [], options) {
    const limit = options?.limit ?? 6;
    const emptyMessage = options?.emptyMessage ?? "- none";
    const truncateAt = options?.truncateAt ?? 180;
    const uniqueItems = uniqueStrings(items);
    if (!uniqueItems.length) {
        console.log(emptyMessage);
        return;
    }
    const visible = uniqueItems.slice(0, limit);
    for (const item of visible) {
        console.log(`- ${truncate(item, truncateAt)}`);
    }
    if (uniqueItems.length > visible.length) {
        console.log(`- ...and ${uniqueItems.length - visible.length} more`);
    }
}
function printIssueSummary(label, issues = []) {
    const errorCount = issues.filter((issue) => issue.severity === "error").length;
    const warningCount = issues.filter((issue) => issue.severity === "warning").length;
    printKeyValue(label, `${errorCount} error(s), ${warningCount} warning(s)`);
}
function printFeatureAgentReport(result) {
    printSection("INTENT ANALYSIS");
    printKeyValue("Task", truncate(result.task, 120));
    printKeyValue("Operation", result.intent?.action ?? "unknown");
    printKeyValue("Resource Kind", result.intent?.resourceKind ?? "unknown");
    printKeyValue("Scope", result.intent?.scope ?? "unknown");
    printKeyValue("Parent", result.intent?.parentResource ?? "unknown");
    printKeyValue("Nested", result.intent?.nestedResource ?? "n/a");
    printKeyValue("Intent Score", result.confidence?.intentClarity ?? "n/a");
    if (result.intent?.warnings?.length) {
        console.log("\nIntent warnings:");
        printStringList(result.intent.warnings, {
            limit: 4,
            truncateAt: 160
        });
    }
    printSection("SCHEMA & STORAGE");
    printKeyValue("Schema Score", result.confidence?.schemaCertainty ?? "n/a");
    printKeyValue("Storage Score", result.confidence?.storageCertainty ?? "n/a");
    printKeyValue("Patch Health", result.confidence?.patchValidationHealth ?? "n/a");
    printKeyValue("Primary Storage", result.storageInsight?.primaryStorage ?? "unknown");
    printKeyValue("Detected Clients", result.storageInsight?.detectedClients.join(", ") || "n/a");
    if (result.schemaAwareSummary?.summary) {
        printKeyValue("Schema Summary", truncate(result.schemaAwareSummary.summary, 180));
    }
    if (result.schemaAwareSummary?.entities?.length) {
        printKeyValue("Entities", truncate(result.schemaAwareSummary.entities.join(", "), 120));
    }
    if (result.storageInsight?.reasoning?.length) {
        console.log("\nStorage reasoning:");
        printStringList(result.storageInsight.reasoning, {
            limit: 4,
            truncateAt: 160
        });
    }
    printSection("VALIDATION SUMMARY");
    printIssueSummary("Patch Validation", result.patchValidationIssues);
    printIssueSummary("Schema Validation", result.schemaPatchWarnings);
    if (result.patchValidationIssues?.length) {
        console.log("\nPatch validation issues:");
        printIssueList(result.patchValidationIssues, {
            limit: 4,
            emptyMessage: "No patch validation issues."
        });
    }
    if (result.schemaPatchWarnings?.length) {
        console.log("\nSchema validation issues:");
        printIssueList(result.schemaPatchWarnings, {
            limit: 4,
            emptyMessage: "No schema validation issues."
        });
    }
    printSection("FINAL DECISION");
    printKeyValue("Mode", result.decision?.mode ?? "unknown");
    printKeyValue("Confidence", `${result.decision?.confidenceScore ?? result.confidence?.finalScore ?? 0}/100`);
    printKeyValue("Reason", truncate(result.decision?.reason ?? "n/a", 180));
    if (result.architectureWarnings?.length) {
        console.log("\nArchitecture warnings:");
        printStringList(result.architectureWarnings, {
            limit: 4,
            truncateAt: 160
        });
    }
    if (result.patchRiskWarnings?.length) {
        console.log("\nPatch risk warnings:");
        printStringList(result.patchRiskWarnings, {
            limit: 4,
            truncateAt: 160
        });
    }
    if (result.executionNotes?.notes?.length) {
        console.log("\nExecution notes:");
        printStringList(result.executionNotes.notes, {
            limit: 4,
            truncateAt: 160
        });
    }
    if (result.executionNotes?.assumptions?.length) {
        console.log("\nAssumptions:");
        printStringList(result.executionNotes.assumptions, {
            limit: 4,
            truncateAt: 160
        });
    }
    if (result.executionNotes?.followUps?.length) {
        console.log("\nRecommended follow-ups:");
        printStringList(result.executionNotes.followUps, {
            limit: 5,
            truncateAt: 160
        });
    }
    if (result.applyResults?.length) {
        printSection("APPLY RESULTS");
        for (const item of result.applyResults) {
            console.log(`- ${item.path} -> ${item.action}${item.outputPath ? ` (${item.outputPath})` : ""}`);
            console.log(`  reason: ${truncate(item.reason, 160)}`);
        }
    }
}
//# sourceMappingURL=logger.js.map