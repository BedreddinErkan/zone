#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import process from "node:process";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyPatchIntent } from "../patch-generation/classifyPatchIntent.js";
import { runLlmPatchFlow } from "../core/runLlmPatchFlow.js";
import { ExecutionTracker } from "../utils/executionTracker.js";
import { generateTraceId } from "../utils/trace.js";
import { runFeatureAgent } from "../core/runFeatureAgent.js";
import { runAgent } from "../core/runAgent.js";
import { loadSavedAgentResult } from "../core/loadSavedAgentResult.js";
import { evaluateCiResult } from "../ci/evaluateCiResult.js";
import type {
  SavedAgentResult,
  CliOutputFormat,
  SavedDecisionMode,
} from "../types/agent.js";
import { buildCliViewModel } from "../core/result/buildCliViewModel.js";
import { renderCliResult } from "../core/result/renderCliResult.js";
import { formatOutput, type OutputFormat } from "../core/formatOutput.js";
import { runDecisionEngine } from "../engine/decisionEngine.js";
import type { ExecutionMode } from "../engine/contradictionDetector.js";
import { buildAuditSnapshot } from "../audit/auditSnapshot.js";
import { c, colorize } from "./colors.js";
import { renderDiffSummary } from "./diffOutput.js";
import { printAuditSnapshot } from "./output.js";
import { writeAuditSnapshot } from "../audit/snapshotWriter.js";
import { readAuditSnapshot } from "../audit/snapshotReader.js";
import { diffAuditSnapshots } from "../audit/snapshotDiff.js";
import { renderAuditDiff } from "../audit/renderAuditDiff.js";
import { loadPatchPlan } from "./loadPatchPlan.js";
import { runApplyFlow } from "../apply/runApplyFlow.js";
import { renderApplyResult } from "../apply/renderApplyResult.js";
import { buildGeneratedPatchPlanPreview } from "./buildGeneratedPatchPlanPreview.js";
import { applyLlmPatches } from "../core/applyLlmPatches.js";
import { buildGeneratedPatchPlan } from "../patch-generation/buildGeneratedPatchPlan.js";
import "dotenv/config";
import { canConvertGeneratedPlanToPatchPlan } from "../patch/conversion/canConvertGeneratedPlanToPatchPlan.js";
import {
  convertGeneratedPlanToPatchPlan,
  type PatchPlan,
} from "../patch/conversion/convertGeneratedPlanToPatchPlan.js";
import { runTestEngineerFlow } from "../roles/runTestEngineerFlow.js";
import { runDataAnalystFlow } from "../roles/runDataAnalystFlow.js";
import { checkConfidenceGate, renderConfidenceGateBlock } from "../core/confidenceGate.js";
const execFileAsync = promisify(execFile);
const ANSI_ENABLED = process.env.VITEST !== "true" && process.env.NO_COLOR !== "1";

type CliOptions = {
  task?: string;
  repo?: string;
  ci?: boolean;
  verbose?: boolean;
  trace?: boolean;
  diffAware?: boolean;
  diff?: boolean;
  output?: string;
  format?: string;
  taskOnly?: boolean;
  mode?: "preview" | "dry-run" | "apply";
  audit?: boolean;
  auditOut?: string;
  auditReplay?: string;
  auditDiff?: string;
  apply?: boolean;
  confirmApply?: boolean;
  patchPlan?: string;
  useGeneratedPatchPlan?: boolean;
  role?: string;

};

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

export function resolveAuditFlag(argv: string[]): boolean {
  return argv.includes("--audit");
}

function mapSavedModeToExecutionMode(mode: SavedDecisionMode): ExecutionMode {
  switch (mode) {
    case "apply":
      return "safe_to_apply";
    case "preview":
      return "preview_only";
    case "blocked":
      return "blocked";
  }
}

function resolveAuditReplayPath(options: CliOptions): string | null {
  const value = options.auditReplay?.trim();
  return value ? value : null;
}

