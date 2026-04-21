"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.semanticRiskRules = exports.detectBroadErrorSwallowing = exports.detectSecretExposedToLog = exports.detectTestAssertionRemoved = exports.detectRateLimitRemoved = exports.detectValidationRemoved = exports.detectRoleCheckRemoved = exports.detectAuthGuardRemoved = void 0;
exports.isCommentOnlyDiff = isCommentOnlyDiff;
function countPatternMatches(content, pattern) {
    return content.match(pattern)?.length ?? 0;
}
function findMatchedTokens(content, patterns) {
    return patterns
        .flatMap((pattern) => content.match(pattern) ?? [])
        .map((match) => match.trim())
        .filter((match, index, values) => values.indexOf(match) === index);
}
function isCommentOnlyDiff(diffLines) {
    const addedLines = diffLines
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1).trim())
        .filter((line) => line.length > 0);
    if (addedLines.length === 0) {
        return false;
    }
    return addedLines.every((line) => line.startsWith("//") ||
        line.startsWith("/*") ||
        line.startsWith("*"));
}
function buildRisk(input, code, severity, category, message, evidence) {
    return {
        code,
        severity,
        category,
        message,
        filePath: input.filePath,
        evidence,
    };
}
const authGuardPatterns = [
    /\brequireAuth\b/g,
    /\bauthenticate\b/g,
    /\bProtectedRoute\b/g,
];
const roleCheckPatterns = [
    /\bhasRole\b/g,
    /\brequireRole\b/g,
    /\bcheckRole\b/g,
    /\brole\s*===\s*["'`][^"'`]+["'`]/g,
    /\broles?\s*\.includes\(/g,
    /\bpermissions?\s*\.includes\(/g,
];
const validationPatterns = [
    /\bz\.object\s*\(/g,
    /\bz\.string\s*\(/g,
    /\bz\.number\s*\(/g,
    /\bjoi\./gi,
    /\byup\./gi,
    /\bvalidator\./gi,
    /\bvalidate\w*\s*\(/g,
];
const rateLimitPatterns = [
    /\brateLimit\b/g,
    /\brateLimiter\b/g,
    /\bapplyRateLimit\b/g,
    /\bthrottle\b/g,
    /\btoo many requests\b/gi,
];
function collectRemovedRisk(input, code, category, message, patterns, severity) {
    const beforeMatches = findMatchedTokens(input.beforeContent, patterns);
    const afterMatches = findMatchedTokens(input.afterContent, patterns);
    if (beforeMatches.length === 0 || afterMatches.length > 0) {
        return [];
    }
    return [
        buildRisk(input, code, severity, category, message, {
            beforeMatches,
            afterMatches,
        }),
    ];
}
const detectAuthGuardRemoved = (input) => collectRemovedRisk(input, "AUTH_GUARD_REMOVED", "auth", "Authentication guard was removed from the file.", authGuardPatterns, "high");
exports.detectAuthGuardRemoved = detectAuthGuardRemoved;
const detectRoleCheckRemoved = (input) => collectRemovedRisk(input, "ROLE_CHECK_REMOVED", "authorization", "Authorization or role-based access check was removed from the file.", roleCheckPatterns, "high");
exports.detectRoleCheckRemoved = detectRoleCheckRemoved;
const detectValidationRemoved = (input) => {
    if (isCommentOnlyDiff(input.diffLines ?? [])) {
        return [];
    }
    const beforeMatches = findMatchedTokens(input.beforeContent, validationPatterns);
    if (beforeMatches.length === 0) {
        return [];
    }
    const removedLines = (input.diffLines ?? [])
        .filter((line) => line.startsWith("-") && !line.startsWith("---"))
        .map((line) => line.slice(1))
        .join("\n");
    const removedMatches = findMatchedTokens(removedLines, validationPatterns);
    if (removedMatches.length === 0) {
        return [];
    }
    const afterMatches = findMatchedTokens(input.afterContent, validationPatterns);
    return [
        buildRisk(input, "VALIDATION_REMOVED", "high", "validation", "Validation logic appears to have been removed from the file.", {
            beforeMatches,
            afterMatches,
        }),
    ];
};
exports.detectValidationRemoved = detectValidationRemoved;
const detectRateLimitRemoved = (input) => collectRemovedRisk(input, "RATE_LIMIT_REMOVED", "safety_guard", "Rate limiting or throttling protection was removed from the file.", rateLimitPatterns, "high");
exports.detectRateLimitRemoved = detectRateLimitRemoved;
const detectTestAssertionRemoved = (input) => {
    const expectCountBefore = countPatternMatches(input.beforeContent, /\bexpect\s*\(/g);
    const expectCountAfter = countPatternMatches(input.afterContent, /\bexpect\s*\(/g);
    const assertCountBefore = countPatternMatches(input.beforeContent, /\bassert\b/g);
    const assertCountAfter = countPatternMatches(input.afterContent, /\bassert\b/g);
    const beforeCount = expectCountBefore + assertCountBefore;
    const afterCount = expectCountAfter + assertCountAfter;
    if (beforeCount === 0 || afterCount >= beforeCount) {
        return [];
    }
    const removedCount = beforeCount - afterCount;
    const severity = afterCount === 0 ? "high" : "medium";
    return [
        buildRisk(input, "TEST_ASSERTION_REMOVED", severity, "tests", `Test assertions were reduced from ${beforeCount} to ${afterCount}.`, {
            details: `${removedCount} assertion(s) removed`,
        }),
    ];
};
exports.detectTestAssertionRemoved = detectTestAssertionRemoved;
const detectSecretExposedToLog = (input) => {
    const secretLoggingPatterns = [
        /console\.log\s*\(\s*process\.env\b/g,
        /logger\.[a-z]+\s*\(\s*process\.env\b/g,
    ];
    const afterMatches = findMatchedTokens(input.afterContent, secretLoggingPatterns);
    if (afterMatches.length === 0) {
        return [];
    }
    return [
        buildRisk(input, "SECRET_EXPOSED_TO_LOG", "critical", "secrets", "Environment secrets are being written to application logs.", {
            afterMatches,
        }),
    ];
};
exports.detectSecretExposedToLog = detectSecretExposedToLog;
const detectBroadErrorSwallowing = (input) => {
    const broadCatchPatterns = [
        /catch\s*\(\s*[^)]*\s*\)\s*\{\s*\}/g,
        /catch\s*\{\s*\}/g,
    ];
    const beforeMatches = findMatchedTokens(input.beforeContent, broadCatchPatterns);
    const afterMatches = findMatchedTokens(input.afterContent, broadCatchPatterns);
    if (afterMatches.length === 0 || afterMatches.length <= beforeMatches.length) {
        return [];
    }
    return [
        buildRisk(input, "BROAD_ERROR_SWALLOWING", "high", "safety_guard", "Broad catch block swallows errors without handling or rethrowing.", {
            beforeMatches,
            afterMatches,
        }),
    ];
};
exports.detectBroadErrorSwallowing = detectBroadErrorSwallowing;
exports.semanticRiskRules = [
    exports.detectAuthGuardRemoved,
    exports.detectRoleCheckRemoved,
    exports.detectSecretExposedToLog,
    exports.detectTestAssertionRemoved,
    exports.detectValidationRemoved,
    exports.detectRateLimitRemoved,
    exports.detectBroadErrorSwallowing,
];
//# sourceMappingURL=semanticRiskRules.js.map