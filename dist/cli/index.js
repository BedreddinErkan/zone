#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAuditFlag = resolveAuditFlag;
exports.runCliWithOptions = runCliWithOptions;
exports.run = run;
const commander_1 = require("commander");
const node_path_1 = __importDefault(require("node:path"));
const node_process_1 = __importDefault(require("node:process"));
const node_fs_1 = require("node:fs");
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const classifyPatchIntent_js_1 = require("../patch-generation/classifyPatchIntent.js");
const runLlmPatchFlow_js_1 = require("../core/runLlmPatchFlow.js");
const executionTracker_js_1 = require("../utils/executionTracker.js");
const trace_js_1 = require("../utils/trace.js");
const runFeatureAgent_js_1 = require("../core/runFeatureAgent.js");
const runAgent_js_1 = require("../core/runAgent.js");
const loadSavedAgentResult_js_1 = require("../core/loadSavedAgentResult.js");
const evaluateCiResult_js_1 = require("../ci/evaluateCiResult.js");
const buildCliViewModel_js_1 = require("../core/result/buildCliViewModel.js");
const renderCliResult_js_1 = require("../core/result/renderCliResult.js");
const formatOutput_js_1 = require("../core/formatOutput.js");
const decisionEngine_js_1 = require("../engine/decisionEngine.js");
const auditSnapshot_js_1 = require("../audit/auditSnapshot.js");
const colors_js_1 = require("./colors.js");
const diffOutput_js_1 = require("./diffOutput.js");
const output_js_1 = require("./output.js");
const snapshotWriter_js_1 = require("../audit/snapshotWriter.js");
const snapshotReader_js_1 = require("../audit/snapshotReader.js");
const snapshotDiff_js_1 = require("../audit/snapshotDiff.js");
const renderAuditDiff_js_1 = require("../audit/renderAuditDiff.js");
const loadPatchPlan_js_1 = require("./loadPatchPlan.js");
const runApplyFlow_js_1 = require("../apply/runApplyFlow.js");
const renderApplyResult_js_1 = require("../apply/renderApplyResult.js");
const buildGeneratedPatchPlanPreview_js_1 = require("./buildGeneratedPatchPlanPreview.js");
const applyLlmPatches_js_1 = require("../core/applyLlmPatches.js");
const buildGeneratedPatchPlan_js_1 = require("../patch-generation/buildGeneratedPatchPlan.js");
require("dotenv/config");
const canConvertGeneratedPlanToPatchPlan_js_1 = require("../patch/conversion/canConvertGeneratedPlanToPatchPlan.js");
const convertGeneratedPlanToPatchPlan_js_1 = require("../patch/conversion/convertGeneratedPlanToPatchPlan.js");
const runTestEngineerFlow_js_1 = require("../roles/runTestEngineerFlow.js");
const runDataAnalystFlow_js_1 = require("../roles/runDataAnalystFlow.js");
const confidenceGate_js_1 = require("../core/confidenceGate.js");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const ANSI_ENABLED = node_process_1.default.env.VITEST !== "true" && node_process_1.default.env.NO_COLOR !== "1";
// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------
function resolveAuditFlag(argv) {
    return argv.includes("--audit");
}
function mapSavedModeToExecutionMode(mode) {
    switch (mode) {
        case "apply":
            return "safe_to_apply";
        case "preview":
            return "preview_only";
        case "blocked":
            return "blocked";
    }
}
function resolveAuditReplayPath(options) {
    const value = options.auditReplay?.trim();
    return value ? value : null;
}
function resolveAuditDiffPaths(options) {
    const raw = options.auditDiff?.trim();
    if (!raw) {
        return null;
    }
    const [leftPath, rightPath] = raw.split(",").map((part) => part.trim());
    if (!leftPath || !rightPath) {
        return null;
    }
    return { leftPath, rightPath };
}
function resolvePatchPlanPath(options) {
    const value = options.patchPlan?.trim();
    return value ? node_path_1.default.resolve(value) : null;
}
function runAuditReplayFlow(filePath) {
    const snapshot = (0, snapshotReader_js_1.readAuditSnapshot)(filePath);
    if (!snapshot) {
        return 0;
    }
    (0, output_js_1.printAuditSnapshot)(snapshot);
    return 0;
}
function runAuditDiffFlow(leftPath, rightPath) {
    const leftSnapshot = (0, snapshotReader_js_1.readAuditSnapshot)(leftPath);
    const rightSnapshot = (0, snapshotReader_js_1.readAuditSnapshot)(rightPath);
    if (!leftSnapshot || !rightSnapshot) {
        return 0;
    }
    const diff = (0, snapshotDiff_js_1.diffAuditSnapshots)(leftSnapshot, rightSnapshot);
    console.log((0, renderAuditDiff_js_1.renderAuditDiff)(diff));
    return 0;
}
const DEFAULT_RESULT_PATH = node_path_1.default.join(".agent-cache", "last-result.json");
function formatErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
}
async function ensureParentDir(filePath) {
    const dir = node_path_1.default.dirname(filePath);
    await node_fs_1.promises.mkdir(dir, { recursive: true });
}
async function writeJsonFile(filePath, data) {
    await ensureParentDir(filePath);
    await node_fs_1.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}
