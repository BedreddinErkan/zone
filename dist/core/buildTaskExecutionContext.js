"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTaskKeywords = buildTaskKeywords;
exports.buildContextBlocksFromFiles = buildContextBlocksFromFiles;
exports.buildExecutionContext = buildExecutionContext;
const taskIntentParser_1 = require("./taskIntentParser");
const selectRelevantBlocks_1 = require("./selectRelevantBlocks");
const patchRiskAnalyzer_1 = require("./patchRiskAnalyzer");
const validateSuggestedArchitecture_1 = require("./validateSuggestedArchitecture");
const loadSchemaSnapshot_js_1 = require("../repo/loadSchemaSnapshot.js");
const analyzeProjectPatterns_js_1 = require("../repo/analyzeProjectPatterns.js");
const detectResourceStorage_js_1 = require("./detectResourceStorage.js");
const buildSchemaAwareContext_js_1 = require("./buildSchemaAwareContext.js");
function buildTaskKeywords(task, extra = []) {
    return Array.from(new Set(task
        .toLowerCase()
        .split(/[^a-z0-9_]+/i)
        .filter(Boolean)
        .concat(extra.filter(Boolean))));
}
function buildContextBlocksFromFiles(files, keywords) {
    return files.flatMap((file) => (0, selectRelevantBlocks_1.selectRelevantBlocks)({
        filePath: file.path,
        content: file.content,
        keywords,
        maxBlocks: 3
    }));
}
async function buildExecutionContext(input) {
    const intent = (0, taskIntentParser_1.parseTaskIntent)(input.task);
    const keywords = buildTaskKeywords(input.task, [
        intent.parentResource ?? "",
        intent.nestedResource ?? "",
        ...intent.paramHints
    ]);
    const contextBlocks = buildContextBlocksFromFiles(input.candidateFiles, keywords);
    const architectureValidation = (0, validateSuggestedArchitecture_1.validateSuggestedArchitecture)(intent, input.suggestedFiles);
    const patchRisk = input.patchPreview
        ? (0, patchRiskAnalyzer_1.analyzePatchRisk)(intent, input.patchPreview)
        : { warnings: [], isHighRisk: false };
    const schemaSnapshot = await (0, loadSchemaSnapshot_js_1.loadSchemaSnapshot)(input.projectRoot);
    const projectPatternAnalysis = (0, analyzeProjectPatterns_js_1.analyzeProjectPatterns)(input.candidateFiles);
    const resourceStorageInsight = intent.parentResource
        ? (0, detectResourceStorage_js_1.detectResourceStorage)({
            parentResource: intent.parentResource,
            nestedResource: intent.nestedResource,
            files: input.candidateFiles,
            schema: schemaSnapshot
        })
        : null;
    const schemaAwareContext = (0, buildSchemaAwareContext_js_1.buildSchemaAwareContext)({
        intent,
        schema: schemaSnapshot,
        projectPatterns: projectPatternAnalysis,
        storageInsight: resourceStorageInsight
    });
    return {
        intent,
        keywords,
        contextBlocks,
        architectureWarnings: architectureValidation.warnings,
        patchRiskWarnings: patchRisk.warnings,
        isHighRisk: patchRisk.isHighRisk,
        schemaSnapshot,
        projectPatternAnalysis,
        resourceStorageInsight,
        schemaAwareSummary: schemaAwareContext.summaryLines
    };
}
//# sourceMappingURL=buildTaskExecutionContext.js.map