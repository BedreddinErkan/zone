"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeRiskScoreDetails = computeRiskScoreDetails;
function logRiskDebug(label, payload) {
    console.log(`[zone-debug] ${label}: ${JSON.stringify(payload)}`);
}
function clampScore(value) {
    if (value < 0)
        return 0;
    if (value > 100)
        return 100;
    return value;
}
function includesAny(text, keywords) {
    return keywords.some((keyword) => text.includes(keyword));
}
/** Mass-scope words must be real tokens (substring matches cause false positives, e.g. "unchanged" contains "whole"). */
function hasBoundedMassScopeScopeWord(text) {
    return /\b(?:all|every|entire|whole)\b/.test(text);
}
function isExplicitMinimalSingleFileTask(text) {
    if (!/\btarget\s+file\s*:/i.test(text))
        return false;
    return (/\bminimal\b/i.test(text) ||
        /\bsingle[-\s]?file\b/i.test(text) ||
        /\bone\s+file\b/i.test(text));
}
/** "Remove duplicated …" / dedupe-style cleanup is not data-destructive when scoped to one file + minimal patch. */
function isBenignLocalHygieneRemoval(text) {
    if (!/\b(remove|delete)\b/i.test(text))
        return false;
    return /\b(?:duplicat(?:e|ed|es|ing)?|dedupe|redundant|repeat(?:ed)?|unused|obsolete|dead\s+code|lint|debug|console\.|assertion|validation\s+checks?)\b/i.test(text);
}
function hasCatastrophicDestructiveIntent(text) {
    return (includesAny(text, [
        "truncate",
        "drop table",
        "delete all",
        "remove all",
        "wipe",
        "purge",
    ]) ||
        /\b(?:delete|remove)\s+every\b/i.test(text) ||
        /\b(?:delete|remove)\s+all\b/i.test(text) ||
        /\b(?:drop|delete)\s+table\b/i.test(text));
}
function hasContextualSoftDestructiveSignal(text) {
    const softDestructiveKeywords = ["clear", "reset", "clean"];
    const destructiveObjectKeywords = [
        "cache",
        "session",
        "sessions",
        "token",
        "tokens",
        "database",
        "db",
        "table",
        "tables",
        "record",
        "records",
        "row",
        "rows",
        "data",
        "user",
        "users",
        "storage",
        "queue",
        "queues",
    ];
    return (includesAny(text, softDestructiveKeywords) &&
        includesAny(text, destructiveObjectKeywords));
}
function isReactStateManagementContext(text) {
    return includesAny(text, [
        "usereducer",
        "reducer",
        "dispatch",
        "usestate",
        "react state",
        "action type",
        "action:",
    ]);
}
function scoreWeightedKeywordMatches(text, weightedKeywords) {
    let maxWeight = 0;
    for (const entry of weightedKeywords) {
        if (includesAny(text, entry.keywords)) {
            maxWeight = Math.max(maxWeight, entry.weight);
        }
    }
    return maxWeight;
}
function hasSchemaContextExemption(text) {
    return includesAny(text, ["test", "mock", "fixture", "seed"]);
}
function isSchemaKeywordPrecededByTestOrMock(text, keyword) {
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b(?:test|mock)\\s+${escapedKeyword}\\b`).test(text);
}
function computeRiskScoreDetails(input) {
    const normalizedTask = input.task.trim().toLowerCase();
    const hasReactStateManagementContext = isReactStateManagementContext(normalizedTask);
    const hasSoftDestructiveKeyword = includesAny(normalizedTask, [
        "clear",
        "reset",
        "clean",
    ]);
    const hasStrongDestructiveKeyword = includesAny(normalizedTask, [
        "truncate",
        "drop table",
        "delete all",
        "wipe",
        "purge",
        "delete",
        "remove",
        "destroy",
        "drop",
    ]);
    const hasReplaceWithPattern = normalizedTask.includes("replace") && normalizedTask.includes("with");
    const hasCriticalSignal = includesAny(normalizedTask, [
        "auth",
        "authentication",
        "authorization",
        "billing",
        "payment",
        "payments",
        "permission",
        "permissions",
        "security",
        "middleware",
        "jwt",
        "jwt verification",
        "token validation",
        "skip auth",
        "bypass auth",
        "haspaidaccess",
        "paid access",
        "subscription bypass",
        "always return true",
        "return true",
        "bypass subscription",
        "free access",
        "bypass billing",
        "override billing",
        "access token",
        "refresh token",
        "api key",
        "secret key",
        "production",
        "prod env",
    ]);
    let destructiveWeight = Math.max(scoreWeightedKeywordMatches(normalizedTask, [
        {
            keywords: ["truncate", "drop table", "delete all", "wipe", "purge"],
            weight: 1.0,
        },
        {
            keywords: ["modify"],
            weight: hasCriticalSignal ? 0.4 : 0,
        },
        {
            keywords: ["skip", "bypass", "disable", "circumvent"],
            weight: 0.7,
        },
        {
            keywords: ["delete", "remove", "destroy", "drop"],
            weight: 0.7,
        },
    ]), hasContextualSoftDestructiveSignal(normalizedTask) ? 0.4 : 0);
    if (hasReactStateManagementContext &&
        hasSoftDestructiveKeyword &&
        !hasStrongDestructiveKeyword) {
        destructiveWeight = 0;
    }
    if (hasReplaceWithPattern) {
        destructiveWeight = Math.max(0, destructiveWeight - 0.3);
    }
    const schemaHighWeightKeywords = [
        "migration",
        "migrate",
        "alter table",
        "drop column",
        "add column",
        "alter",
        "drop the",
        "add a new column",
        "rename column",
    ];
    const hasHighWeightSchemaSignal = schemaHighWeightKeywords.some((keyword) => {
        if (!normalizedTask.includes(keyword))
            return false;
        if (isSchemaKeywordPrecededByTestOrMock(normalizedTask, keyword)) {
            return false;
        }
        // "column" alone in UI context should not trigger schema
        if ((keyword === "column" || keyword === "add column") &&
            !includesAny(normalizedTask, [
                "alter",
                "drop",
                "database",
                "migration",
                "sql",
                "alter table",
                "drop table",
            ])) {
            return false;
        }
        return true;
    });
    const highWeightSchemaScore = hasHighWeightSchemaSignal ? 25 : 0;
    const reducedSchemaScore = hasSchemaContextExemption(normalizedTask)
        ? 0
        : scoreWeightedKeywordMatches(normalizedTask, [
            {
                keywords: ["schema", "database", "db"],
                weight: 0.6,
            },
        ]) * 25;
    const hasLowRiskSignal = includesAny(normalizedTask, [
        "copy",
        "text",
        "rename",
        "comment",
        "docs",
        "readme",
        "typo",
        "spacing",
        "padding",
        "margin",
        "label",
        "placeholder",
        "wording",
        "alignment",
        "align",
        "font size",
        "color tweak",
        "ui polish",
    ]);
    if (isExplicitMinimalSingleFileTask(normalizedTask) &&
        isBenignLocalHygieneRemoval(normalizedTask) &&
        !hasCatastrophicDestructiveIntent(normalizedTask)) {
        destructiveWeight = 0;
    }
    const hasDestructiveSignal = destructiveWeight > 0;
    const hasSchemaSignal = highWeightSchemaScore > 0 || reducedSchemaScore > 0;
    const hasScopeWord = hasBoundedMassScopeScopeWord(normalizedTask);
    const hasMassScopeSignal = hasReactStateManagementContext
        ? false
        : hasDestructiveSignal && hasScopeWord;
    const codeIntentLowRiskBonus = input.codeIntent === "test_add" ? -15 :
        input.codeIntent === "micro_edit" ? -10 :
            input.codeIntent === "config_change" && !hasCriticalSignal ? 10 :
                0;
    const riskBreakdown = {
        destructive: Math.round(50 * destructiveWeight),
        schema: Math.max(highWeightSchemaScore, Math.round(reducedSchemaScore)),
        critical: hasCriticalSignal ? 20 : 0,
        lowRisk: (hasLowRiskSignal ? -20 : 0) + codeIntentLowRiskBonus,
        massScope: hasMassScopeSignal ? 40 : 0
    };
    let compoundPenalty = 0;
    if (riskBreakdown.destructive > 0 && riskBreakdown.massScope > 0) {
        compoundPenalty += 20;
    }
    if (riskBreakdown.destructive > 0 && riskBreakdown.schema > 0) {
        compoundPenalty += 20;
    }
    if (riskBreakdown.destructive > 0 && riskBreakdown.critical > 0) {
        compoundPenalty += 15;
    }
    if (hasCriticalSignal &&
        includesAny(normalizedTask, [
            "always",
            "regardless",
            "bypass",
            "override",
            "force",
            "hardcode",
        ])) {
        compoundPenalty += 50;
    }
    if (hasCriticalSignal &&
        includesAny(normalizedTask, ["modify", "change", "update", "set"])) {
        compoundPenalty += 15;
    }
    // auth + JWT/token combination = elevated critical
    if (hasCriticalSignal && (normalizedTask.includes("jwt") ||
        normalizedTask.includes("token") ||
        normalizedTask.includes("middleware"))) {
        compoundPenalty += 15;
    }
    const rawScore = riskBreakdown.destructive +
        riskBreakdown.schema +
        riskBreakdown.critical +
        riskBreakdown.lowRisk +
        riskBreakdown.massScope +
        compoundPenalty;
    const riskScore = clampScore(rawScore);
    const detectedSignals = [];
    if (hasDestructiveSignal) {
        detectedSignals.push("destructive");
    }
    if (hasSchemaSignal) {
        detectedSignals.push("schema_change");
    }
    if (hasCriticalSignal) {
        detectedSignals.push("critical_domain");
    }
    if (hasLowRiskSignal) {
        detectedSignals.push("low_risk");
    }
    if (hasMassScopeSignal) {
        detectedSignals.push("mass_scope");
    }
    logRiskDebug("computeRiskScoreDetails result", {
        task: input.task,
        normalizedTask,
        destructiveWeight,
        hasCriticalSignal,
        hasLowRiskSignal,
        hasSchemaSignal,
        hasScopeWord,
        hasMassScopeSignal,
        riskBreakdown,
        detectedSignals,
        compoundPenalty,
        riskScore,
    });
    return {
        riskScore,
        riskBreakdown,
        detectedSignals,
        compoundPenalty
    };
}
//# sourceMappingURL=computeRiskScoreDetails.js.map