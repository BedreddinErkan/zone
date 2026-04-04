"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDataAnalystFlow = runDataAnalystFlow;
const scanRepo_js_1 = require("../repo/scanRepo.js");
const readProjectFiles_js_1 = require("../repo/readProjectFiles.js");
const openaiClient_js_1 = require("../llm/openaiClient.js");
const testOutputValidator_js_1 = require("./testOutputValidator.js");
const dataAnalystContext_js_1 = require("./dataAnalystContext.js");
const detectDataSchema_js_1 = require("./detectDataSchema.js");
function extractJson(rawText) {
    const trimmed = rawText.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}"))
        return trimmed;
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return trimmed.slice(firstBrace, lastBrace + 1);
    }
    throw new Error("No JSON found in model response");
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
function buildDataAnalystPrompt(input) {
    const sqlSection = input.existingSqlContents.length > 0
        ? input.existingSqlContents
            .map((file) => `FILE: ${file.path}\n\`\`\`sql\n${file.content}\n\`\`\``)
            .join("\n\n")
        : "(no existing SQL examples found)";
    const rulesSection = input.context.outputRules.map((rule) => `- ${rule}`).join("\n");
    return `
You are a senior database engineer.

Your job is to write a complete, runnable SQL migration for the given task.
You must follow the exact SQL dialect, migration format, and schema conventions detected in this repository.

=== TASK ===
${input.task}

=== DETECTED SCHEMA ===
${input.context.schemaSummary}

=== OUTPUT RULES ===
${rulesSection}

=== EXISTING SQL EXAMPLES ===
${sqlSection}

=== OUTPUT REQUIREMENTS ===
Migration file: ${input.context.outputPaths.migrationFile}

=== CRITICAL RULES ===
1. Never use DROP TABLE, TRUNCATE, or DELETE without a WHERE clause.
2. Always use IF NOT EXISTS when creating tables.
3. Use snake_case for all table and column names.
4. Write real SQL only. Do not use placeholder table names or column names.
5. Reuse existing naming patterns and schema conventions when examples are provided.
6. If the task implies a conflicting table name, add the risk to warnings instead of inventing a conflicting schema.
7. Return raw JSON only - no markdown, no code fences, no explanations.
- confidence: integer 0-100, your honest assessment of how well the generated SQL matches the task and follows repository conventions. 
  Use 90+ if dialect is known and examples exist, 70-89 if dialect is known but no examples, 50-69 if dialect is unknown.

=== OUTPUT FORMAT ===
Return JSON only:
{
  "migrationFile": {
    "path": "${input.context.outputPaths.migrationFile}",
    "content": "full SQL content"
  },
  "summary": "what this migration does",
  "warnings": [],
"confidence": 85}
`.trim();
}
async function runDataAnalystFlow(input) {
    let allFiles;
    try {
        input.onProgress?.("Scanning repo...");
        allFiles = await (0, scanRepo_js_1.scanRepo)(input.repoPath);
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
        schema = (0, detectDataSchema_js_1.detectDataSchema)(allFiles);
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
    const existingSqlContents = await readExampleContents(context.existingSqlFiles, allFiles, 3);
    input.onProgress?.("Building prompt...");
    const prompt = buildDataAnalystPrompt({
        task: input.task,
        context,
        existingSqlContents,
    });
    let parsed;
    try {
        input.onProgress?.("Generating patch...");
        const client = (0, openaiClient_js_1.createOpenAIClient)();
        const model = (0, openaiClient_js_1.getModelName)();
        const response = await client.responses.create({ model, input: prompt });
        const rawText = response.output_text || "";
        const jsonText = extractJson(rawText);
        parsed = JSON.parse(jsonText);
    }
    catch (err) {
        return {
            ok: false,
            reason: `LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
            dialect: schema.dialect,
        };
    }
    const applyPatches = buildApplyPatches(parsed);
    const preview = buildPreview(parsed, schema.dialect, schema.migrationFormat);
    const confidence = typeof parsed["confidence"] === "number" ? parsed["confidence"] : 50;
    const summary = typeof parsed["summary"] === "string"
        ? parsed["summary"]
        : "Migration generated successfully.";
    const warnings = Array.isArray(parsed["warnings"])
        ? parsed["warnings"]
        : [];
    const migrationPatch = applyPatches[0];
    input.onProgress?.("Validating output...");
    const validation = (0, testOutputValidator_js_1.validateTestOutput)({
        framework: "unknown",
        sqlContent: migrationPatch?.fullContent,
        sqlDialect: schema.dialect,
    });
    if (validation.decision === "blocked") {
        return {
            ok: false,
            reason: `SQL validation blocked: ${validation.summary}\n` +
                validation.issues
                    .filter((issue) => issue.severity === "error")
                    .map((issue) => `  - ${issue.message}`)
                    .join("\n"),
            dialect: schema.dialect,
        };
    }
    const validationWarnings = validation.issues
        .filter((issue) => issue.severity === "warning")
        .map((issue) => `[${issue.code}] ${issue.message}`);
    const detectionWarnings = schema.dialect === "unknown"
        ? ["Schema dialect could not be confidently detected; review SQL carefully."]
        : [];
    input.onProgress?.("Ready");
    return {
        ok: true,
        dialect: schema.dialect,
        migrationFormat: schema.migrationFormat,
        confidence,
        summary,
        warnings: [...detectionWarnings, ...warnings, ...validationWarnings],
        applyPatches,
        preview,
    };
}
//# sourceMappingURL=runDataAnalystFlow.js.map