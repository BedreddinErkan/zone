"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runTestEngineerFlow = runTestEngineerFlow;
const scanRepo_js_1 = require("../repo/scanRepo.js");
const readProjectFiles_js_1 = require("../repo/readProjectFiles.js");
const detectTestFramework_js_1 = require("./detectTestFramework.js");
const testEngineerContext_js_1 = require("./testEngineerContext.js");
const testEngineerPrompt_js_1 = require("../prompts/testEngineerPrompt.js");
const openaiClient_js_1 = require("../llm/openaiClient.js");
const confidenceGate_js_1 = require("../core/confidenceGate.js");
const testOutputValidator_js_1 = require("./testOutputValidator.js");
const detectTestComplexity_js_1 = require("./detectTestComplexity.js");
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
function buildPreview(result, framework) {
    const lines = ["=== TEST ENGINEER PREVIEW ==="];
    lines.push(`Framework: ${framework}`);
    lines.push(`Summary: ${result["summary"]}`);
    const warnings = result["warnings"];
    if (warnings?.length > 0) {
        lines.push("");
        lines.push("Warnings:");
        warnings.forEach((warning) => lines.push(`- ${warning}`));
    }
    lines.push("");
    lines.push("Files to create:");
    if (result["testFile"]) {
        const file = result["testFile"];
        lines.push(`- ${file.path}`);
    }
    if (result["featureFile"]) {
        const file = result["featureFile"];
        lines.push(`- ${file.path} [feature]`);
    }
    if (result["stepDefinitionFile"]) {
        const file = result["stepDefinitionFile"];
        lines.push(`- ${file.path} [step definitions]`);
    }
    return lines.join("\n");
}
function buildApplyPatches(result) {
    const patches = [];
    if (result["testFile"]) {
        const file = result["testFile"];
        if (file.path && file.content) {
            patches.push({ filePath: file.path, fullContent: file.content });
        }
    }
    if (result["featureFile"]) {
        const file = result["featureFile"];
        if (file.path && file.content) {
            patches.push({ filePath: file.path, fullContent: file.content });
        }
    }
    if (result["stepDefinitionFile"]) {
        const file = result["stepDefinitionFile"];
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
function scoreFeatureExampleContent(content) {
    let score = 0;
    if (content.includes("Scenario Outline"))
        score += 4;
    if (content.includes("Examples:"))
        score += 4;
    if (/^\s*@/m.test(content))
        score += 1;
    return score;
}
function isPreferredCucumberFeaturePath(path) {
    return path.startsWith("src/test/resources/features/");
}
async function readFeatureExampleContents(files, allFiles, framework) {
    if (framework.framework !== "cucumber_java") {
        return readExampleContents(files, allFiles, 2);
    }
    const inspectedExamples = await readExampleContents(files, allFiles, 4);
    return [...inspectedExamples]
        .sort((a, b) => {
        const scoreDiff = scoreFeatureExampleContent(b.content) - scoreFeatureExampleContent(a.content);
        if (scoreDiff !== 0)
            return scoreDiff;
        const preferredPathDiff = Number(isPreferredCucumberFeaturePath(b.path)) -
            Number(isPreferredCucumberFeaturePath(a.path));
        if (preferredPathDiff !== 0)
            return preferredPathDiff;
        return a.path.localeCompare(b.path);
    })
        .slice(0, 2);
}
async function runTestEngineerFlow(input) {
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
    let framework;
    try {
        input.onProgress?.("Detecting framework...");
        framework = (0, detectTestFramework_js_1.detectTestFramework)(allFiles);
    }
    catch (err) {
        return {
            ok: false,
            reason: `detectTestFramework failed: ${err instanceof Error ? err.stack : String(err)}`,
        };
    }
    if (framework.framework === "unknown") {
        return {
            ok: false,
            reason: "Could not detect a test framework in this repository. " +
                "Supported frameworks: Playwright (TS/JS), Cypress, Cucumber+Java, " +
                "Selenium (Java/Python), TestNG, pytest.",
            framework: "unknown",
        };
    }
    let context;
    try {
        context = (0, testEngineerContext_js_1.buildTestEngineerContext)(input.task, framework, allFiles);
    }
    catch (err) {
        return {
            ok: false,
            reason: `buildTestEngineerContext failed: ${err instanceof Error ? err.stack : String(err)}`,
        };
    }
    const pageObjectContents = await readExampleContents(context.pageObjectFiles, allFiles, 3);
    const stepDefinitionContents = await readExampleContents(context.stepDefinitionFiles, allFiles, 2);
    const featureContents = await readFeatureExampleContents(context.featureFiles, allFiles, framework);
    const existingTestContents = await readExampleContents(context.existingTestFiles, allFiles, 3);
    input.onProgress?.("Building prompt...");
    const prompt = (0, testEngineerPrompt_js_1.buildTestEngineerPrompt)({
        task: input.task,
        context,
        pageObjectContents,
        stepDefinitionContents,
        featureContents,
        existingTestContents,
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
            framework: framework.framework,
        };
    }
    const applyPatches = buildApplyPatches(parsed);
    const preview = buildPreview(parsed, framework.framework);
    const confidence = typeof parsed["confidence"] === "number" ? parsed["confidence"] : 50;
    const summary = typeof parsed["summary"] === "string"
        ? parsed["summary"]
        : "Test generated successfully.";
    const warnings = Array.isArray(parsed["warnings"])
        ? parsed["warnings"]
        : [];
    const confidenceGate = (0, confidenceGate_js_1.checkConfidenceGate)({
        confidenceScore: confidence,
        role: "test_engineer",
        framework: framework.framework,
        warnings,
    });
    if (!confidenceGate.pass && applyPatches.length > 0) {
        const exportErrors = applyPatches.filter((patch) => patch.fullContent.includes("export default new "));
        for (const patch of exportErrors) {
            patch.fullContent = patch.fullContent.replace(/export default new (\w+)\(\)/g, "export default $1");
        }
    }
    // 9. Validate output
    const featurePatch = applyPatches.find(p => p.filePath.endsWith(".feature"));
    const stepPatch = applyPatches.find(p => p.filePath.endsWith(".java"));
    const testFilePatch = applyPatches.find(p => p.filePath.endsWith(".spec.ts") ||
        p.filePath.endsWith(".spec.js") ||
        p.filePath.endsWith(".test.ts") ||
        p.filePath.endsWith(".test.js") ||
        p.filePath.endsWith(".cy.ts") ||
        p.filePath.endsWith(".cy.js") ||
        p.filePath.endsWith(".py"));
    const { complexity } = (0, detectTestComplexity_js_1.detectTestComplexity)(input.task);
    input.onProgress?.("Validating output...");
    const validation = (0, testOutputValidator_js_1.validateTestOutput)({
        featureContent: featurePatch?.fullContent,
        stepDefinitionContent: stepPatch?.fullContent,
        testFileContent: testFilePatch?.fullContent,
        pageObjectContents: pageObjectContents,
        framework: framework.framework,
        complexityHint: complexity,
    });
    if (validation.decision !== "pass" || validation.issues.length > 0) {
        console.log(`[zone:validate] Decision: ${validation.decision}`);
        for (const issue of validation.issues) {
            console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
        }
    }
    if (validation.decision === "blocked") {
        return {
            ok: false,
            reason: `Output validation blocked: ${validation.summary}\n` +
                validation.issues
                    .filter(i => i.severity === "error")
                    .map(i => `  - ${i.message}`)
                    .join("\n"),
            framework: framework.framework,
        };
    }
    const validationWarnings = validation.issues
        .filter(i => i.severity === "warning")
        .map(i => `[${i.code}] ${i.message}`);
    input.onProgress?.("Ready");
    return {
        ok: true,
        framework: framework.framework,
        language: framework.language,
        confidence,
        summary,
        warnings: [...warnings, ...validationWarnings],
        complexity,
        applyPatches,
        preview,
    };
}
//# sourceMappingURL=runTestEngineerFlow.js.map