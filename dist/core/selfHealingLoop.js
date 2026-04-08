"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSelfHealingLoop = runSelfHealingLoop;
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = require("node:fs");
function extractErrorContext(errorMessage) {
    // TypeError: X is not a constructor
    if (errorMessage.includes("is not a constructor")) {
        const match = errorMessage.match(/(\w+)\.default is not a constructor/);
        const className = match?.[1] ?? "Unknown";
        return {
            type: "EXPORT_ERROR",
            description: `${className} is exported as an instance, not a class`,
            hint: `Change "export default new ${className}()" to "export default ${className}"`,
        };
    }
    // TypeError: X is not a function
    if (errorMessage.includes("is not a function")) {
        const match = errorMessage.match(/(\w+\.?\w+) is not a function/);
        const fnName = match?.[1] ?? "unknown";
        return {
            type: "METHOD_ERROR",
            description: `Method "${fnName}" does not exist`,
            hint: `Check the method name in the page object — it may be named differently`,
        };
    }
    // Cannot find module
    if (errorMessage.includes("Cannot find module") ||
        errorMessage.includes("Module not found")) {
        const match = errorMessage.match(/['"]([^'"]+)['"]/);
        const modulePath = match?.[1] ?? "unknown";
        return {
            type: "IMPORT_ERROR",
            description: `Module not found: ${modulePath}`,
            hint: `Check the import path — use relative paths like "../../support/pageObjects/LoginPage"`,
        };
    }
    // Timed out
    if (errorMessage.includes("Timed out") || errorMessage.includes("timeout")) {
        return {
            type: "TIMEOUT_ERROR",
            description: "Page or element load timeout",
            hint: `Use cy.visit("/") instead of absolute URLs when baseUrl is configured`,
        };
    }
    // AssertionError
    if (errorMessage.includes("AssertionError") ||
        errorMessage.includes("expected") && errorMessage.includes("but got")) {
        return {
            type: "ASSERTION_ERROR",
            description: "Test assertion failed",
            hint: `Check the expected value — the actual value from the page may differ`,
        };
    }
    return {
        type: "UNKNOWN_ERROR",
        description: errorMessage.slice(0, 200),
        hint: "Review the error and fix the affected file",
    };
}
function buildHealingPrompt(input) {
    const relatedSection = input.relatedFiles.length > 0
        ? input.relatedFiles
            .map((f) => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
            .join("\n\n")
        : "(no related files)";
    return `
You are fixing a test automation error.

ORIGINAL TASK
${input.task}

ERROR TYPE
${input.errorContext.type}

ERROR DESCRIPTION
${input.errorContext.description}

FIX HINT
${input.errorContext.hint}

FILE TO FIX
${input.filePath}

CURRENT FILE CONTENT
\`\`\`
${input.fileContent}
\`\`\`

RELATED FILES (for reference)
${relatedSection}

STRICT RULES
1. Fix ONLY the specific error described above
2. Do not change unrelated code
3. For EXPORT_ERROR: change "export default new ClassName()" to "export default ClassName"
4. For METHOD_ERROR: use ONLY method names that exist in the related files
5. For IMPORT_ERROR: use correct relative import paths
6. For TIMEOUT_ERROR: use cy.visit("/") not absolute URLs
7. Return the COMPLETE fixed file content
8. Return raw JSON only — no markdown

OUTPUT FORMAT
{
  "filePath": "${input.filePath}",
  "fullContent": "complete fixed file content",
  "summary": "what was fixed",
  "warnings": []
}
`.trim();
}
async function runSelfHealingLoop(input) {
    const maxAttempts = input.maxAttempts ?? 3;
    const attempts = [];
    let currentError = input.errorMessage;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`[zone:heal] Attempt ${attempt}/${maxAttempts} — analyzing error...`);
        const errorContext = extractErrorContext(currentError);
        console.log(`[zone:heal] Error type: ${errorContext.type}`);
        console.log(`[zone:heal] Hint: ${errorContext.hint}`);
        const filesChanged = [];
        let anyFixed = false;
        for (const affectedFile of input.affectedFiles) {
            const absolutePath = node_path_1.default.resolve(input.repoPath, affectedFile.filePath);
            // Read related files for context
            const allFilesInDir = await getRelatedFiles(node_path_1.default.dirname(absolutePath), input.repoPath);
            const prompt = buildHealingPrompt({
                task: input.task,
                errorContext,
                filePath: affectedFile.filePath,
                fileContent: affectedFile.fullContent,
                relatedFiles: allFilesInDir,
            });
            try {
                const { createOpenAIClient, getModelName } = await import("../llm/openaiClient.js");
                const client = createOpenAIClient();
                const model = getModelName();
                const response = await client.responses.create({
                    model,
                    input: prompt,
                });
                const rawText = response.output_text || "";
                const firstBrace = rawText.indexOf("{");
                const lastBrace = rawText.lastIndexOf("}");
                if (firstBrace < 0 || lastBrace < 0)
                    continue;
                const cleaned = rawText
                    .slice(firstBrace, lastBrace + 1)
                    .replace(/^```json\s*/i, "")
                    .replace(/^```\s*/i, "")
                    .replace(/```\s*$/i, "")
                    .trim();
                const parsed = JSON.parse(cleaned);
                if (parsed.fullContent) {
                    await node_fs_1.promises.mkdir(node_path_1.default.dirname(absolutePath), { recursive: true });
                    await node_fs_1.promises.writeFile(absolutePath, parsed.fullContent, "utf8");
                    filesChanged.push(affectedFile.filePath);
                    anyFixed = true;
                    console.log(`[zone:heal] Fixed: ${affectedFile.filePath} — ${parsed.summary}`);
                }
            }
            catch (err) {
                console.error(`[zone:heal] Failed to fix ${affectedFile.filePath}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        attempts.push({
            attempt,
            error: currentError,
            fixed: anyFixed,
            filesChanged,
        });
        if (anyFixed) {
            return {
                healed: true,
                attempts,
            };
        }
    }
    return {
        healed: false,
        attempts,
        finalError: currentError,
    };
}
async function getRelatedFiles(dir, repoPath) {
    try {
        const entries = await node_fs_1.promises.readdir(dir, { withFileTypes: true });
        const jsFiles = entries
            .filter((e) => e.isFile() &&
            (e.name.endsWith(".js") ||
                e.name.endsWith(".ts") ||
                e.name.endsWith(".java")))
            .slice(0, 4);
        const results = [];
        for (const file of jsFiles) {
            const absPath = node_path_1.default.join(dir, file.name);
            const relPath = node_path_1.default.relative(repoPath, absPath).replace(/\\/g, "/");
            try {
                const content = await node_fs_1.promises.readFile(absPath, "utf8");
                results.push({ path: relPath, content });
            }
            catch {
                // skip unreadable files
            }
        }
        return results;
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=selfHealingLoop.js.map