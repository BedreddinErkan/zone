"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeConfidenceBreakdown = computeConfidenceBreakdown;
exports.decideExecutionMode = decideExecutionMode;
exports.runFeatureAgent = runFeatureAgent;
const scanRepo_js_1 = require("../repo/scanRepo.js");
const detectProjectStructure_js_1 = require("../repo/detectProjectStructure.js");
const rankRelevantFiles_js_1 = require("../repo/rankRelevantFiles.js");
const readProjectFiles_js_1 = require("../repo/readProjectFiles.js");
const validateSuggestedFiles_js_1 = require("../repo/validateSuggestedFiles.js");
const loadSchemaSnapshot_js_1 = require("../repo/loadSchemaSnapshot.js");
const analyzeProjectPatterns_js_1 = require("../repo/analyzeProjectPatterns.js");
const planFeature_js_1 = require("../llm/planFeature.js");
const planPatchPreview_js_1 = require("../llm/planPatchPreview.js");
const buildFallbackPlan_js_1 = require("./buildFallbackPlan.js");
const buildFallbackPatchPlan_js_1 = require("./buildFallbackPatchPlan.js");
const applyPatchPlan_js_1 = require("../patch/applyPatchPlan.js");
const saveAgentResult_js_1 = require("./saveAgentResult.js");
const taskIntentParser_js_1 = require("./taskIntentParser.js");
const patchRiskAnalyzer_js_1 = require("./patchRiskAnalyzer.js");
const validateSuggestedArchitecture_js_1 = require("./validateSuggestedArchitecture.js");
const detectResourceStorage_js_1 = require("./detectResourceStorage.js");
const buildSchemaAwareContext_js_1 = require("./buildSchemaAwareContext.js");
const validatePatchAgainstSchema_js_1 = require("./validatePatchAgainstSchema.js");
const validatePatchPlan_js_1 = require("../patch/validatePatchPlan.js");
const logger_js_1 = require("../utils/logger.js");
const normalizeIssues_js_1 = require("./normalizeIssues.js");
const CONFIDENCE_WEIGHTS = {
    intentClarity: 0.24,
    schemaCertainty: 0.23,
    storageCertainty: 0.18,
    patchValidationHealth: 0.35
};
const CONFIDENCE_THRESHOLDS = {
    high: 85,
    medium: 60,
    previewMinimum: 70,
    safeToApplyMinimum: 85
};
const PENALTY_RULES = {
    intentWarningEach: 4,
    intentWarningCap: 12,
    patchWarningEach: 3,
    patchWarningCap: 12,
    schemaWarningEach: 3,
    schemaWarningCap: 12,
    patchRiskWarningEach: 6,
    patchRiskWarningCap: 24,
    architectureWarningEach: 5,
    architectureWarningCap: 20,
    validatedMissingFileEach: 7,
    validatedMissingFileCap: 21,
    lowSchemaConfidence: 12,
    lowStorageConfidence: 12,
    bothLowConfidenceExtra: 8
};
const HEALTH_PENALTIES = {
    patchError: 45,
    schemaError: 40,
    patchWarning: 14,
    schemaWarning: 12
};
const CHANGED_FILE_SCORE_BOOST = 25;
function hasResolvedPath(file) {
    return typeof file.resolvedPath === "string" && file.resolvedPath.length > 0;
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function mapConfidenceLevel(score) {
    if (score >= CONFIDENCE_THRESHOLDS.high)
        return "high";
    if (score >= CONFIDENCE_THRESHOLDS.medium)
        return "medium";
    return "low";
}
function uniqueStrings(values = []) {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
function sumCappedPenalty(count, each, cap) {
    return Math.min(count * each, cap);
}
function normalizeRepoPath(filePath) {
    return filePath.replace(/\\/g, "/").trim();
}
function boostRelevantFilesWithChangedFiles(relevantFiles, changedFiles = []) {
    if (changedFiles.length === 0) {
        return relevantFiles;
    }
    const changedSet = new Set(changedFiles.map(normalizeRepoPath));
    return [...relevantFiles]
        .map((file) => {
        const normalizedPath = normalizeRepoPath(file.path);
        const isChanged = changedSet.has(normalizedPath);
        return {
            ...file,
            score: isChanged ? file.score + CHANGED_FILE_SCORE_BOOST : file.score
        };
    })
        .sort((a, b) => b.score - a.score);
}
function buildPenaltyItem(input) {
    if (input.appliedPenalty <= 0) {
        return null;
    }
    return {
        code: input.code,
        label: input.label,
        count: input.count,
        perItem: input.perItem,
        cap: input.cap,
        appliedPenalty: input.appliedPenalty
    };
}
function buildSchemaAwareSummaryFromContext(input) {
    const entities = [];
    if (input.intent.parentResource) {
        entities.push(input.intent.parentResource);
    }
    if (input.intent.nestedResource) {
        entities.push(input.intent.nestedResource);
    }
    const uniqueEntities = [...new Set(entities)];
    const summaryLines = input.schemaAwareContext.summaryLines ?? [];
    const confidence = input.schemaSnapshot && summaryLines.length > 0
        ? "high"
        : summaryLines.length > 0
            ? "medium"
            : "low";
    return {
        summary: summaryLines.join(" ").trim() ||
            "Schema-aware analysis could not extract strong structured signals.",
        entities: uniqueEntities,
        relations: [],
        confidence
    };
}
function scoreIntentClarity(intent) {
    let score = 25;
    if (intent.action)
        score += 20;
    if (intent.resourceKind)
        score += 15;
    if (intent.scope)
        score += 10;
    if (intent.parentResource)
        score += 10;
    if (intent.nestedResource)
        score += 5;
    if (intent.warnings.length > 0) {
        score -= sumCappedPenalty(intent.warnings.length, PENALTY_RULES.intentWarningEach, PENALTY_RULES.intentWarningCap);
    }
    return clamp(score, 0, 100);
}
function scoreSchemaCertainty(confidence) {
    if (confidence === "high")
        return 88;
    if (confidence === "medium")
        return 58;
    return 20;
}
function scoreStorageCertainty(confidence) {
    if (confidence === "high")
        return 85;
    if (confidence === "medium")
        return 55;
    return 18;
}
function scorePatchValidationHealth(patchIssues, schemaIssues) {
    let score = 100;
    const patchErrors = patchIssues.filter((item) => item.severity === "error").length;
    const patchWarnings = patchIssues.filter((item) => item.severity === "warning").length;
    const schemaErrors = schemaIssues.filter((item) => item.severity === "error").length;
    const schemaWarnings = schemaIssues.filter((item) => item.severity === "warning").length;
    score -= patchErrors * HEALTH_PENALTIES.patchError;
    score -= schemaErrors * HEALTH_PENALTIES.schemaError;
    score -= patchWarnings * HEALTH_PENALTIES.patchWarning;
    score -= schemaWarnings * HEALTH_PENALTIES.schemaWarning;
    return clamp(score, 0, 100);
}
function buildConfidenceDetails(input) {
    const penalties = [];
    const patchRiskWarnings = uniqueStrings(input.patchRiskWarnings);
    const architectureWarnings = uniqueStrings(input.architectureWarnings);
    const validatedMissingFileCount = input.validatedSuggestedFiles.filter((file) => file.status === "missing").length;
    const patchWarningCount = input.patchValidationIssues.filter((item) => item.severity === "warning").length;
    const schemaWarningCount = input.schemaPatchWarnings.filter((item) => item.severity === "warning").length;
    const intentPenalty = sumCappedPenalty(input.intent.warnings.length, PENALTY_RULES.intentWarningEach, PENALTY_RULES.intentWarningCap);
    const patchPenalty = sumCappedPenalty(patchWarningCount, PENALTY_RULES.patchWarningEach, PENALTY_RULES.patchWarningCap);
    const schemaPenalty = sumCappedPenalty(schemaWarningCount, PENALTY_RULES.schemaWarningEach, PENALTY_RULES.schemaWarningCap);
    const patchRiskPenalty = sumCappedPenalty(patchRiskWarnings.length, PENALTY_RULES.patchRiskWarningEach, PENALTY_RULES.patchRiskWarningCap);
    const architecturePenalty = sumCappedPenalty(architectureWarnings.length, PENALTY_RULES.architectureWarningEach, PENALTY_RULES.architectureWarningCap);
    const missingFilePenalty = sumCappedPenalty(validatedMissingFileCount, PENALTY_RULES.validatedMissingFileEach, PENALTY_RULES.validatedMissingFileCap);
    const lowSchemaPenalty = input.schemaConfidence === "low" ? PENALTY_RULES.lowSchemaConfidence : 0;
    const lowStoragePenalty = input.storageConfidence === "low" ? PENALTY_RULES.lowStorageConfidence : 0;
    const bothLowPenalty = input.schemaConfidence === "low" && input.storageConfidence === "low"
        ? PENALTY_RULES.bothLowConfidenceExtra
        : 0;
    const maybeItems = [
        buildPenaltyItem({
            code: "INTENT_WARNINGS",
            label: "Intent warnings",
            count: input.intent.warnings.length,
            perItem: PENALTY_RULES.intentWarningEach,
            cap: PENALTY_RULES.intentWarningCap,
            appliedPenalty: intentPenalty
        }),
        buildPenaltyItem({
            code: "PATCH_WARNINGS",
            label: "Patch validation warnings",
            count: patchWarningCount,
            perItem: PENALTY_RULES.patchWarningEach,
            cap: PENALTY_RULES.patchWarningCap,
            appliedPenalty: patchPenalty
        }),
        buildPenaltyItem({
            code: "SCHEMA_WARNINGS",
            label: "Schema validation warnings",
            count: schemaWarningCount,
            perItem: PENALTY_RULES.schemaWarningEach,
            cap: PENALTY_RULES.schemaWarningCap,
            appliedPenalty: schemaPenalty
        }),
        buildPenaltyItem({
            code: "PATCH_RISK_WARNINGS",
            label: "Patch risk warnings",
            count: patchRiskWarnings.length,
            perItem: PENALTY_RULES.patchRiskWarningEach,
            cap: PENALTY_RULES.patchRiskWarningCap,
            appliedPenalty: patchRiskPenalty
        }),
        buildPenaltyItem({
            code: "ARCHITECTURE_WARNINGS",
            label: "Architecture warnings",
            count: architectureWarnings.length,
            perItem: PENALTY_RULES.architectureWarningEach,
            cap: PENALTY_RULES.architectureWarningCap,
            appliedPenalty: architecturePenalty
        }),
        buildPenaltyItem({
            code: "MISSING_VALIDATED_FILES",
            label: "Missing validated suggested files",
            count: validatedMissingFileCount,
            perItem: PENALTY_RULES.validatedMissingFileEach,
            cap: PENALTY_RULES.validatedMissingFileCap,
            appliedPenalty: missingFilePenalty
        }),
        buildPenaltyItem({
            code: "LOW_SCHEMA_CONFIDENCE",
            label: "Low schema confidence",
            appliedPenalty: lowSchemaPenalty
        }),
        buildPenaltyItem({
            code: "LOW_STORAGE_CONFIDENCE",
            label: "Low storage confidence",
            appliedPenalty: lowStoragePenalty
        }),
        buildPenaltyItem({
            code: "BOTH_LOW_CONFIDENCE",
            label: "Schema and storage both low confidence",
            appliedPenalty: bothLowPenalty
        })
    ];
    for (const item of maybeItems) {
        if (item)
            penalties.push(item);
    }
    const totalPenalty = penalties.reduce((sum, item) => sum + item.appliedPenalty, 0);
    return {
        baseWeightedScore: Math.round(input.baseWeightedScore * 100) / 100,
        totalPenalty,
        penalties
    };
}
function computeConfidenceBreakdown(input) {
    const intentClarity = scoreIntentClarity(input.intent);
    const schemaCertainty = scoreSchemaCertainty(input.schemaConfidence);
    const storageCertainty = scoreStorageCertainty(input.storageConfidence);
    const patchValidationHealth = scorePatchValidationHealth(input.patchValidationIssues, input.schemaPatchWarnings);
    const baseWeightedScore = intentClarity * CONFIDENCE_WEIGHTS.intentClarity +
        schemaCertainty * CONFIDENCE_WEIGHTS.schemaCertainty +
        storageCertainty * CONFIDENCE_WEIGHTS.storageCertainty +
        patchValidationHealth * CONFIDENCE_WEIGHTS.patchValidationHealth;
    const confidenceDetails = buildConfidenceDetails({
        baseWeightedScore,
        intent: input.intent,
        patchValidationIssues: input.patchValidationIssues,
        schemaPatchWarnings: input.schemaPatchWarnings,
        patchRiskWarnings: input.patchRiskWarnings,
        architectureWarnings: input.architectureWarnings,
        validatedSuggestedFiles: input.validatedSuggestedFiles,
        schemaConfidence: input.schemaConfidence,
        storageConfidence: input.storageConfidence
    });
    const finalScore = clamp(Math.round(baseWeightedScore - confidenceDetails.totalPenalty), 0, 100);
    return {
        confidence: {
            intentClarity,
            schemaCertainty,
            storageCertainty,
            patchValidationHealth,
            finalScore
        },
        confidenceDetails
    };
}
function decideExecutionMode(input) {
    const patchRiskWarnings = uniqueStrings(input.patchRiskWarnings);
    const architectureWarnings = uniqueStrings(input.architectureWarnings);
    const hasMissingValidatedFile = input.validatedSuggestedFiles.some((file) => file.status === "missing");
    const hasPatchError = input.patchValidationIssues.some((item) => item.severity === "error");
    const hasSchemaError = input.schemaPatchWarnings.some((item) => item.severity === "error");
    const hasWarnings = input.patchValidationIssues.some((item) => item.severity === "warning") ||
        input.schemaPatchWarnings.some((item) => item.severity === "warning") ||
        patchRiskWarnings.length > 0 ||
        architectureWarnings.length > 0 ||
        hasMissingValidatedFile;
    if (hasPatchError || hasSchemaError) {
        return {
            mode: "blocked",
            confidenceScore: input.confidence.finalScore,
            reason: "Blocking validation errors were detected."
        };
    }
    if (input.confidence.finalScore < CONFIDENCE_THRESHOLDS.previewMinimum) {
        return {
            mode: "preview_only",
            confidenceScore: input.confidence.finalScore,
            reason: "Confidence is below the minimum threshold for safe apply."
        };
    }
    if (hasMissingValidatedFile) {
        return {
            mode: "preview_only",
            confidenceScore: input.confidence.finalScore,
            reason: "Some suggested files could not be validated confidently."
        };
    }
    if (input.schemaConfidence === "low" || input.storageConfidence === "low") {
        return {
            mode: "preview_only",
            confidenceScore: input.confidence.finalScore,
            reason: "Schema or storage certainty is too low for automatic apply."
        };
    }
    if (patchRiskWarnings.length > 0 || architectureWarnings.length > 0) {
        return {
            mode: "preview_only",
            confidenceScore: input.confidence.finalScore,
            reason: "Risk or architecture warnings require manual review."
        };
    }
    if (hasWarnings) {
        return {
            mode: "preview_only",
            confidenceScore: input.confidence.finalScore,
            reason: "Non-blocking warnings detected. Manual review is required."
        };
    }
    if (input.confidence.finalScore < CONFIDENCE_THRESHOLDS.safeToApplyMinimum) {
        return {
            mode: "preview_only",
            confidenceScore: input.confidence.finalScore,
            reason: "Only highly confident clean runs are allowed to apply."
        };
    }
    return {
        mode: "safe_to_apply",
        confidenceScore: input.confidence.finalScore,
        reason: "Validation passed cleanly with high confidence."
    };
}
function buildExecutionNotes(input) {
    const missingFiles = input.validatedSuggestedFiles
        .filter((file) => file.status === "missing")
        .map((file) => file.originalPath);
    const notes = uniqueStrings([
        ...input.patchRiskWarnings,
        ...input.architectureWarnings,
        ...missingFiles.map((filePath) => `Suggested file could not be validated: ${filePath}`)
    ]);
    const assumptions = [];
    const followUps = [];
    if (input.schemaConfidence === "low") {
        assumptions.push("Schema-aware reasoning was based on limited schema evidence.");
    }
    if (input.storageConfidence === "low") {
        assumptions.push("Storage detection was inferred with limited confidence.");
    }
    if (input.decision.mode === "preview_only") {
        followUps.push("Review the patch preview before applying changes.");
        followUps.push("Do not auto-apply until warnings and uncertainties are resolved.");
    }
    if (input.decision.mode === "blocked") {
        followUps.push("Resolve validation errors and rerun the agent.");
    }
    if (input.patchRiskWarnings.length > 0) {
        followUps.push("Verify multi-tenant safety and resource scoping manually.");
    }
    if (missingFiles.length > 0) {
        followUps.push("Review unresolved or missing suggested files manually.");
    }
    return {
        notes,
        assumptions: uniqueStrings(assumptions),
        followUps: uniqueStrings(followUps)
    };
}
function logIssueSummary(label, issues) {
    if (issues.length === 0)
        return;
    const errorCount = issues.filter((issue) => issue.severity === "error").length;
    const warningCount = issues.filter((issue) => issue.severity === "warning").length;
    (0, logger_js_1.logWarn)(`${label}: ${errorCount} error(s), ${warningCount} warning(s)`);
    const preview = issues.slice(0, 3);
    for (const issue of preview) {
        (0, logger_js_1.logWarn)(`- ${issue.message}${issue.file ? ` [${issue.file}]` : ""}`);
    }
    if (issues.length > preview.length) {
        (0, logger_js_1.logWarn)(`- ...and ${issues.length - preview.length} more`);
    }
}
function buildStorageInsight(input) {
    if (!input.resourceStorageInsight) {
        return {
            primaryStorage: "unknown",
            detectedClients: [],
            reasoning: ["No storage insight could be inferred from the current context."],
            confidence: "low"
        };
    }
    const { storageKind, evidence } = input.resourceStorageInsight;
    return {
        primaryStorage: input.schemaSnapshot ? "postgres" : "unknown",
        resourceStorageKind: storageKind,
        detectedClients: [],
        reasoning: [...evidence, `Detected resource storage kind: ${storageKind}`],
        confidence: storageKind === "unknown"
            ? "low"
            : evidence.length >= 2
                ? "high"
                : "medium"
    };
}
async function runFeatureAgent(input) {
    const mode = input.mode ?? "preview";
    (0, logger_js_1.logInfo)(`Scanning target project: ${input.targetPath}`);
    const allFiles = await (0, scanRepo_js_1.scanRepo)(input.targetPath);
    const structure = (0, detectProjectStructure_js_1.detectProjectStructure)(allFiles);
    const intent = (0, taskIntentParser_js_1.parseTaskIntent)(input.task);
    const rankedFiles = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
        task: input.task,
        files: allFiles,
        projectStructure: structure,
        intent
    });
    const relevantFiles = boostRelevantFilesWithChangedFiles(rankedFiles, input.changedFiles ?? []);
    if ((input.changedFiles ?? []).length > 0) {
        (0, logger_js_1.logInfo)(`Diff-aware mode enabled: ${input.changedFiles?.length ?? 0} changed file(s) boosted.`);
    }
    const summary = [
        `Task: ${input.task}`,
        `Mode: ${mode}`,
        `Intent action: ${intent.action}`,
        `Intent resource kind: ${intent.resourceKind}`,
        `Intent scope: ${intent.scope}`,
        `Parent resource: ${intent.parentResource ?? "unknown"}`,
        `Nested resource: ${intent.nestedResource ?? "unknown"}`,
        ...intent.warnings.map((warning) => `Intent warning: ${warning}`),
        `Total scanned files: ${allFiles.length}`,
        `Relevant files found: ${relevantFiles.length}`,
        `React app detected: ${structure.isReactApp ? "yes" : "no"}`,
        `Express app detected: ${structure.isExpressApp ? "yes" : "no"}`
    ].join("\n");
    const schemaSnapshot = await (0, loadSchemaSnapshot_js_1.loadSchemaSnapshot)(input.targetPath);
    const analysisFilePaths = relevantFiles.slice(0, 12).map((file) => file.absolutePath);
    const analysisFileContentsMap = await (0, readProjectFiles_js_1.readProjectFiles)(analysisFilePaths);
    const analysisFiles = Object.entries(analysisFileContentsMap).map(([absolutePath, content]) => {
        const repoFile = allFiles.find((file) => file.absolutePath === absolutePath);
        return {
            path: repoFile?.path ?? absolutePath,
            content
        };
    });
    const projectPatternAnalysis = (0, analyzeProjectPatterns_js_1.analyzeProjectPatterns)(analysisFiles);
    const resourceStorageInsight = intent.parentResource
        ? (0, detectResourceStorage_js_1.detectResourceStorage)({
            parentResource: intent.parentResource,
            nestedResource: intent.nestedResource,
            files: analysisFiles,
            schema: schemaSnapshot
        })
        : null;
    const schemaAwareContext = (0, buildSchemaAwareContext_js_1.buildSchemaAwareContext)({
        intent,
        schema: schemaSnapshot,
        projectPatterns: projectPatternAnalysis,
        storageInsight: resourceStorageInsight
    });
    let llmPlan;
    try {
        (0, logger_js_1.logInfo)("Generating feature plan...");
        llmPlan = await (0, planFeature_js_1.planFeatureWithLlm)({
            task: input.task,
            intent,
            projectSummary: summary,
            projectNotes: [...structure.notes, ...schemaAwareContext.summaryLines],
            relevantFiles: relevantFiles.map((file) => ({
                path: file.path,
                category: file.category
            })),
            existingFilesSummary: [
                "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):",
                ...relevantFiles.slice(0, 12).map((file) => `- ${file.path}`)
            ].join("\n"),
            schemaAwareSummary: schemaAwareContext.summaryLines
        });
        (0, logger_js_1.logSuccess)("Feature plan created");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown planning error";
        (0, logger_js_1.logWarn)(`Feature planning failed, using fallback. Reason: ${message}`);
        llmPlan = (0, buildFallbackPlan_js_1.buildFallbackPlan)(input.task, relevantFiles);
    }
    const validatedSuggestedFiles = (0, validateSuggestedFiles_js_1.validateSuggestedFiles)(llmPlan.suggestedFiles, allFiles);
    const architectureValidation = (0, validateSuggestedArchitecture_js_1.validateSuggestedArchitecture)(intent, validatedSuggestedFiles.map((file) => file.resolvedPath || file.originalPath));
    if (architectureValidation.warnings.length > 0) {
        (0, logger_js_1.logWarn)(`Architecture warnings detected: ${architectureValidation.warnings.length}`);
    }
    let patchPlan;
    try {
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
        (0, logger_js_1.logInfo)("Generating patch preview...");
        patchPlan = await (0, planPatchPreview_js_1.planPatchPreviewWithLlm)({
            task: input.task,
            intent,
            projectSummary: summary,
            projectNotes: [...structure.notes, ...schemaAwareContext.summaryLines],
            suggestedFiles: validatedSuggestedFiles
                .filter(hasResolvedPath)
                .map((file) => ({
                path: file.resolvedPath,
                action: file.action,
                reason: file.reason
            })),
            fileContexts,
            schemaAwareSummary: schemaAwareContext.summaryLines
        });
        (0, logger_js_1.logSuccess)("Patch preview created");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Unknown patch planning error";
        (0, logger_js_1.logWarn)(`Patch preview generation failed, using fallback. Reason: ${message}`);
        patchPlan = (0, buildFallbackPatchPlan_js_1.buildFallbackPatchPlan)(input.task, validatedSuggestedFiles);
    }
    const patchTargetValidation = await (0, validatePatchPlan_js_1.validatePatchPlan)({
        targetPath: input.targetPath,
        patchPlan
    });
    const patchValidationIssues = (0, normalizeIssues_js_1.normalizePatchValidationIssues)(patchTargetValidation.issues);
    const patchRiskWarnings = uniqueStrings(patchPlan.patches.flatMap((patch) => (0, patchRiskAnalyzer_js_1.analyzePatchRisk)(intent, patch.contentPreview).warnings));
    const schemaPatchIssues = (0, validatePatchAgainstSchema_js_1.validatePatchAgainstSchema)(patchPlan.patches.map((patch) => ({
        path: patch.path,
        contentPreview: patch.contentPreview
    })), schemaSnapshot);
    const schemaPatchWarnings = (0, normalizeIssues_js_1.normalizeSchemaValidationIssues)(schemaPatchIssues);
    logIssueSummary("Patch validation", patchValidationIssues);
    logIssueSummary("Schema validation", schemaPatchWarnings);
    if (patchRiskWarnings.length > 0) {
        (0, logger_js_1.logWarn)(`Patch risk warnings detected: ${patchRiskWarnings.length}`);
        for (const warning of patchRiskWarnings.slice(0, 3)) {
            (0, logger_js_1.logWarn)(`- ${warning}`);
        }
        if (patchRiskWarnings.length > 3) {
            (0, logger_js_1.logWarn)(`- ...and ${patchRiskWarnings.length - 3} more`);
        }
    }
    const schemaAwareSummary = buildSchemaAwareSummaryFromContext({
        schemaAwareContext,
        schemaSnapshot,
        intent
    });
    const storageInsight = buildStorageInsight({
        schemaSnapshot,
        resourceStorageInsight
    });
    const { confidence, confidenceDetails } = computeConfidenceBreakdown({
        intent,
        schemaConfidence: schemaAwareSummary.confidence,
        storageConfidence: storageInsight.confidence,
        patchValidationIssues,
        schemaPatchWarnings,
        patchRiskWarnings,
        architectureWarnings: architectureValidation.warnings,
        validatedSuggestedFiles
    });
    const decision = decideExecutionMode({
        confidence,
        patchValidationIssues,
        schemaPatchWarnings,
        patchRiskWarnings,
        architectureWarnings: architectureValidation.warnings,
        validatedSuggestedFiles,
        schemaConfidence: schemaAwareSummary.confidence,
        storageConfidence: storageInsight.confidence
    });
    const executionNotes = buildExecutionNotes({
        schemaConfidence: schemaAwareSummary.confidence,
        storageConfidence: storageInsight.confidence,
        patchRiskWarnings,
        architectureWarnings: architectureValidation.warnings,
        validatedSuggestedFiles,
        decision
    });
    const finalSummary = [
        `Task: ${input.task}`,
        `Mode: ${mode}`,
        `Intent action: ${intent.action}`,
        `Intent resource kind: ${intent.resourceKind}`,
        `Intent scope: ${intent.scope}`,
        `Parent resource: ${intent.parentResource ?? "unknown"}`,
        `Nested resource: ${intent.nestedResource ?? "unknown"}`,
        `Relevant files found: ${relevantFiles.length}`,
        `Confidence score: ${confidence.finalScore}/100 (${mapConfidenceLevel(confidence.finalScore)})`,
        `Decision: ${decision.mode}`
    ].join("\n");
    const result = {
        task: input.task,
        targetPath: input.targetPath,
        structure,
        allFiles,
        relevantFiles,
        summary: finalSummary,
        llmPlan,
        validatedSuggestedFiles,
        patchPlan,
        intent,
        architectureWarnings: architectureValidation.warnings,
        patchRiskWarnings,
        schemaAwareSummary,
        storageInsight,
        patchValidationIssues,
        schemaPatchWarnings,
        executionNotes,
        confidence,
        confidenceDetails,
        decision
    };
    if (mode === "dry-run" || mode === "apply") {
        if (decision.mode !== "safe_to_apply") {
            (0, logger_js_1.logWarn)(`Patch execution skipped because decision mode is ${decision.mode}. Only safe_to_apply may execute patches.`);
        }
        else {
            (0, logger_js_1.logInfo)(`Executing patch plan in ${mode} mode...`);
            result.applyResults = await (0, applyPatchPlan_js_1.applyPatchPlan)({
                targetPath: input.targetPath,
                patchPlan,
                mode
            });
            (0, logger_js_1.logSuccess)(`Patch execution finished in ${mode} mode`);
        }
    }
    const cachePath = await (0, saveAgentResult_js_1.saveAgentResult)(result);
    (0, logger_js_1.logInfo)(`Saved agent result: ${cachePath}`);
    (0, logger_js_1.logInfo)(`Run completed with decision=${decision.mode}, confidence=${confidence.finalScore}/100`);
    return result;
}
//# sourceMappingURL=runFeatureAgent.js.map