function tone(text, ...codes) {
    return ANSI_ENABLED ? (0, colors_js_1.colorize)(text, ...codes) : text;
}
function zonePrefix() {
    return tone("[zone]", colors_js_1.c.bold, colors_js_1.c.cyan);
}
function colorConfidence(score) {
    if (!ANSI_ENABLED)
        return String(score);
    if (score >= 70)
        return tone(String(score), colors_js_1.c.bold, colors_js_1.c.green);
    if (score >= 50)
        return tone(String(score), colors_js_1.c.bold, colors_js_1.c.yellow);
    return tone(String(score), colors_js_1.c.bold, colors_js_1.c.red);
}
function colorLabel(label, color, symbol) {
    if (!ANSI_ENABLED)
        return label;
    const prefix = symbol ? `${symbol} ` : "";
    return `${tone(prefix, colors_js_1.c.bold, color)}${tone(label, colors_js_1.c.bold, color)}`;
}
function formatApplyLog(kind, values) {
    const colors = {
        Applied: colors_js_1.c.green,
        Failed: colors_js_1.c.red,
        Skipped: colors_js_1.c.gray,
    };
    const symbols = {
        Applied: "✓",
        Failed: "✗",
        Skipped: "•",
    };
    return `${zonePrefix()} ${colorLabel(`${kind}:`, colors[kind], symbols[kind])} ${values.join(", ") || "none"}`;
}
function printHeader() {
    console.log(tone("⚡ Zone", colors_js_1.c.bold, colors_js_1.c.orange) + tone(" v0.1.0", colors_js_1.c.dim, colors_js_1.c.gray));
    console.log(tone("AI Code Agent — deterministic, explainable, safe", colors_js_1.c.dim, colors_js_1.c.gray));
}
function printStatusLine(statusLine) {
    console.log(statusLine);
}
function printSummaryLine(summaryLine) {
    console.log(summaryLine);
}
function printVerbose(label, value, enabled) {
    if (!enabled) {
        return;
    }
    const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    console.log(`\n${tone("[verbose]", colors_js_1.c.dim, colors_js_1.c.gray)} ${label}`);
    console.log(serialized);
}
function resolveTask(options) {
    const task = options.task?.trim();
    if (!task) {
        throw new Error("Missing required --task value. Use --task for agent runs, or use --audit-replay / --audit-diff for audit operations.");
    }
    return task;
}
function resolveRepoPath(options) {
    if (options.repo?.trim()) {
        return node_path_1.default.resolve(options.repo);
    }
    return node_process_1.default.cwd();
}
function resolveResultPath(options) {
    if (options.output?.trim()) {
        return node_path_1.default.resolve(options.output);
    }
    return node_path_1.default.resolve(DEFAULT_RESULT_PATH);
}
function resolveMode(options) {
    return options.mode ?? "preview";
}
function resolveFormat(options) {
    switch (options.format) {
        case "summary":
        case "detailed":
        case "json":
            return options.format;
        default:
            return "summary";
    }
}
function resolveOutputFormat(rawFormat) {
    if (!rawFormat || rawFormat === "text")
        return "text";
    if (rawFormat === "json")
        return "json";
    throw new Error(`Invalid --format value: "${rawFormat}". Valid values for task-only mode are: text, json`);
}
async function getChangedFiles(repoPath) {
    try {
        const baseSha = node_process_1.default.env.SMILE_AGENT_BASE_SHA?.trim();
        const headSha = node_process_1.default.env.SMILE_AGENT_HEAD_SHA?.trim() || "HEAD";
        const args = baseSha
            ? ["diff", "--name-only", `${baseSha}...${headSha}`]
            : ["status", "--short"];
        const { stdout } = await execFileAsync("git", args, {
            cwd: repoPath,
            windowsHide: true,
        });
        const lines = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (baseSha) {
            return lines.map((line) => line.replace(/\\/g, "/"));
        }
        return lines
            .map((line) => {
            const normalized = line.replace(/\\/g, "/");
            return normalized.length > 3 ? normalized.slice(3).trim() : normalized;
        })
            .filter(Boolean);
    }
    catch {
        return [];
    }
}
function buildErrorResult(task, repoPath, message) {
    return {
        version: 2,
        generatedAt: new Date().toISOString(),
        summary: `Run failed: ${message}`,
        statusLine: "STATUS: BLOCKED | confidence=0 | warnings=1 | penalties=1 | patches=0 | relevant=0 | suggested=0",
        meta: {
            task,
            targetPath: repoPath,
            relevantFileCount: 0,
            suggestedFileCount: 0,
            patchCount: 0,
        },
        intent: {
            rawTask: task,
            operation: "unknown",
            target: "unknown",
            scope: "unknown",
            nestedTarget: null,
            confidence: "low",
            warnings: ["Runtime failure prevented normal execution."],
        },
        schema: {
            summary: "Schema analysis unavailable due to runtime failure.",
            entities: [],
            relations: [],
            confidence: "low",
        },
        storage: {
            primaryStorage: "unknown",
            detectedClients: [],
            confidence: "low",
            reasoning: ["Runtime failure prevented storage analysis."],
            resourceStorageKind: "unknown",
        },
        validation: {
            patch: [],
            schema: [],
        },
        issues: {
            summary: {
                total: 1,
                errors: 1,
                warnings: 0,
            },
            grouped: [
                {
                    key: "runtime",
                    label: "Runtime failure",
                    total: 1,
                    errors: 1,
                    warnings: 0,
                    issues: [
                        {
                            code: "RUNTIME_FAILURE",
                            severity: "error",
                            message,
                        },
                    ],
                },
            ],
            topRisks: [
                {
                    id: "issue:runtime_failure",
                    title: "Runtime failure",
                    description: message,
                    severity: "high",
                    score: 100,
                    category: "validation",
                    source: "derived",
                    relatedCode: "RUNTIME_FAILURE",
                },
            ],
        },
        decision: {
            mode: "blocked",
            confidence: 0,
            reason: message,
            recommendation: "Do not apply automatically. Resolve the runtime failure first.",
        },
        confidenceBreakdown: {
            finalScore: 0,
            level: "low",
            factors: {
                intentClarity: 0,
                schemaCertainty: 0,
                storageCertainty: 0,
                patchValidationHealth: 0,
            },
        },
        confidenceDetails: {
            baseWeightedScore: 0,
            totalPenalty: 100,
            penalties: [
                {
                    code: "RUNTIME_FAILURE",
                    label: "Runtime failure",
                    appliedPenalty: 100,
                },
            ],
        },
        notes: {
            execution: [message],
            assumptions: [],
            followUps: ["Fix the runtime failure and rerun the agent."],
        },
        debug: {
            patchTargets: [],
            suggestedFiles: [],
        },
    };
}
async function runTaskOnlyFlow(options) {
    const { task, verbose, showTrace, traceId, tracker, outputFormat, audit, auditOut, apply, confirmApply, diff, patchPlanPath, useGeneratedPatchPlan, repoPath, role, } = options;
    tracker.startPhase("run_agent");
    const result = await (0, runAgent_js_1.runAgent)({ task, role });
    tracker.endPhase("run_agent");
    tracker.endPhase("total");
    printVerbose("runAgent.result", result, verbose);
    const renderedDecisionOutput = (0, formatOutput_js_1.formatOutput)(result, outputFormat, {
        showTrace,
        verbose,
    });
    const generatedPlan = (0, buildGeneratedPatchPlan_js_1.buildGeneratedPatchPlan)({
        task: result.task,
        decision: result.decision,
        reasonCodes: result.reasonCodes,
    });
    const generatedPatchPlanPreview = (0, buildGeneratedPatchPlanPreview_js_1.buildGeneratedPatchPlanPreview)({
        task: result.task,
        decision: result.decision,
        reasonCodes: result.reasonCodes,
    });
    // Confidence gate check
    const gateResult = (0, confidenceGate_js_1.checkConfidenceGate)({
        confidenceScore: result.decision.confidenceScore,
        role: role,
        warnings: result.topRisks?.map(r => r.reason) ?? [],
    });
    if (!gateResult.pass && apply && confirmApply) {
        console.log("");
        console.log((0, confidenceGate_js_1.renderConfidenceGateBlock)(gateResult));
        console.log("");
        console.log(`${zonePrefix()} ${tone("Apply blocked by confidence gate. Use --verbose to see details.", colors_js_1.c.yellow)}`);
        return 1;
    }
    if (!gateResult.pass) {
        console.log("");
        console.log((0, confidenceGate_js_1.renderConfidenceGateBlock)(gateResult));
        console.log(`${zonePrefix()} ${tone("Proceeding in preview mode only.", colors_js_1.c.yellow)}`);
        console.log("");
    }
    const intent = (0, classifyPatchIntent_js_1.classifyPatchIntent)(task);
    let patchSection = generatedPatchPlanPreview;
    if (intent === "unknown" && repoPath) {
        if (role === "data_analyst") {
            console.log(`${zonePrefix()} ${tone("Data Analyst role — delegating to data analyst flow...", colors_js_1.c.white)}`);
            const daResult = await (0, runDataAnalystFlow_js_1.runDataAnalystFlow)({ task, repoPath });
            if (!daResult.ok) {
                console.error(`[zone] Data analyst flow failed: ${daResult.reason}`);
                return 1;
            }
            console.log(`${zonePrefix()} Dialect detected: ${tone(daResult.dialect, colors_js_1.c.blue)} (${tone(daResult.migrationFormat, colors_js_1.c.blue)})`);
            console.log(`${zonePrefix()} Confidence: ${colorConfidence(daResult.confidence)}`);
            console.log(daResult.preview);
            if (apply && confirmApply && daResult.applyPatches.length > 0) {
                const originalContents = await capturePatchOriginals(repoPath, daResult.applyPatches);
                console.log(`${zonePrefix()} ${tone("Applying migration files...", colors_js_1.c.white)}`);
                const applyResult = await (0, applyLlmPatches_js_1.applyLlmPatches)(daResult.applyPatches, repoPath);
                console.log(formatApplyLog("Applied", applyResult.applied));
                console.log(formatApplyLog("Failed", applyResult.failed));
                if (diff && applyResult.applied.length > 0) {
                    (0, diffOutput_js_1.renderDiffSummary)(applyResult.applied.map((filePath) => {
                        const patch = daResult.applyPatches.find((p) => p.filePath === filePath);
                        return {
                            filePath,
                            original: originalContents[filePath] ?? "",
                            updated: patch?.fullContent ?? "",
                        };
                    }));
                }
            }
            return 0;
        }
        if (role === "test_engineer") {
            console.log(`${zonePrefix()} ${tone("Test Engineer role — delegating to test engineer flow...", colors_js_1.c.white)}`);
            const teResult = await (0, runTestEngineerFlow_js_1.runTestEngineerFlow)({ task, repoPath });
            if (!teResult.ok) {
                console.error(`[zone] Test engineer flow failed: ${teResult.reason}`);
                if (teResult.framework === "unknown") {
                    console.error("[zone] No test framework detected in this repository.");
                    console.error("[zone] Supported: playwright-ts, playwright-js, cypress, cucumber-java, selenium-java, testng, pytest");
                }
                return 1;
            }
            console.log(`${zonePrefix()} Framework detected: ${tone(teResult.framework, colors_js_1.c.blue)} (${tone(teResult.language, colors_js_1.c.blue)})`);
            console.log(`${zonePrefix()} Confidence: ${colorConfidence(teResult.confidence)}`);
            if (teResult.complexity && teResult.complexity !== 'simple') {
                const complexityLabels = {
                    data_driven: 'Data Driven',
                    e2e: 'E2E',
                    negative: 'Negative',
                    multi_scenario: 'Multi Scenario',
                };
                const label = complexityLabels[teResult.complexity] || teResult.complexity;
                console.log(`${zonePrefix()} Complexity: ${tone(label, colors_js_1.c.cyan)}`);
            }
            console.log(teResult.preview);
            if (apply && confirmApply && teResult.applyPatches.length > 0) {
                const originalContents = await capturePatchOriginals(repoPath, teResult.applyPatches);
                console.log(`${zonePrefix()} ${tone("Applying test files...", colors_js_1.c.white)}`);
                const applyResult = await (0, applyLlmPatches_js_1.applyLlmPatches)(teResult.applyPatches, repoPath);
                console.log(formatApplyLog("Applied", applyResult.applied));
                console.log(formatApplyLog("Failed", applyResult.failed));
                if (diff && applyResult.applied.length > 0) {
                    (0, diffOutput_js_1.renderDiffSummary)(applyResult.applied.map((filePath) => {
                        const patch = teResult.applyPatches.find((p) => p.filePath === filePath);
                        return {
                            filePath,
                            original: originalContents[filePath] ?? "",
                            updated: patch?.fullContent ?? "",
                        };
                    }));
                }
            }
            return 0;
        }
        console.log(`${zonePrefix()} ${tone("Intent unknown — delegating to LLM patch flow...", colors_js_1.c.white)}`);
        const llmResult = await (0, runLlmPatchFlow_js_1.runLlmPatchFlow)({ task, repoPath });
        if (llmResult.ok) {
            patchSection = llmResult.patchPreview;
            if (apply && confirmApply && llmResult.applyPatches.length > 0) {
                const originalContents = llmResult.originalContents ??
                    (await capturePatchOriginals(repoPath, llmResult.applyPatches));
                console.log(`${zonePrefix()} ${tone("Applying LLM patches...", colors_js_1.c.white)}`);
                const applyResult = await (0, applyLlmPatches_js_1.applyLlmPatches)(llmResult.applyPatches, repoPath);
                console.log(formatApplyLog("Applied", applyResult.applied));
                console.log(formatApplyLog("Skipped", applyResult.skipped));
                console.log(formatApplyLog("Failed", applyResult.failed));
                if (diff && applyResult.applied.length > 0) {
                    (0, diffOutput_js_1.renderDiffSummary)(applyResult.applied.map((filePath) => {
                        const patch = llmResult.applyPatches.find((p) => p.filePath === filePath);
                        return {
                            filePath,
                            original: originalContents[filePath] ?? "",
                            updated: patch?.fullContent ?? "",
                        };
                    }));
                }
            }
        }
        else {
            patchSection = generatedPatchPlanPreview + "\n\n[zone] LLM patch flow failed: " + llmResult.reason;
        }
    }
    const finalOutput = [
        renderedDecisionOutput,
        "",
        patchSection,
    ].join("\n");
    console.log("");
    console.log(finalOutput);
    console.log("");
    if (apply) {
        console.log("=== APPLY RESULT ===");
        if (!confirmApply) {
            console.log("Status: skipped\nReason: Apply requested but not confirmed. Re-run with --confirm-apply.");
            console.log("");
            printVerbose("execution", {
                traceId,
                ...tracker.build(),
            }, verbose);
            return 0;
        }
        let patchPlan;
        if (useGeneratedPatchPlan) {
            tracker.startPhase("validate_generated_patch_plan");
            const conversionCheck = (0, canConvertGeneratedPlanToPatchPlan_js_1.canConvertGeneratedPlanToPatchPlan)(generatedPlan);
            tracker.endPhase("validate_generated_patch_plan");
            if (!conversionCheck.canConvert) {
                console.log("Status: blocked");
                console.log("Reason: Generated patch plan conversion failed.");
                console.log(`Code: ${conversionCheck.code}`);
                console.log(`Details: ${conversionCheck.reason}`);
                console.log("");
                printVerbose("generatedPlan", generatedPlan, verbose);
                printVerbose("generatedPlan.conversionCheck", conversionCheck, verbose);
                printVerbose("execution", {
                    traceId,
                    ...tracker.build(),
                }, verbose);
                return 1;
            }
            tracker.startPhase("convert_generated_patch_plan");
            patchPlan = (0, convertGeneratedPlanToPatchPlan_js_1.convertGeneratedPlanToPatchPlan)(generatedPlan);
            tracker.endPhase("convert_generated_patch_plan");
            printVerbose("generatedPlan", generatedPlan, verbose);
            printVerbose("generatedPlan.patchPlan", patchPlan, verbose);
        }
        else {
            if (!patchPlanPath) {
                throw new Error("Apply requested but no patch plan was provided. Use --patch-plan <file>.");
            }
            tracker.startPhase("load_patch_plan");
            patchPlan = (0, loadPatchPlan_js_1.loadPatchPlan)(patchPlanPath);
            tracker.endPhase("load_patch_plan");
        }
        const patchEntries = Array.isArray(patchPlan.patches)
            ? (patchPlan.patches)
            : [];
        const originalContents = diff && patchEntries.length > 0
            ? await capturePatchOriginals(repoPath, patchEntries.map((patch) => ({ filePath: patch.filePath })))
            : {};
        tracker.startPhase("run_apply_flow");
        const applyResult = await (0, runApplyFlow_js_1.runApplyFlow)({
            result,
            plan: patchPlan,
            request: {
                confirm: true,
            },
        });
        tracker.endPhase("run_apply_flow");
        console.log((0, renderApplyResult_js_1.renderApplyResult)(applyResult));
        console.log("");
        if (diff && applyResult.applied && patchEntries.length > 0) {
            (0, diffOutput_js_1.renderDiffSummary)(patchEntries.map((patch) => ({
                filePath: patch.filePath,
                original: originalContents[patch.filePath] ?? "",
                updated: patch.nextContent,
            })));
        }
        printVerbose("applyResult", applyResult, verbose);
        printVerbose("execution", {
            traceId,
            ...tracker.build(),
        }, verbose);
        if (audit || auditOut) {
            try {
                const engineInput = {
                    riskScore: result.risk.score / 100,
                    confidenceScore: result.decision.confidenceScore / 100,
                    mode: result.decision.mode,
                };
                const engineResult = (0, decisionEngine_js_1.runDecisionEngine)(engineInput);
                const snapshot = (0, auditSnapshot_js_1.buildAuditSnapshot)(engineInput, engineResult, {
                    reasonCodes: result.reasonCodes,
                });
                if (audit) {
                    (0, output_js_1.printAuditSnapshot)(snapshot);
                }
                if (auditOut) {
                    (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, auditOut);
                }
            }
            catch {
                // audit errors must never propagate
            }
        }
        return applyResult.applied ? 0 : 1;
    }
    printVerbose("execution", {
        traceId,
        ...tracker.build(),
    }, verbose);
    if (audit || auditOut) {
        try {
            const engineInput = {
                riskScore: result.risk.score / 100,
                confidenceScore: result.decision.confidenceScore / 100,
                mode: result.decision.mode,
            };
            const engineResult = (0, decisionEngine_js_1.runDecisionEngine)(engineInput);
            const snapshot = (0, auditSnapshot_js_1.buildAuditSnapshot)(engineInput, engineResult, {
                reasonCodes: result.reasonCodes,
            });
            if (audit) {
                (0, output_js_1.printAuditSnapshot)(snapshot);
            }
            if (auditOut) {
                (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, auditOut);
            }
        }
        catch {
            // audit errors must never propagate
        }
    }
    return 0;
}
async function runCliWithOptions(options) {
    const tracker = new executionTracker_js_1.ExecutionTracker();
    const traceId = (0, trace_js_1.generateTraceId)();
    tracker.startPhase("total");
    const verbose = Boolean(options.verbose);
    const auditReplayPath = resolveAuditReplayPath(options);
    const auditDiffPaths = resolveAuditDiffPaths(options);
    if (auditReplayPath) {
        printVerbose("cli.options", options, verbose);
        return runAuditReplayFlow(auditReplayPath);
    }
    if (options.auditDiff && !auditDiffPaths) {
        console.error('[audit] Failed to diff snapshots: expected --audit-diff="<left.json,right.json>"');
        return 0;
    }
    if (auditDiffPaths) {
        printVerbose("cli.options", options, verbose);
        return runAuditDiffFlow(auditDiffPaths.leftPath, auditDiffPaths.rightPath);
    }
    const task = resolveTask(options);
    const repoPath = resolveRepoPath(options);
    const resultPath = resolveResultPath(options);
    const mode = resolveMode(options);
    const format = resolveFormat(options);
    const ciMode = Boolean(options.ci);
    const showTrace = Boolean(options.trace) || verbose;
    const diffAware = Boolean(options.diffAware);
    const taskOnly = Boolean(options.taskOnly);
    const audit = Boolean(options.audit);
    const auditOut = options.auditOut?.trim() || null;
    printHeader();
    console.log(`Mode: ${ciMode ? "CI" : "standard"}`);
    console.log(`Format: ${format}`);
    console.log(`Flow: ${taskOnly ? "task-only" : "legacy"}`);
    printVerbose("cli.options", options, verbose);
    printVerbose("repoPath", repoPath, verbose);
    printVerbose("resultPath", resultPath, verbose);
    try {
        if (taskOnly) {
            const outputFormat = resolveOutputFormat(options.format);
            return await runTaskOnlyFlow({
                task,
                verbose,
                showTrace,
                traceId,
                tracker,
                outputFormat,
                audit,
                auditOut,
                apply: Boolean(options.apply),
                confirmApply: Boolean(options.confirmApply),
                diff: Boolean(options.diff),
                patchPlanPath: resolvePatchPlanPath(options),
                useGeneratedPatchPlan: Boolean(options.useGeneratedPatchPlan),
                repoPath,
                role: options.role,
            });
        }
        const changedFiles = diffAware ? await getChangedFiles(repoPath) : [];
        if (diffAware) {
            printVerbose("changedFiles", changedFiles, verbose);
        }
        tracker.startPhase("run_agent");
        await (0, runFeatureAgent_js_1.runFeatureAgent)({
            task,
            targetPath: repoPath,
            mode,
            changedFiles,
        });
        tracker.endPhase("run_agent");
        tracker.startPhase("load_result");
        const savedResult = await (0, loadSavedAgentResult_js_1.loadSavedAgentResult)(repoPath);
        tracker.endPhase("load_result");
        if (!savedResult) {
            throw new Error("Saved agent result could not be loaded after execution.");
        }
        tracker.startPhase("build_cli_view");
        const cliView = (0, buildCliViewModel_js_1.buildCliViewModel)(savedResult);
        tracker.endPhase("build_cli_view");
        tracker.endPhase("total");
        savedResult.execution = {
            traceId,
            ...tracker.build(),
        };
        await writeJsonFile(resultPath, savedResult);
        console.log("");
        console.log((0, renderCliResult_js_1.renderCliResult)(cliView, format));
        console.log("");
        console.log(`Result saved: ${resultPath}`);
        if (audit || auditOut) {
            try {
                const engineInput = {
                    riskScore: 0,
                    confidenceScore: savedResult.decision.confidence / 100,
                    mode: mapSavedModeToExecutionMode(savedResult.decision.mode),
                };
                const engineResult = (0, decisionEngine_js_1.runDecisionEngine)(engineInput);
                const snapshot = (0, auditSnapshot_js_1.buildAuditSnapshot)(engineInput, engineResult);
                if (audit) {
                    (0, output_js_1.printAuditSnapshot)(snapshot);
                }
                if (auditOut) {
                    (0, snapshotWriter_js_1.writeAuditSnapshot)(snapshot, auditOut);
                }
            }
            catch {
                // audit errors must never propagate
            }
        }
        if (ciMode) {
            const ciEvaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(savedResult);
            printStatusLine(ciEvaluation.statusLine);
            printSummaryLine(ciEvaluation.summaryLine);
            if (verbose) {
                printVerbose("ciEvaluation", ciEvaluation, true);
            }
            return ciEvaluation.shouldFail ? 1 : 0;
        }
        return 0;
    }
    catch (error) {
        const message = formatErrorMessage(error);
        tracker.endPhase("total");
        if (taskOnly) {
            console.error("");
            console.error(`Task-only flow failed: ${message}`);
            console.error("");
            printVerbose("execution", {
                traceId,
                ...tracker.build(),
            }, verbose);
            return 1;
        }
        const errorResult = buildErrorResult(task, repoPath, message);
        errorResult.execution = {
            traceId,
            ...tracker.build(),
        };
        await writeJsonFile(resultPath, errorResult);
        if (ciMode) {
            const ciEvaluation = (0, evaluateCiResult_js_1.evaluateCiResult)(errorResult);
            printStatusLine(ciEvaluation.statusLine);
            printSummaryLine(ciEvaluation.summaryLine);
            return 1;
        }
        const cliView = (0, buildCliViewModel_js_1.buildCliViewModel)(errorResult);
        console.error("");
        console.error((0, renderCliResult_js_1.renderCliResult)(cliView, format));
        console.error("");
        console.error(`Result saved: ${resultPath}`);
        return 1;
    }
}
async function run() {
    const program = new commander_1.Command();
    let subcommandHandled = false;
    program
        .command("serve")
        .description("Start Zone web UI on localhost")
        .option("--port <port>", "Port to listen on", "3000")
        .option("--open", "Open browser automatically")
        .action(async (options) => {
        subcommandHandled = true;
        const port = Number.parseInt(options.port, 10);
        console.log(tone("⚡ Zone", colors_js_1.c.bold, colors_js_1.c.orange) + tone(" v0.1.0", colors_js_1.c.dim, colors_js_1.c.gray));
        console.log(tone(`Starting web UI on http://localhost:${port}`, colors_js_1.c.cyan));
        node_process_1.default.env.ZONE_SERVER_MANUAL_START = "1";
        const { startServer } = await import("../api/server.js");
        await startServer(port);
        if (options.open) {
            const { exec } = await import("node:child_process");
            exec(`start http://localhost:${port}`);
        }
    });
    program
        .name("zone")
        .description("Zone — AI Code Agent: deterministic, explainable, safe")
        .option("--task <text>", "Task or change request to analyze")
        .option("--repo <path>", "Target repository path", node_process_1.default.cwd())
        .option("--ci", "Enable CI mode")
        .option("--verbose", "Enable verbose logs")
        .option("--trace", "Show decision trace in output")
        .option("--diff-aware", "Boost ranking using git diff context")
        .option("--diff", "Show colored diff of applied changes")
        .option("--task-only", "Run Sprint 7 task-only orchestration flow")
        .option("--apply", "Execute controlled apply flow after decision output")
        .option("--confirm-apply", "Explicit confirmation required before apply")
        .option("--patch-plan <path>", "Path to PatchPlan JSON file")
        .option("--use-generated-patch-plan", "Generate a deterministic patch plan from the decision result and use it for apply if safely convertible")
        .option("--audit", "Print full audit snapshot as JSON to stdout (additive, no side effects)")
        .option("--audit-out <path>", "Write audit snapshot as JSON to a file (additive, independent of --audit)")
        .option("--audit-replay <path>", "Read and print an audit snapshot from disk")
        .option("--audit-diff <paths>", 'Compare two audit snapshots: "<left.json,right.json>"')
        .option("--mode <mode>", "Execution mode: preview | dry-run | apply", "preview")
        .option("--format <mode>", "CLI output format: summary | detailed | json", "summary")
        .option("--output <path>", "Path for structured JSON result output", DEFAULT_RESULT_PATH)
        .option("--role <role>", "Agent role: developer | test_engineer | data_analyst")
        .allowExcessArguments(false);
    await program.parseAsync(node_process_1.default.argv);
    if (subcommandHandled) {
        return;
    }
    const options = program.opts();
    const exitCode = await runCliWithOptions(options);
    node_process_1.default.exit(exitCode);
}
if (node_process_1.default.env.VITEST !== "true") {
    void run();
}
async function readRepoFileContent(repoPath, filePath) {
    try {
        return await node_fs_1.promises.readFile(node_path_1.default.resolve(repoPath, filePath), "utf8");
    }
    catch {
        return "";
    }
}
async function capturePatchOriginals(repoPath, patches) {
    const entries = await Promise.all(patches.map(async (patch) => [
        patch.filePath,
        await readRepoFileContent(repoPath, patch.filePath),
    ]));
    return Object.fromEntries(entries);
}
//# sourceMappingURL=index.js.map