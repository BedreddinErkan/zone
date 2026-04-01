#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCliWithOptions = runCliWithOptions;
exports.run = run;
const commander_1 = require("commander");
const node_path_1 = __importDefault(require("node:path"));
const node_process_1 = __importDefault(require("node:process"));
const node_fs_1 = require("node:fs");
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const executionTracker_js_1 = require("../utils/executionTracker.js");
const trace_js_1 = require("../utils/trace.js");
const runFeatureAgent_js_1 = require("../core/runFeatureAgent.js");
const loadSavedAgentResult_js_1 = require("../core/loadSavedAgentResult.js");
const evaluateCiResult_js_1 = require("../ci/evaluateCiResult.js");
const buildCliViewModel_js_1 = require("../core/result/buildCliViewModel.js");
const renderCliResult_js_1 = require("../core/result/renderCliResult.js");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
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
function printHeader() {
    console.log("Smile Agent");
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
    console.log(`\n[verbose] ${label}`);
    console.log(serialized);
}
function resolveTask(options) {
    const task = options.task?.trim();
    if (!task) {
        throw new Error("Missing required --task value.");
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
async function getChangedFiles(repoPath) {
    try {
        const baseSha = node_process_1.default.env.SMILE_AGENT_BASE_SHA?.trim();
        const headSha = node_process_1.default.env.SMILE_AGENT_HEAD_SHA?.trim() || "HEAD";
        const args = baseSha
            ? ["diff", "--name-only", `${baseSha}...${headSha}`]
            : ["status", "--short"];
        const { stdout } = await execFileAsync("git", args, {
            cwd: repoPath,
            windowsHide: true
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
            patchCount: 0
        },
        intent: {
            rawTask: task,
            operation: "unknown",
            target: "unknown",
            scope: "unknown",
            nestedTarget: null,
            confidence: "low",
            warnings: ["Runtime failure prevented normal execution."]
        },
        schema: {
            summary: "Schema analysis unavailable due to runtime failure.",
            entities: [],
            relations: [],
            confidence: "low"
        },
        storage: {
            primaryStorage: "unknown",
            detectedClients: [],
            confidence: "low",
            reasoning: ["Runtime failure prevented storage analysis."],
            resourceStorageKind: "unknown"
        },
        validation: {
            patch: [],
            schema: []
        },
        issues: {
            summary: {
                total: 1,
                errors: 1,
                warnings: 0
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
                            message
                        }
                    ]
                }
            ],
            topRisks: [
                {
                    code: "RUNTIME_FAILURE",
                    severity: "error",
                    message
                }
            ]
        },
        decision: {
            mode: "blocked",
            confidence: 0,
            reason: message,
            recommendation: "Do not apply automatically. Resolve the runtime failure first."
        },
        confidenceBreakdown: {
            finalScore: 0,
            level: "low",
            factors: {
                intentClarity: 0,
                schemaCertainty: 0,
                storageCertainty: 0,
                patchValidationHealth: 0
            }
        },
        confidenceDetails: {
            baseWeightedScore: 0,
            totalPenalty: 100,
            penalties: [
                {
                    code: "RUNTIME_FAILURE",
                    label: "Runtime failure",
                    appliedPenalty: 100
                }
            ]
        },
        notes: {
            execution: [message],
            assumptions: [],
            followUps: ["Fix the runtime failure and rerun the agent."]
        },
        debug: {
            patchTargets: [],
            suggestedFiles: []
        }
    };
}
async function runCliWithOptions(options) {
    const tracker = new executionTracker_js_1.ExecutionTracker();
    const traceId = (0, trace_js_1.generateTraceId)();
    tracker.startPhase("total");
    const task = resolveTask(options);
    const repoPath = resolveRepoPath(options);
    const resultPath = resolveResultPath(options);
    const mode = resolveMode(options);
    const format = resolveFormat(options);
    const ciMode = Boolean(options.ci);
    const verbose = Boolean(options.verbose);
    const diffAware = Boolean(options.diffAware);
    printHeader();
    console.log(`Mode: ${ciMode ? "CI" : "standard"}`);
    console.log(`Format: ${format}`);
    printVerbose("cli.options", options, verbose);
    printVerbose("repoPath", repoPath, verbose);
    printVerbose("resultPath", resultPath, verbose);
    try {
        const changedFiles = diffAware ? await getChangedFiles(repoPath) : [];
        if (diffAware) {
            printVerbose("changedFiles", changedFiles, verbose);
        }
        tracker.startPhase("run_agent");
        await (0, runFeatureAgent_js_1.runFeatureAgent)({
            task,
            targetPath: repoPath,
            mode,
            changedFiles
        });
        tracker.endPhase("run_agent");
        tracker.startPhase("load_result");
        const savedResult = await (0, loadSavedAgentResult_js_1.loadSavedAgentResult)(repoPath);
        tracker.endPhase("load_result");
        if (!savedResult) {
            throw new Error("Saved agent result could not be loaded after execution.");
        }
        tracker.startPhase("build_cli_view");
        tracker.endPhase("build_cli_view");
        tracker.endPhase("total");
        savedResult.execution = {
            traceId,
            ...tracker.build()
        };
        const cliView = (0, buildCliViewModel_js_1.buildCliViewModel)(savedResult);
        await writeJsonFile(resultPath, savedResult);
        console.log("");
        console.log((0, renderCliResult_js_1.renderCliResult)(cliView, format));
        console.log("");
        console.log(`Result saved: ${resultPath}`);
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
        const errorResult = buildErrorResult(task, repoPath, message);
        tracker.endPhase("total");
        errorResult.execution = {
            traceId,
            ...tracker.build()
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
    program
        .name("smile-agent")
        .description("AI-powered code agent for practical repository change planning and patch generation.")
        .requiredOption("--task <text>", "Task or change request to analyze")
        .option("--repo <path>", "Target repository path", node_process_1.default.cwd())
        .option("--ci", "Enable CI mode")
        .option("--verbose", "Enable verbose logs")
        .option("--diff-aware", "Boost ranking using git diff context")
        .option("--mode <mode>", "Execution mode: preview | dry-run | apply", "preview")
        .option("--format <mode>", "CLI output format: summary | detailed | json", "summary")
        .option("--output <path>", "Path for structured JSON result output", DEFAULT_RESULT_PATH)
        .allowExcessArguments(false)
        .parse(node_process_1.default.argv);
    const options = program.opts();
    const exitCode = await runCliWithOptions(options);
    node_process_1.default.exit(exitCode);
}
if (node_process_1.default.env.VITEST !== "true") {
    void run();
}
//# sourceMappingURL=index.js.map