function resolveAuditDiffPaths(
  options: CliOptions
): { leftPath: string; rightPath: string } | null {
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

function resolvePatchPlanPath(options: CliOptions): string | null {
  const value = options.patchPlan?.trim();
  return value ? path.resolve(value) : null;
}

function runAuditReplayFlow(filePath: string): number {
  const snapshot = readAuditSnapshot(filePath);

  if (!snapshot) {
    return 0;
  }

  printAuditSnapshot(snapshot);
  return 0;
}

function runAuditDiffFlow(leftPath: string, rightPath: string): number {
  const leftSnapshot = readAuditSnapshot(leftPath);
  const rightSnapshot = readAuditSnapshot(rightPath);

  if (!leftSnapshot || !rightSnapshot) {
    return 0;
  }

  const diff = diffAuditSnapshots(leftSnapshot, rightSnapshot);
  console.log(renderAuditDiff(diff));
  return 0;
}

const DEFAULT_RESULT_PATH = path.join(".agent-cache", "last-result.json");

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

async function ensureParentDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function tone(text: string, ...codes: string[]): string {
  return ANSI_ENABLED ? colorize(text, ...codes) : text;
}

function zonePrefix(): string {
  return tone("[zone]", c.bold, c.cyan);
}

function colorConfidence(score: number): string {
  if (!ANSI_ENABLED) return String(score);
  if (score >= 70) return tone(String(score), c.bold, c.green);
  if (score >= 50) return tone(String(score), c.bold, c.yellow);
  return tone(String(score), c.bold, c.red);
}

function colorLabel(label: string, color: string, symbol?: string): string {
  if (!ANSI_ENABLED) return label;
  const prefix = symbol ? `${symbol} ` : "";
  return `${tone(prefix, c.bold, color)}${tone(label, c.bold, color)}`;
}

function formatApplyLog(
  kind: "Applied" | "Failed" | "Skipped",
  values: string[]
): string {
  const colors = {
    Applied: c.green,
    Failed: c.red,
    Skipped: c.gray,
  };
  const symbols = {
    Applied: "✓",
    Failed: "✗",
    Skipped: "•",
  };

  return `${zonePrefix()} ${colorLabel(
    `${kind}:`,
    colors[kind],
    symbols[kind]
  )} ${values.join(", ") || "none"}`;
}

function printHeader(): void {
  console.log(
    tone("⚡ Zone", c.bold, c.orange) + tone(" v0.1.0", c.dim, c.gray)
  );
  console.log(
    tone("AI Code Agent — deterministic, explainable, safe", c.dim, c.gray)
  );
}

function printStatusLine(statusLine: string): void {
  console.log(statusLine);
}

function printSummaryLine(summaryLine: string): void {
  console.log(summaryLine);
}

function printVerbose(label: string, value: unknown, enabled: boolean): void {
  if (!enabled) {
    return;
  }

  const serialized =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);

  console.log(`\n${tone("[verbose]", c.dim, c.gray)} ${label}`);
  console.log(serialized);
}

function resolveTask(options: CliOptions): string {
  const task = options.task?.trim();

  if (!task) {
    throw new Error(
      "Missing required --task value. Use --task for agent runs, or use --audit-replay / --audit-diff for audit operations."
    );
  }

  return task;
}

function resolveRepoPath(options: CliOptions): string {
  if (options.repo?.trim()) {
    return path.resolve(options.repo);
  }

  return process.cwd();
}

function resolveResultPath(options: CliOptions): string {
  if (options.output?.trim()) {
    return path.resolve(options.output);
  }

  return path.resolve(DEFAULT_RESULT_PATH);
}

function resolveMode(options: CliOptions): "preview" | "dry-run" | "apply" {
  return options.mode ?? "preview";
}

function resolveFormat(options: CliOptions): CliOutputFormat {
  switch (options.format) {
    case "summary":
    case "detailed":
    case "json":
      return options.format;
    default:
      return "summary";
  }
}

function resolveOutputFormat(rawFormat: string | undefined): OutputFormat {
  if (!rawFormat || rawFormat === "text") return "text";
  if (rawFormat === "json") return "json";
  throw new Error(
    `Invalid --format value: "${rawFormat}". Valid values for task-only mode are: text, json`
  );
}

async function getChangedFiles(repoPath: string): Promise<string[]> {
  try {
    const baseSha = process.env.SMILE_AGENT_BASE_SHA?.trim();
    const headSha = process.env.SMILE_AGENT_HEAD_SHA?.trim() || "HEAD";

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
  } catch {
    return [];
  }
}

