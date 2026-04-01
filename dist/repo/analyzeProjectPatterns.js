"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeProjectPatterns = analyzeProjectPatterns;
function analyzeProjectPatterns(files) {
    let authMiddlewareName;
    let responseShape = "unknown";
    let dbClient = "unknown";
    let backendStyle = "unknown";
    let frontendStyle = "unknown";
    const routePatterns = [];
    const evidence = [];
    for (const file of files) {
        const content = file.content;
        if (file.path.includes("/routes/") && /express|router\.(get|post|put|patch|delete)/.test(content)) {
            backendStyle = "express";
            routePatterns.push(file.path);
        }
        if (/requireAuth/.test(content)) {
            authMiddlewareName = "requireAuth";
            evidence.push(`Detected requireAuth in ${file.path}`);
        }
        if (/success\s*:\s*(true|false)/.test(content) && /message\s*:/.test(content) && /data\s*:/.test(content)) {
            responseShape = "success-message-data";
        }
        else if (/data\s*:/.test(content) && /error\s*:/.test(content)) {
            responseShape = "data-error";
        }
        if (/from\(["'`]([a-zA-Z0-9_]+)["'`]\)/.test(content) || /supabase/.test(content)) {
            dbClient = "supabase";
            evidence.push(`Detected Supabase usage in ${file.path}`);
        }
        if (/react|useState|useEffect|jsx/.test(content)) {
            frontendStyle = "react";
        }
    }
    return {
        authMiddlewareName,
        responseShape,
        dbClient,
        backendStyle,
        frontendStyle,
        routePatterns,
        evidence
    };
}
//# sourceMappingURL=analyzeProjectPatterns.js.map