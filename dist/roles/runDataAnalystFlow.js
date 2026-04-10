"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDataAnalystFlow = runDataAnalystFlow;
const scanRepo_js_1 = require("../repo/scanRepo.js");
const readProjectFiles_js_1 = require("../repo/readProjectFiles.js");
const openaiClient_js_1 = require("../llm/openaiClient.js");
const runLlmPatchFlow_js_1 = require("../core/runLlmPatchFlow.js");
const withSelfHealingRetry_js_1 = require("../core/withSelfHealingRetry.js");
const computeRiskScore_js_1 = require("../core/computeRiskScore.js");
const testOutputValidator_js_1 = require("./testOutputValidator.js");
const dataAnalystContext_js_1 = require("./dataAnalystContext.js");
const detectDataSchema_js_1 = require("./detectDataSchema.js");
const dataAnalystPrompt_js_1 = require("../prompts/dataAnalystPrompt.js");
function extractJson(rawText) {
    const trimmed = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}"))
        return trimmed;
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return trimmed.slice(firstBrace, lastBrace + 1);
    }
    throw new Error("No JSON found in model response");
}
function stripJsonFences(raw) {
    return raw
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
}
function buildPreview(result, dialect, migrationFormat) {
    const lines = ["=== DATA ANALYST PREVIEW ==="];
    lines.push(`Dialect: ${dialect}`);
    lines.push(`Migration format: ${migrationFormat}`);
    lines.push(`Summary: ${result["summary"]}`);
    const warnings = result["warnings"];
    if (warnings?.length > 0) {
        lines.push("");
        lines.push("Warnings:");
        warnings.forEach((warning) => lines.push(`- ${warning}`));
    }
    lines.push("");
    lines.push("Files to create:");
    if (result["migrationFile"]) {
        const file = result["migrationFile"];
        lines.push(`- ${file.path}`);
    }
    return lines.join("\n");
}
function buildApplyPatches(result) {
    const patches = [];
    if (result["migrationFile"]) {
        const file = result["migrationFile"];
        if (file.path && file.content) {
            patches.push({ filePath: file.path, fullContent: file.content });
        }
    }
    return patches;
}
async function readExampleContents(files, allFiles, limit) {
    const examplePaths = files
        .slice(0, limit)
        .map((file) => file.absolutePath)
        .filter((filePath) => typeof filePath === "string");
    const contentsMap = examplePaths.length > 0 ? await (0, readProjectFiles_js_1.readProjectFiles)(examplePaths) : {};
    return Object.entries(contentsMap).map(([absPath, content]) => ({
        path: allFiles.find((file) => file.absolutePath === absPath)?.path ?? absPath,
        content,
    }));
}
async function runDataAnalystFlow(input) {
    let allFiles;
    try {
        input.onProgress?.("Scanning repo...");
        allFiles = input.hostedContext
            ? input.hostedContext.availableFiles.map((file) => ({
                path: file.path,
                absolutePath: file.path,
                extension: file.extension,
                category: file.category,
            }))
            : await (0, scanRepo_js_1.scanRepo)(input.repoPath);
        if (!Array.isArray(allFiles)) {
            return {
                ok: false,
                reason: `scanRepo returned unexpected type: ${typeof allFiles}`,
            };
        }
    }
    catch (err) {
        return {
            ok: false,
            reason: `Failed to scan repo: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    let schema;
    try {
        input.onProgress?.("Detecting schema...");
        schema = input.hostedContext?.schema ?? (0, detectDataSchema_js_1.detectDataSchema)(allFiles);
    }
    catch (err) {
        return {
            ok: false,
            reason: `detectDataSchema failed: ${err instanceof Error ? err.stack : String(err)}`,
        };
    }
    let context;
    try {
        context = (0, dataAnalystContext_js_1.buildDataAnalystContext)(input.task, schema, allFiles);
    }
    catch (err) {
        return {
            ok: false,
            reason: `buildDataAnalystContext failed: ${err instanceof Error ? err.stack : String(err)}`,
            dialect: schema.dialect,
        };
    }
    const existingSqlContents = input.hostedContext
        ? input.hostedContext.existingSqlContents
        : await readExampleContents(context.existingSqlFiles, allFiles, 3);
    input.onProgress?.("Building prompt...");
    const prompt = (0, dataAnalystPrompt_js_1.buildDataAnalystPrompt)({
        task: input.task,
        context,
        existingSqlContents,
    });
    input.onProgress?.("Generating patch...");
    const client = (0, openaiClient_js_1.createOpenAIClient)(input.userOpenAiKey);
    const model = (0, openaiClient_js_1.getModelName)();
    const retryResult = await (0, withSelfHealingRetry_js_1.withSelfHealingRetry)({
        maxAttempts: 3,
        prompt,
        execute: async (currentPrompt) => {
            const response = await client.responses.create({
                model,
                input: currentPrompt,
            });
            const rawText = response.output_text || "";
            const jsonText = extractJson(rawText);
            return JSON.parse(stripJsonFences(jsonText));
        },
        validate: (result) => {
            const issues = [];
            if (!result["migrationFile"]) {
                issues.push({
                    code: "MISSING_MIGRATION_FILE",
                    message: "Response is missing migrationFile field.",
                    severity: "error",
                });
            }
            if (typeof result["summary"] !== "string" || !result["summary"]) {
                issues.push({
                    code: "MISSING_SUMMARY",
                    message: "Response is missing summary field.",
                    severity: "warning",
                });
            }
            const migrationContent = result["migrationFile"]?.content;
            if (migrationContent) {
                const sqlValidation = (0, testOutputValidator_js_1.validateTestOutput)({
                    framework: "unknown",
                    sqlContent: migrationContent,
                    sqlDialect: schema.dialect,
                });
                if (sqlValidation.decision === "blocked") {
                    sqlValidation.issues
                        .filter((issue) => issue.severity === "error")
                        .forEach((issue) => {
                        issues.push({
                            code: issue.code,
                            message: issue.message,
                            severity: "error",
                        });
                    });
                }
            }
            return issues;
        },
        buildFeedbackPrompt: withSelfHealingRetry_js_1.buildDefaultFeedbackPrompt,
    });
    if (!retryResult.ok) {
        return {
            ok: false,
            reason: `LLM generation failed after ${retryResult.attempts} attempt(s): ${retryResult.reason}`,
            dialect: schema.dialect,
        };
    }
    let parsed = retryResult.value;
    // Task-level risk scoring for data analyst
    const riskResult = (0, computeRiskScore_js_1.computeRiskScore)({ task: input.task, role: "data_analyst" });
    // Determine decisionMode from risk score
    function mapRiskToDecisionMode(score, signals) {
        // Data analyst knows their domain — never hard block, always preview for review
        if (score >= 31 ||
            signals.includes("schema") ||
            signals.includes("critical_domain") ||
            signals.includes("mass_scope") ||
            signals.includes("destructive"))
            return "preview_only";
        return "safe_to_apply";
    }
    const taskDecisionMode = mapRiskToDecisionMode(riskResult.score, riskResult.signals);
    const applyPatches = buildApplyPatches(parsed);
    const originalContentByPath = new Map(existingSqlContents.map((file) => [file.path, file.content]));
    const preview = buildPreview(parsed, schema.dialect, schema.migrationFormat);
    const confidence = typeof parsed["confidence"] === "number" ? parsed["confidence"] : 50;
    const summary = typeof parsed["summary"] === "string"
        ? parsed["summary"]
        : "Migration generated successfully.";
    const warnings = Array.isArray(parsed["warnings"])
        ? parsed["warnings"]
        : [];
    const validationWarnings = [];
    const detectionWarnings = schema.dialect === "unknown"
        ? ["Schema dialect could not be confidently detected; review SQL carefully."]
        : [];
    const riskWarnings = riskResult.score >= 71
        ? [
            `[HIGH_RISK] Risk score ${riskResult.score} — detected: ${riskResult.signals.join(", ")}. Review carefully before applying.`,
        ]
        : riskResult.score >= 31
            ? [
                `[ELEVATED_RISK] Risk score ${riskResult.score} — detected: ${riskResult.signals.join(", ")}.`,
            ]
            : [];
    const fileDiffs = applyPatches.map((patch) => {
        const originalContent = originalContentByPath.get(patch.filePath) ?? "";
        const diff = (0, runLlmPatchFlow_js_1.computeFileDiff)(originalContent, patch.fullContent);
        return {
            filePath: patch.filePath,
            addedLines: diff.filter((line) => line.type === "added").length,
            removedLines: diff.filter((line) => line.type === "removed").length,
            diff,
        };
    });
    input.onProgress?.("Ready");
    return {
        ok: true,
        dialect: schema.dialect,
        migrationFormat: schema.migrationFormat,
        confidence,
        decisionMode: taskDecisionMode,
        summary,
        warnings: [...detectionWarnings, ...riskWarnings, ...warnings, ...validationWarnings],
        applyPatches,
        fileDiffs,
        preview,
    };
}
//# sourceMappingURL=runDataAnalystFlow.js.map