function buildErrorResult(
  task: string,
  repoPath: string,
  message: string
): SavedAgentResult {
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    summary: `Run failed: ${message}`,
    statusLine:
      "STATUS: BLOCKED | confidence=0 | warnings=1 | penalties=1 | patches=0 | relevant=0 | suggested=0",
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
      recommendation:
        "Do not apply automatically. Resolve the runtime failure first.",
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

async function runTaskOnlyFlow(options: {
  task: string;
  verbose: boolean;
  showTrace: boolean;
  traceId: string;
  tracker: ExecutionTracker;
  outputFormat: OutputFormat;
  audit: boolean;
  auditOut: string | null;
  apply: boolean;
  confirmApply: boolean;
  diff: boolean;
  patchPlanPath: string | null;
  useGeneratedPatchPlan: boolean;
  repoPath: string;
  role?: string;
}): Promise<number> {
const {
  task,
  verbose,
  showTrace,
  traceId,
  tracker,
  outputFormat,
  audit,
  auditOut,
  apply,
  confirmApply,
  diff,
  patchPlanPath,
  useGeneratedPatchPlan,
  repoPath,
  role,
} = options;

  tracker.startPhase("run_agent");
const result = await runAgent({ task, role });  tracker.endPhase("run_agent");

  tracker.endPhase("total");

  printVerbose("runAgent.result", result, verbose);

  const renderedDecisionOutput = formatOutput(result, outputFormat, {
    showTrace,
    verbose,
  });

  const generatedPlan = buildGeneratedPatchPlan({
    task: result.task,
    decision: result.decision,
    reasonCodes: result.reasonCodes,
  });

  const generatedPatchPlanPreview = buildGeneratedPatchPlanPreview({
    task: result.task,
    decision: result.decision,
    reasonCodes: result.reasonCodes,
  });
// Confidence gate check
const gateResult = checkConfidenceGate({
  confidenceScore: result.decision.confidenceScore,
  role: role,
  warnings: result.topRisks?.map(r => r.reason) ?? [],
});

if (!gateResult.pass && apply && confirmApply) {
  console.log("");
  console.log(renderConfidenceGateBlock(gateResult));
  console.log("");
  console.log(
    `${zonePrefix()} ${tone(
      "Apply blocked by confidence gate. Use --verbose to see details.",
      c.yellow
    )}`
  );
  return 1;
}

if (!gateResult.pass) {
  console.log("");
  console.log(renderConfidenceGateBlock(gateResult));
  console.log(`${zonePrefix()} ${tone("Proceeding in preview mode only.", c.yellow)}`);
  console.log("");
}
const intent = classifyPatchIntent(task);
let patchSection = generatedPatchPlanPreview;

if (intent === "unknown" && repoPath) {
  if (role === "data_analyst") {
    console.log(
      `${zonePrefix()} ${tone(
        "Data Analyst role — delegating to data analyst flow...",
        c.white
      )}`
    );
    const daResult = await runDataAnalystFlow({ task, repoPath });

    if (!daResult.ok) {
      console.error(`[zone] Data analyst flow failed: ${daResult.reason}`);
      return 1;
    }

    console.log(
      `${zonePrefix()} Dialect detected: ${tone(
        daResult.dialect,
        c.blue
      )} (${tone(daResult.migrationFormat, c.blue)})`
    );
    console.log(`${zonePrefix()} Confidence: ${colorConfidence(daResult.confidence)}`);
    console.log(daResult.preview);

    if (apply && confirmApply && daResult.applyPatches.length > 0) {
      const originalContents = await capturePatchOriginals(
        repoPath,
        daResult.applyPatches
      );
      console.log(`${zonePrefix()} ${tone("Applying migration files...", c.white)}`);
      const applyResult = await applyLlmPatches(daResult.applyPatches, repoPath);
      console.log(formatApplyLog("Applied", applyResult.applied));
      console.log(formatApplyLog("Failed", applyResult.failed));
      if (diff && applyResult.applied.length > 0) {
        renderDiffSummary(
          applyResult.applied.map((filePath) => {
            const patch = daResult.applyPatches.find((p) => p.filePath === filePath);
            return {
              filePath,
              original: originalContents[filePath] ?? "",
              updated: patch?.fullContent ?? "",
            };
          })
        );
      }
    }

    return 0;
  }

  if (role === "test_engineer") {
    console.log(
      `${zonePrefix()} ${tone(
        "Test Engineer role — delegating to test engineer flow...",
        c.white
      )}`
    );
    const teResult = await runTestEngineerFlow({ task, repoPath });

    if (!teResult.ok) {
      console.error(`[zone] Test engineer flow failed: ${teResult.reason}`);
      if (teResult.framework === "unknown") {
        console.error("[zone] No test framework detected in this repository.");
        console.error("[zone] Supported: playwright-ts, playwright-js, cypress, cucumber-java, selenium-java, testng, pytest");
      }
      return 1;
    }

    console.log(
      `${zonePrefix()} Framework detected: ${tone(
        teResult.framework,
        c.blue
      )} (${tone(teResult.language, c.blue)})`
    );
    console.log(`${zonePrefix()} Confidence: ${colorConfidence(teResult.confidence)}`);
    console.log(teResult.preview);

    if (apply && confirmApply && teResult.applyPatches.length > 0) {
      const originalContents = await capturePatchOriginals(
        repoPath,
        teResult.applyPatches
      );
      console.log(`${zonePrefix()} ${tone("Applying test files...", c.white)}`);
      const applyResult = await applyLlmPatches(teResult.applyPatches, repoPath);
      console.log(formatApplyLog("Applied", applyResult.applied));
      console.log(formatApplyLog("Failed", applyResult.failed));
      if (diff && applyResult.applied.length > 0) {
        renderDiffSummary(
          applyResult.applied.map((filePath) => {
            const patch = teResult.applyPatches.find((p) => p.filePath === filePath);
            return {
              filePath,
              original: originalContents[filePath] ?? "",
              updated: patch?.fullContent ?? "",
            };
          })
        );
      }
    }

    return 0;
  }

  console.log(
    `${zonePrefix()} ${tone("Intent unknown — delegating to LLM patch flow...", c.white)}`
  );
  const llmResult = await runLlmPatchFlow({ task, repoPath });
  if (llmResult.ok) {
    patchSection = llmResult.patchPreview;
    if (apply && confirmApply && llmResult.applyPatches.length > 0) {
      const originalContents =
        llmResult.originalContents ??
        (await capturePatchOriginals(repoPath, llmResult.applyPatches));
      console.log(`${zonePrefix()} ${tone("Applying LLM patches...", c.white)}`);
      const applyResult = await applyLlmPatches(llmResult.applyPatches, repoPath);
      console.log(formatApplyLog("Applied", applyResult.applied));
      console.log(formatApplyLog("Skipped", applyResult.skipped));
      console.log(formatApplyLog("Failed", applyResult.failed));
      if (diff && applyResult.applied.length > 0) {
        renderDiffSummary(
          applyResult.applied.map((filePath) => {
            const patch = llmResult.applyPatches.find((p) => p.filePath === filePath);
            return {
              filePath,
              original: originalContents[filePath] ?? "",
              updated: patch?.fullContent ?? "",
            };
          })
        );
      }
    }
  } else {
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
      console.log(
        "Status: skipped\nReason: Apply requested but not confirmed. Re-run with --confirm-apply."
      );
      console.log("");

      printVerbose(
        "execution",
        {
          traceId,
          ...tracker.build(),
        },
        verbose
      );

      return 0;
    }

    let patchPlan: PatchPlan | unknown;

    if (useGeneratedPatchPlan) {
      tracker.startPhase("validate_generated_patch_plan");
      const conversionCheck = canConvertGeneratedPlanToPatchPlan(generatedPlan);
      tracker.endPhase("validate_generated_patch_plan");

      if (!conversionCheck.canConvert) {
        console.log("Status: blocked");
        console.log("Reason: Generated patch plan conversion failed.");
        console.log(`Code: ${conversionCheck.code}`);
        console.log(`Details: ${conversionCheck.reason}`);
        console.log("");

        printVerbose("generatedPlan", generatedPlan, verbose);
        printVerbose("generatedPlan.conversionCheck", conversionCheck, verbose);
        printVerbose(
          "execution",
          {
            traceId,
            ...tracker.build(),
          },
          verbose
        );

        return 1;
      }

      tracker.startPhase("convert_generated_patch_plan");
      patchPlan = convertGeneratedPlanToPatchPlan(generatedPlan);
      tracker.endPhase("convert_generated_patch_plan");

      printVerbose("generatedPlan", generatedPlan, verbose);
      printVerbose("generatedPlan.patchPlan", patchPlan, verbose);
    } else {
      if (!patchPlanPath) {
        throw new Error(
          "Apply requested but no patch plan was provided. Use --patch-plan <file>."
        );
      }

      tracker.startPhase("load_patch_plan");
      patchPlan = loadPatchPlan(patchPlanPath);
      tracker.endPhase("load_patch_plan");
    }

    const patchEntries = Array.isArray((patchPlan as { patches?: unknown }).patches)
      ? ((patchPlan as { patches: Array<{ filePath: string; nextContent: string }> }).patches)
      : [];
    const originalContents =
      diff && patchEntries.length > 0
        ? await capturePatchOriginals(
            repoPath,
            patchEntries.map((patch) => ({ filePath: patch.filePath }))
          )
        : {};

    tracker.startPhase("run_apply_flow");
    const applyResult = await runApplyFlow({
      result,
      plan: patchPlan as never,
      request: {
        confirm: true,
      },
    });
    tracker.endPhase("run_apply_flow");

    console.log(renderApplyResult(applyResult));
    console.log("");

    if (diff && applyResult.applied && patchEntries.length > 0) {
      renderDiffSummary(
        patchEntries.map((patch) => ({
          filePath: patch.filePath,
          original: originalContents[patch.filePath] ?? "",
          updated: patch.nextContent,
        }))
      );
    }

    printVerbose("applyResult", applyResult, verbose);
    printVerbose(
      "execution",
      {
        traceId,
        ...tracker.build(),
      },
      verbose
    );

    if (audit || auditOut) {
      try {
        const engineInput = {
          riskScore: result.risk.score / 100,
          confidenceScore: result.decision.confidenceScore / 100,
          mode: result.decision.mode,
        };
        const engineResult = runDecisionEngine(engineInput);
        const snapshot = buildAuditSnapshot(engineInput, engineResult, {
          reasonCodes: result.reasonCodes,
        });

        if (audit) {
          printAuditSnapshot(snapshot);
        }

        if (auditOut) {
          writeAuditSnapshot(snapshot, auditOut);
        }
      } catch {
        // audit errors must never propagate
      }
    }

    return applyResult.applied ? 0 : 1;
  }

  printVerbose(
    "execution",
    {
      traceId,
      ...tracker.build(),
    },
    verbose
  );

  if (audit || auditOut) {
    try {
      const engineInput = {
        riskScore: result.risk.score / 100,
        confidenceScore: result.decision.confidenceScore / 100,
        mode: result.decision.mode,
      };
      const engineResult = runDecisionEngine(engineInput);
      const snapshot = buildAuditSnapshot(engineInput, engineResult, {
        reasonCodes: result.reasonCodes,
      });

      if (audit) {
        printAuditSnapshot(snapshot);
      }

      if (auditOut) {
        writeAuditSnapshot(snapshot, auditOut);
      }
    } catch {
      // audit errors must never propagate
    }
  }

  return 0;
}

export async function runCliWithOptions(options: CliOptions): Promise<number> {
  const tracker = new ExecutionTracker();
  const traceId = generateTraceId();

  tracker.startPhase("total");

  const verbose = Boolean(options.verbose);
  const auditReplayPath = resolveAuditReplayPath(options);
  const auditDiffPaths = resolveAuditDiffPaths(options);

  if (auditReplayPath) {
    printVerbose("cli.options", options, verbose);
    return runAuditReplayFlow(auditReplayPath);
  }

  if (options.auditDiff && !auditDiffPaths) {
    console.error(
      '[audit] Failed to diff snapshots: expected --audit-diff="<left.json,right.json>"'
    );
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
    await runFeatureAgent({
      task,
      targetPath: repoPath,
      mode,
      changedFiles,
    });
    tracker.endPhase("run_agent");

    tracker.startPhase("load_result");
    const savedResult = await loadSavedAgentResult(repoPath);
    tracker.endPhase("load_result");

    if (!savedResult) {
      throw new Error("Saved agent result could not be loaded after execution.");
    }

    tracker.startPhase("build_cli_view");
    const cliView = buildCliViewModel(savedResult);
    tracker.endPhase("build_cli_view");

    tracker.endPhase("total");

    savedResult.execution = {
      traceId,
      ...tracker.build(),
    };

    await writeJsonFile(resultPath, savedResult);

    console.log("");
    console.log(renderCliResult(cliView, format));
    console.log("");
    console.log(`Result saved: ${resultPath}`);

    if (audit || auditOut) {
      try {
        const engineInput = {
          riskScore: 0,
          confidenceScore: savedResult.decision.confidence / 100,
          mode: mapSavedModeToExecutionMode(savedResult.decision.mode),
        };
        const engineResult = runDecisionEngine(engineInput);
        const snapshot = buildAuditSnapshot(engineInput, engineResult);

        if (audit) {
          printAuditSnapshot(snapshot);
        }

        if (auditOut) {
          writeAuditSnapshot(snapshot, auditOut);
        }
      } catch {
        // audit errors must never propagate
      }
    }

    if (ciMode) {
      const ciEvaluation = evaluateCiResult(savedResult);

      printStatusLine(ciEvaluation.statusLine);
      printSummaryLine(ciEvaluation.summaryLine);

      if (verbose) {
        printVerbose("ciEvaluation", ciEvaluation, true);
      }

      return ciEvaluation.shouldFail ? 1 : 0;
    }

    return 0;
  } catch (error) {
    const message = formatErrorMessage(error);

    tracker.endPhase("total");

    if (taskOnly) {
      console.error("");
      console.error(`Task-only flow failed: ${message}`);
      console.error("");

      printVerbose(
        "execution",
        {
          traceId,
          ...tracker.build(),
        },
        verbose
      );

      return 1;
    }

    const errorResult = buildErrorResult(task, repoPath, message);

    errorResult.execution = {
      traceId,
      ...tracker.build(),
    };

    await writeJsonFile(resultPath, errorResult);

    if (ciMode) {
      const ciEvaluation = evaluateCiResult(errorResult);
      printStatusLine(ciEvaluation.statusLine);
      printSummaryLine(ciEvaluation.summaryLine);
      return 1;
    }

    const cliView = buildCliViewModel(errorResult);

    console.error("");
    console.error(renderCliResult(cliView, format));
    console.error("");
    console.error(`Result saved: ${resultPath}`);

    return 1;
  }
}

export async function run(): Promise<void> {
  const program = new Command();

  program
    .name("zone")
    .description(
      "Zone — AI Code Agent: deterministic, explainable, safe"
    )
    .option("--task <text>", "Task or change request to analyze")
    .option("--repo <path>", "Target repository path", process.cwd())
    .option("--ci", "Enable CI mode")
    .option("--verbose", "Enable verbose logs")
    .option("--trace", "Show decision trace in output")
    .option("--diff-aware", "Boost ranking using git diff context")
    .option("--diff", "Show colored diff of applied changes")
    .option("--task-only", "Run Sprint 7 task-only orchestration flow")
    .option("--apply", "Execute controlled apply flow after decision output")
    .option(
      "--confirm-apply",
      "Explicit confirmation required before apply"
    )
    .option("--patch-plan <path>", "Path to PatchPlan JSON file")
    .option(
      "--use-generated-patch-plan",
      "Generate a deterministic patch plan from the decision result and use it for apply if safely convertible"
    )
    .option(
      "--audit",
      "Print full audit snapshot as JSON to stdout (additive, no side effects)"
    )
    .option(
      "--audit-out <path>",
      "Write audit snapshot as JSON to a file (additive, independent of --audit)"
    )
    .option(
      "--audit-replay <path>",
      "Read and print an audit snapshot from disk"
    )
    .option(
      "--audit-diff <paths>",
      'Compare two audit snapshots: "<left.json,right.json>"'
    )
    .option("--mode <mode>", "Execution mode: preview | dry-run | apply", "preview")
    .option("--format <mode>", "CLI output format: summary | detailed | json", "summary")
    .option(
      "--output <path>",
      "Path for structured JSON result output",
      DEFAULT_RESULT_PATH
    )
      .option("--role <role>", "Agent role: developer | test_engineer | data_analyst")
    .allowExcessArguments(false)
    .parse(process.argv);

  const options = program.opts<CliOptions>();
  const exitCode = await runCliWithOptions(options);
  process.exit(exitCode);
}

if (process.env.VITEST !== "true") {
  void run();
}

async function readRepoFileContent(
  repoPath: string,
  filePath: string
): Promise<string> {
  try {
    return await fs.readFile(path.resolve(repoPath, filePath), "utf8");
  } catch {
    return "";
  }
}

async function capturePatchOriginals(
  repoPath: string,
  patches: Array<{ filePath: string }>
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    patches.map(async (patch) => [
      patch.filePath,
      await readRepoFileContent(repoPath, patch.filePath),
    ] as const)
  );

  return Object.fromEntries(entries);
}
