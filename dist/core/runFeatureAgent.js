"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runFeatureAgent = runFeatureAgent;
const scanRepo_js_1 = require("../repo/scanRepo.js");
const detectProjectStructure_js_1 = require("../repo/detectProjectStructure.js");
const rankRelevantFiles_js_1 = require("../repo/rankRelevantFiles.js");
const readProjectFiles_js_1 = require("../repo/readProjectFiles.js");
const validateSuggestedFiles_js_1 = require("../repo/validateSuggestedFiles.js");
const logger_js_1 = require("../utils/logger.js");
const planFeature_js_1 = require("../llm/planFeature.js");
const planPatchPreview_js_1 = require("../llm/planPatchPreview.js");
const buildFallbackPlan_js_1 = require("./buildFallbackPlan.js");
const buildFallbackPatchPlan_js_1 = require("./buildFallbackPatchPlan.js");
function hasResolvedPath(file) {
    return typeof file.resolvedPath === "string" && file.resolvedPath.length > 0;
}
async function runFeatureAgent(input) {
    (0, logger_js_1.logInfo)(`Scanning target project: ${input.targetPath}`);
    const allFiles = await (0, scanRepo_js_1.scanRepo)(input.targetPath);
    const structure = (0, detectProjectStructure_js_1.detectProjectStructure)(allFiles);
    const relevantFiles = (0, rankRelevantFiles_js_1.rankRelevantFiles)(allFiles, input.task);
    const summary = [
        `Task: ${input.task}`,
        `Total scanned files: ${allFiles.length}`,
        `Relevant files found: ${relevantFiles.length}`,
        `React app detected: ${structure.isReactApp ? "yes" : "no"}`,
        `Express app detected: ${structure.isExpressApp ? "yes" : "no"}`
    ].join("\n");
    let llmPlan;
    try {
        (0, logger_js_1.logInfo)("Generating LLM feature plan...");
        llmPlan = await (0, planFeature_js_1.planFeatureWithLlm)({
            task: input.task,
            projectSummary: summary,
            projectNotes: structure.notes,
            relevantFiles: relevantFiles.map((file) => ({
                path: file.path,
                category: file.category
            }))
        });
        (0, logger_js_1.logSuccess)("LLM feature plan created");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown planning error";
        (0, logger_js_1.logWarn)(`LLM planning failed, using fallback plan. Reason: ${message}`);
        llmPlan = (0, buildFallbackPlan_js_1.buildFallbackPlan)(input.task, relevantFiles);
    }
    const validatedSuggestedFiles = (0, validateSuggestedFiles_js_1.validateSuggestedFiles)(llmPlan.suggestedFiles, allFiles);
    let patchPlan;
    try {
        (0, logger_js_1.logInfo)("Preparing file contexts for patch preview...");
        const filesToRead = validatedSuggestedFiles
            .filter(hasResolvedPath)
            .filter((file) => file.status !== "missing")
            .map((file) => {
            const match = allFiles.find((repoFile) => repoFile.path === file.resolvedPath);
            return match?.absolutePath;
        })
            .filter((value) => typeof value === "string")
            .slice(0, 6);
        const fileContentsMap = await (0, readProjectFiles_js_1.readProjectFiles)(filesToRead);
        const fileContexts = Object.entries(fileContentsMap).map(([absolutePath, content]) => {
            const repoFile = allFiles.find((file) => file.absolutePath === absolutePath);
            return {
                path: repoFile?.path ?? absolutePath,
                content
            };
        });
        (0, logger_js_1.logInfo)("Generating LLM patch preview...");
        patchPlan = await (0, planPatchPreview_js_1.planPatchPreviewWithLlm)({
            task: input.task,
            projectSummary: summary,
            projectNotes: structure.notes,
            suggestedFiles: validatedSuggestedFiles
                .filter(hasResolvedPath)
                .map((file) => ({
                path: file.resolvedPath,
                action: file.action,
                reason: file.reason,
                status: file.status,
                originalPath: file.status === "corrected" ? file.originalPath : undefined
            })),
            fileContexts
        });
        (0, logger_js_1.logSuccess)("LLM patch preview created");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown patch planning error";
        (0, logger_js_1.logWarn)(`Patch preview failed, using fallback patch preview. Reason: ${message}`);
        patchPlan = (0, buildFallbackPatchPlan_js_1.buildFallbackPatchPlan)(input.task, validatedSuggestedFiles);
    }
    (0, logger_js_1.logSuccess)("Feature analysis completed");
    return {
        task: input.task,
        targetPath: input.targetPath,
        structure,
        allFiles,
        relevantFiles,
        summary,
        llmPlan,
        validatedSuggestedFiles,
        patchPlan
    };
}
//# sourceMappingURL=runFeatureAgent.js.map