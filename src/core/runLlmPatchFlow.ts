import { scanRepo } from "../repo/scanRepo.js";
import { detectProjectStructure } from "../repo/detectProjectStructure.js";
import { rankRelevantFiles } from "../repo/rankRelevantFiles.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { planFeatureWithLlm } from "../llm/planFeature.js";
import { planPatchPreviewWithLlm } from "../llm/planPatchPreview.js";
import { planFullPatchWithLlm } from "../llm/planFullPatch.js";
import {
  generateExecutionPlan,
  type ExecutionPlan,
} from "../llm/executionPlan.js";
import { computeRiskScore } from "./computeRiskScore.js";
import {
  evaluatePlanAlignment,
  type PlanAlignmentResult,
} from "./evaluatePlanAlignment.js";
import { verifyPatch, type VerificationResult } from "./verifyPatch.js";
import { detectVerificationCommand } from "./detectVerificationCommand.js";
import {
  runRuntimeVerification,
  type RuntimeVerificationResult,
} from "./runRuntimeVerification.js";
import { buildRetryGuidanceFromFailure } from "./buildRetryGuidanceFromFailure.js";
import {
  detectIntentMismatch,
  type IntentMismatchReasonCode,
} from "../engine/intentMismatchDetector.js";
import {
  detectDesignSystemSignals,
  type DesignSystemSignals,
} from "../engine/designSystemSignals.js";
import { scorePatchQuality } from "../engine/patchQualityScorer.js";
import { resolveSafetyLevel } from "../engine/safetyLevelResolver.js";
import { enforceMicroEditProtection } from "../engine/microEditProtection.js";
import { parseTaskIntent, type TaskIntent } from "./taskIntentParser.js";
import type { ConversationBillingMode } from "../types/conversation.js";
import type { RepoFile } from "../types/project.js";
import { startZoneApiPerfRun } from "../api/zoneApiPerf.js";

export type LlmPatchFlowResult =
  | {
      ok: true;
      patchPreview: string;
      warnings: string[];
      developerConfidence?: number;
      developerRisk?: {
        score: number;
        breakdown: {
          destructive: number;
          schema: number;
          massScope: number;
        };
      };
      intentMismatch?: {
        hasMismatch: boolean;
        severity: "none" | "low" | "medium" | "high";
        reasonCodes: IntentMismatchReasonCode[];
        warnings: string[];
      };
      patchQuality?: {
        qualityScore: number;
        qualityWarnings: string[];
        patchSizeScore: number;
        structurePreservationScore: number;
        designSystemComplianceScore: number;
        semanticAlignmentScore: number;
      };
      designSystemSignals?: DesignSystemSignals;
      safetyResolution?: {
        safetyLevel:
          | "safe_auto_apply"
          | "safe_with_review"
          | "preview_only"
          | "high_risk_blocked";
        safetyReasons: string[];
        confidenceAdjusted?: number;
      };
      microEditProtection?: {
        isViolation: boolean;
        violationReasons: string[];
        shouldForcePreview: boolean;
        shouldDowngradeSafety: boolean;
      };
      reason?: string;
      decisionMode?: "preview_only" | "safe_to_apply" | "blocked";
      finalState?: "preview_only" | "safe_to_apply" | "blocked";
      finalExecutionOutcome?: "completed" | "completed_with_issues" | "failed_verification";
      finalVerificationFailure?: {
        status: RuntimeVerificationResult["status"];
        command?: string;
        summary: string;
        rootCause?: string;
        normalizedFailureReason?: string;
        incorrectAssumption?: string;
        requiredFix?: string;
        constraint?: string;
        scopeConstraint?: string;
      };
      attemptsUsed?: number;
      validationBlocked?: boolean;
      plan?: ExecutionPlan;
      planAlignment?: PlanAlignmentResult;
      verification?: VerificationResult;
      runtimeVerification?: RuntimeVerificationResult;
      targetFile?: string;
      applyPatches: Array<{ filePath: string; fullContent: string }>;
      patchResults: PatchResult[];
      fileDiffs?: FileDiff[];
      contextFiles?: string[];
    }
  | { ok: false; reason: string };

export type PatchResult = {
  filePath: string;
  status: "applied" | "skipped" | "failed";
  reason?: string;
};

export type DiffLine = {
  type: "added" | "removed" | "unchanged";
  content: string;
  lineNumber: number;
};

export type FileDiff = {
  filePath: string;
  diff: DiffLine[];
  addedLines: number;
  removedLines: number;
};

type HostedDeveloperContextInput = {
  repoSummary: string;
  projectNotes?: string[];
  existingFilesSummary: string;
  availableFiles: Array<{
    path: string;
    category: string;
    extension: string;
  }>;
  contextFiles: Array<{
    path: string;
    action: string;
    reason: string;
    content: string;
  }>;
  originalContents: Record<string, string>;
};

/** A fully-populated TaskIntent representing "I don't know what this is". */
const UNKNOWN_INTENT: TaskIntent = {
  rawTask: "",
  normalizedTask: "",
  action: "unknown",
  resourceKind: "unknown",
  scope: "unknown",
  mentionsNestedItem: false,
  destructiveRisk: false,
  routeHints: [],
  paramHints: [],
  warnings: [],
  codeIntent: "unknown",
};

const GENERIC_UI_SCAFFOLD_PATTERNS = [
  "welcome to my app",
  "get started",
  "features",
  "application dashboard",
];

const GENERIC_DOCUMENT_SCAFFOLD_PATTERNS = [
  "<title>document</title>",
  '<div id="app"></div>',
  "<div id=\"app\"></div>",
  "/path/to/your/script.js",
];

const CRITICAL_UI_ANCHORS = [
  "zone",
  "recent runs",
  "execute",
  "reset",
  "patch preview",
];

const DEVELOPER_VAGUE_TASK_WARNING =
  "[VAGUE_TASK] Task is too vague to generate a reliable patch. Please describe the specific file, function, and change needed.";
const ZONE_INTERNAL_TASK_WARNING =
  "[ZONE_INTERNAL_TASK] Task targets Zone itself, not the selected repo. Switch to the Zone codebase or clarify the intended target before patching.";

const DEVELOPER_GENERIC_TASK_PHRASES = new Set([
  "fix",
  "bug",
  "issue",
  "problem",
  "update",
  "change",
  "refactor",
  "improve",
]);

const DEVELOPER_GENERIC_TASK_TOKENS = new Set([
  "fix",
  "bug",
  "issue",
  "problem",
  "update",
  "change",
  "refactor",
  "improve",
]);

const VAGUE_COMBINATIONS = [
  /^(improve|update|fix|enhance|optimize|clean up|refactor)\s+(the\s+)?(dashboard|ui|app|page|layout|component|screen|design|interface)\.?$/i,
  /^make\s+(the\s+)?(dashboard|ui|app|page|layout|component|screen)\s+(better|cleaner|nicer|faster)\.?$/i,
];

const DEVELOPER_TASK_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "to",
  "of",
  "on",
  "in",
  "with",
  "and",
  "or",
  "this",
  "that",
  "please",
]);

const MICRO_EDIT_INTENT_TERMS = [
  "spacing",
  "padding",
  "margin",
  "gap",
  "alignment",
  "align",
  "typo",
  "wording",
  "label text",
  "label",
  "placeholder",
  "small css tweak",
];

const UI_MAPPING_RISK_TERMS = ["swap", "mapping", "reversed", "order", "before/after"];

const ZONE_INTERNAL_ZONE_TERMS = [
  "zone ui",
  "zone itself",
  "zone product",
  "zone thread ui",
  "zone execution ui",
  "zone inspect panel",
  "zone billing summary",
  "zone run-state",
  "zone run state",
  "zone developer flow",
];

const ZONE_INTERNAL_RUNTIME_TERMS = [
  "agentic developer flow",
  "run-state mapping",
  "preview_only",
  "files changed",
  "done result behavior",
  "hosted /api/patch",
  "/api/patch behavior",
  "recent runs",
  "patch preview",
  "inspect panel",
  "thread ui",
  "execution ui",
  "billing summary",
  "run-state",
  "run state",
  "developer flow",
];

const IRRELEVANT_DEVELOPER_CONTEXT_SEGMENTS = [
  "/.env",
  "/.gitignore",
  "/.idea/",
  "/.claude/",
  "/venv/",
  "/site-packages/",
  "/node_modules/",
  "/build/",
  "/dist/",
  "/.agent-cache/",
  "/.agent-patches/",
  "/.agent-backups/",
  "/agent-cache/",
  "/agent-patches/",
  "/agent-backups/",
];

function isUiFilePath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    normalized.endsWith(".html") ||
    normalized.endsWith(".tsx") ||
    normalized.endsWith(".jsx") ||
    normalized.includes("/ui/") ||
    normalized.includes("/components/") ||
    normalized.includes("/pages/")
  );
}

function isSmallUiPolishTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return [
    "ui",
    "polish",
    "readability",
    "spacing",
    "font",
    "style",
    "layout",
    "hierarchy",
    "align",
    "badge",
    "preview",
    "theme",
  ].some((term) => normalized.includes(term));
}

function isMicroEditUiTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return (
    isSmallUiPolishTask(task) &&
    [
      "spacing",
      "margin",
      "padding",
      "font-size",
      "font size",
      "line-height",
      "line height",
      "alignment",
      "align",
      "label",
      "text polish",
      "copy polish",
      "small",
    ].some((term) => normalized.includes(term))
  );
}

export function detectMicroEditIntent(task: string): boolean {
  const normalized = task.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  return MICRO_EDIT_INTENT_TERMS.some((term) => normalized.includes(term));
}

export function detectUiMappingRiskIntent(task: string): boolean {
  const normalized = task.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  return UI_MAPPING_RISK_TERMS.some((term) => normalized.includes(term));
}

export function isIrrelevantDeveloperContextPath(filePath: string): boolean {
  const normalized = `/${filePath.replace(/\\/g, "/").toLowerCase().replace(/^\/+/, "")}`;
  return IRRELEVANT_DEVELOPER_CONTEXT_SEGMENTS.some((segment) =>
    normalized.includes(segment)
  );
}

function isHostedEnvironment(): boolean {
  return (
    process.env.ZONE_INFERENCE_MODE === "hosted" ||
    Boolean(process.env.ZONE_API_BASE_URL)
  );
}

function extractStructureTokens(content: string): string[] {
  const tokens = new Set<string>();
  const regex = /\b(?:id|class)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(content)) !== null) {
    const parts = match[1]
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
    for (const part of parts) {
      tokens.add(part.toLowerCase());
    }
  }
  return [...tokens];
}

function normalizeUiContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

function countPreservedTokens(currentTokens: string[], nextTokens: string[]): number {
  return currentTokens.filter((token) => nextTokens.includes(token)).length;
}

function extractCriticalAnchors(content: string): string[] {
  const normalized = normalizeUiContent(content);
  return CRITICAL_UI_ANCHORS.filter((anchor) => normalized.includes(anchor));
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\t/g, "  ").trim();
}

function stripCommentsForComparison(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*#.*$/gm, "")
    .replace(/^\s*--.*$/gm, "")
    .trim();
}

function stripCommentOnlyLines(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*)/.test(line))
    .join("\n")
    .trim();
}

function countChangedLines(before: string, after: string): number {
  const diff = computeFileDiff(before, after);
  return diff.filter((line) => line.type !== "unchanged").length;
}

function countTotalLines(content: string): number {
  if (!content.trim()) return 0;
  return content.replace(/\r\n/g, "\n").split("\n").length;
}

function countPatternMatches(content: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => {
    const matches = content.match(pattern);
    return total + (matches?.length ?? 0);
  }, 0);
}

function detectExistingStructureTaskConstraints(task: string): {
  requiresExistingForm: boolean;
  requiresExistingSubmitFlow: boolean;
  requiresExistingState: boolean;
  avoidsNewForm: boolean;
  avoidsNewApiCall: boolean;
} {
  const normalizedTask = task.toLowerCase();

  return {
    requiresExistingForm:
      /\bexisting form\b/.test(normalizedTask) ||
      /\bcreate form\b/.test(normalizedTask) ||
      /\breuse existing form\b/.test(normalizedTask) ||
      /\bdo not create (?:a )?new form\b/.test(normalizedTask),
    requiresExistingSubmitFlow:
      /\bexisting submit flow\b/.test(normalizedTask) ||
      /\breuse existing submit flow\b/.test(normalizedTask) ||
      /\bsubmit flow\b/.test(normalizedTask),
    requiresExistingState:
      /\breuse (?:the )?existing state\b/.test(normalizedTask) ||
      /\bexisting state\b/.test(normalizedTask),
    avoidsNewForm: /\bdo not create (?:a )?new form\b/.test(normalizedTask),
    avoidsNewApiCall:
      /\bdo not introduce (?:a )?new api call\b/.test(normalizedTask) ||
      /\bdo not add (?:a )?new api call\b/.test(normalizedTask) ||
      /\bno new api call\b/.test(normalizedTask),
  };
}

function isConstrainedLocalizedPatchTask(task: string): boolean {
  const constraints = detectExistingStructureTaskConstraints(task);
  return (
    constraints.requiresExistingForm ||
    constraints.requiresExistingSubmitFlow ||
    constraints.requiresExistingState ||
    constraints.avoidsNewForm ||
    constraints.avoidsNewApiCall
  );
}

function scoreConstraintAwareContextFile(input: {
  task: string;
  content: string;
}): number {
  const constraints = detectExistingStructureTaskConstraints(input.task);
  if (
    !constraints.requiresExistingForm &&
    !constraints.requiresExistingSubmitFlow &&
    !constraints.requiresExistingState &&
    !constraints.avoidsNewForm &&
    !constraints.avoidsNewApiCall
  ) {
    return 0;
  }

  const content = input.content.toLowerCase();
  const hasFormStructure =
    countPatternMatches(content, [
      /<form\b/g,
      /\buseform\b/g,
      /\bformik\b/g,
      /\bformstate\b/g,
      /\bformvalues\b/g,
      /\bformdata\b/g,
    ]) > 0;
  const hasSubmitFlow =
    countPatternMatches(content, [
      /\bonsubmit\b/g,
      /\bhandlesubmit\b/g,
      /\bsubmit[a-z0-9_]*\s*\(/g,
      /\bsubmit[a-z0-9_]*\s*=/g,
      /type\s*=\s*["']submit["']/g,
      /\bpreventdefault\s*\(/g,
    ]) > 0;
  const hasStateHandling =
    countPatternMatches(content, [
      /\busestate\b/g,
      /\busereducer\b/g,
      /\bformstate\b/g,
      /\bset[a-z0-9_]+\s*\(/g,
    ]) > 0;
  const hasApiUsage =
    countPatternMatches(content, [
      /\bfetch\s*\(/g,
      /\baxios\./g,
      /\bapi\.(?:get|post|put|patch|delete)\s*\(/g,
      /\bclient\.(?:get|post|put|patch|delete)\s*\(/g,
      /\bmutate(?:async)?\s*\(/g,
    ]) > 0;

  let score = 0;

  if (constraints.requiresExistingForm) {
    score += hasFormStructure ? 26 : -18;
  }

  if (constraints.requiresExistingSubmitFlow) {
    score += hasSubmitFlow ? 20 : -14;
  }

  if (constraints.requiresExistingState) {
    score += hasStateHandling ? 16 : -10;
  }

  if (constraints.avoidsNewForm && !hasFormStructure) {
    score -= 12;
  }

  if (constraints.avoidsNewApiCall && hasSubmitFlow && hasApiUsage) {
    score += 8;
  }

  if (hasFormStructure && hasSubmitFlow && hasStateHandling) {
    score += 12;
  }

  return score;
}

const CONSTRAINT_ENTITY_LEAD_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "each",
  "every",
  "our",
  "your",
  "my",
  "their",
  "its",
  "existing",
  "new",
  "entire",
  "whole",
  "full",
  "same",
  "other",
  "unrelated",
  "any",
  "another",
  "generic",
  "current",
  "original",
  "given",
  "specified",
  "login",
  "sign",
  "up",
  "out",
  "home",
  "main",
  "landing",
  "error",
  "settings",
  "search",
  "create",
  "submit",
  "edit",
  "update",
  "delete",
  "filter",
  "sort",
  "select",
  "client",
  "server",
  "side",
  "web",
  "mobile",
  "add",
  "use",
  "using",
  "apply",
  "build",
  "make",
  "get",
  "set",
  "empty",
  "blank",
  "single",
  "multi",
  "related",
  "only",
  "first",
  "last",
  "next",
  "previous",
]);

function normalizeConstrainedTaskText(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, " ");
}

function extractConstrainedTaskEntityAnchors(normalizedTask: string): string[] {
  const patterns = [
    /\b([a-z][a-z0-9]+)\s+page\b/g,
    /\b([a-z][a-z0-9]+)\s+form\b/g,
    /\b([a-z][a-z0-9]+)\s+component\b/g,
    /\b([a-z][a-z0-9]+)\s+screen\b/g,
    /\b([a-z][a-z0-9]+)\s+view\b/g,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(normalizedTask)) !== null) {
      const word = match[1];
      if (word && !CONSTRAINT_ENTITY_LEAD_STOPWORDS.has(word)) {
        found.push(word);
      }
    }
  }
  return [...new Set(found)];
}

function escapeRegExpChars(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function anchorMatchesTargetFile(
  filePath: string,
  fileContent: string,
  anchor: string
): boolean {
  const pathLower = filePath.replace(/\\/g, "/").toLowerCase();
  const baseName = (pathLower.split("/").pop() ?? pathLower).replace(
    /\.[^/.]+$/,
    ""
  );
  const contentLower = fileContent.toLowerCase();
  const variants = new Set<string>([anchor]);
  if (anchor.length >= 4 && anchor.endsWith("s")) {
    variants.add(anchor.slice(0, -1));
  } else if (anchor.length >= 4 && !anchor.endsWith("s")) {
    variants.add(`${anchor}s`);
  }

  for (const term of variants) {
    if (term.length < 3) {
      continue;
    }
    if (pathLower.includes(term) || baseName.includes(term)) {
      return true;
    }
    if (term.length >= 4 && contentLower.includes(term)) {
      return true;
    }
    const boundary = new RegExp(
      `\\b${escapeRegExpChars(term)}s?\\b`,
      "i"
    );
    if (boundary.test(fileContent)) {
      return true;
    }
  }

  return false;
}

function targetMatchesConstrainedTaskEntities(input: {
  filePath: string;
  fileContent: string;
  anchors: string[];
}): boolean {
  if (input.anchors.length === 0) {
    return true;
  }
  return input.anchors.every((anchor) =>
    anchorMatchesTargetFile(input.filePath, input.fileContent, anchor)
  );
}

function assessConstrainedTargetEligibility(input: {
  task: string;
  filePath: string;
  fileContent: string;
}): {
  eligible: boolean;
  score: number;
  structureScore: number;
  entityMatch: boolean;
  reason: string;
} {
  const normalizedTask = normalizeConstrainedTaskText(input.task);
  const entityAnchors = extractConstrainedTaskEntityAnchors(normalizedTask);
  const structureScore = scoreConstraintAwareContextFile({
    task: input.task,
    content: input.fileContent,
  });
  const structureOk = structureScore >= 20;
  const entityMatch = targetMatchesConstrainedTaskEntities({
    filePath: input.filePath,
    fileContent: input.fileContent,
    anchors: entityAnchors,
  });

  if (!structureOk) {
    return {
      eligible: false,
      score: structureScore,
      structureScore,
      entityMatch,
      reason: "target_file_constraint_mismatch",
    };
  }

  if (!entityMatch) {
    return {
      eligible: false,
      score: structureScore,
      structureScore,
      entityMatch: false,
      reason: "target_entity_mismatch",
    };
  }

  return {
    eligible: true,
    score: structureScore,
    structureScore,
    entityMatch: true,
    reason: "constraint_structure_ok",
  };
}

function hasSensitiveLogging(content: string): boolean {
  const loggingCalls = [
    ...content.matchAll(
      /\b(?:console\.(?:log|info|debug|warn|error)|logger\.\w+)\s*\(([\s\S]*?)\)/gi
    ),
  ];

  return loggingCalls.some((match) =>
    /\b(password|secret|token|key|credential|credentials|auth|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)\b/i.test(
      match[1] ?? ""
    )
  );
}

function introducesNewEmptyCatch(
  originalContent: string,
  fullContent: string
): boolean {
  const emptyCatchPattern =
    /catch\s*(?:\(\s*[^)]*\s*\))?\s*\{\s*(?:(?:\/\*\s*ignored\s*\*\/)|(?:\/\/\s*ignored)|(?:\/\*\s*\*\/)|\s*)\}/gi;
  const originalMatches = originalContent.match(emptyCatchPattern)?.length ?? 0;
  const nextMatches = fullContent.match(emptyCatchPattern)?.length ?? 0;
  return nextMatches > originalMatches;
}

function removesValidationOrGuards(
  originalContent: string,
  fullContent: string,
  diffLines?: string[]
): boolean {
  const originalStripped = stripCommentsForComparison(originalContent)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  const fullStripped = stripCommentsForComparison(fullContent)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (originalStripped === fullStripped) {
    return false;
  }

  const originalWithoutComments = stripCommentsForComparison(originalContent);
  const nextWithoutComments = stripCommentsForComparison(fullContent);
  const patterns = [
    /\bvalidate[A-Za-z0-9_]*\b/g,
    /\bsanitize[A-Za-z0-9_]*\b/g,
    /\bassert[A-Za-z0-9_]*\b/g,
    /\bcheck[A-Za-z0-9_]*\b/g,
    /\bguard[A-Za-z0-9_]*\b/g,
    /\bthrow\s+new\s+Error\b/g,
    /\bif\s*\(!/g,
  ];

  if ((diffLines?.length ?? 0) > 0) {
    const removedLines = (diffLines ?? [])
      .filter((line) => line.startsWith("-") && !line.startsWith("--"))
      .map((line) => stripCommentsForComparison(line.slice(1)));

    return patterns.some((pattern) => {
      pattern.lastIndex = 0;
      const beforeCount = countPatternMatches(originalWithoutComments, [pattern]);
      pattern.lastIndex = 0;
      const afterCount = countPatternMatches(nextWithoutComments, [pattern]);
      pattern.lastIndex = 0;
      const removedByDiff = removedLines.some((line) => {
        pattern.lastIndex = 0;
        return pattern.test(line);
      });
      pattern.lastIndex = 0;
      return beforeCount > 0 && afterCount < beforeCount && removedByDiff;
    });
  }

  return patterns.some((pattern) => {
    const beforeCount = countPatternMatches(originalWithoutComments, [pattern]);
    const afterCount = countPatternMatches(nextWithoutComments, [pattern]);
    return beforeCount > 0 && afterCount < beforeCount;
  });
}

function weakensAuthChecks(originalContent: string, fullContent: string): boolean {
  const authPatterns = [
    /\bisAuthenticated\b/g,
    /\brequiresAuth\b/g,
    /@AuthGuard\b/g,
    /\bhasRole\b/g,
    /\bisAdmin\b/g,
  ];
  const bypassPatterns = [
    /\bif\s*\(\s*true\s*\)/g,
    /\breturn\s+true\s*;/g,
    /\bskip\s+auth\b/gi,
    /\bbypass\s+auth\b/gi,
  ];

  const originalWithoutComments = stripCommentsForComparison(originalContent);
  const nextWithoutComments = stripCommentsForComparison(fullContent);
  const removedAuthCheck = authPatterns.some((pattern) => {
    const beforeCount = countPatternMatches(originalWithoutComments, [pattern]);
    const afterCount = countPatternMatches(nextWithoutComments, [pattern]);
    return beforeCount > 0 && afterCount < beforeCount;
  });

  if (removedAuthCheck) {
    return true;
  }

  return bypassPatterns.some((pattern) => pattern.test(nextWithoutComments));
}

export function validateDeveloperOutput(input: {
  task: string;
  filePath: string;
  fullContent: string;
  originalContent: string;
  diffLines?: string[];
}): {
  blocked: boolean;
  warnings: string[];
  confidencePenalty: number;
} {
  const computedDiffLines = computeFileDiff(
    input.originalContent,
    input.fullContent
  ).map(
    (line) =>
      `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}${line.content}`
  );
  const totalRemovedLines = computedDiffLines.filter((l) =>
    l.startsWith("-")
  ).length;
  const totalAddedLines = computedDiffLines.filter((l) =>
    l.startsWith("+")
  ).length;
  const totalOriginalLines = input.originalContent.split("\n").length;
  const isFullFileRewrite =
    totalRemovedLines > totalOriginalLines * 0.5 &&
    totalAddedLines > totalOriginalLines * 0.3;
  const addedDiffLines = computedDiffLines
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
  const hasRemovedDiffLines = computedDiffLines.some((line) =>
    line.startsWith("-")
  );
  if (
    addedDiffLines.length > 0 &&
    !hasRemovedDiffLines &&
    addedDiffLines.every((line) => /^(?:\/\/|\/\*|\*)/.test(line))
  ) {
    return {
      blocked: false,
      warnings: [],
      confidencePenalty: 0,
    };
  }

  const warnings: string[] = [];
  let blocked = false;
  let confidencePenalty = 0;

  if (hasSensitiveLogging(input.fullContent)) {
    blocked = true;
    warnings.push(
      "[DEVELOPER_SECRET_LOGGING] Output logs sensitive data. Apply is disabled."
    );
  }

  if (
    !isFullFileRewrite &&
    removesValidationOrGuards(
      input.originalContent,
      input.fullContent,
      input.diffLines
    )
  ) {
    blocked = true;
    warnings.push(
      "[DEVELOPER_VALIDATION_REMOVAL] Output removes input validation or guards."
    );
  }

  if (
    !isFullFileRewrite &&
    weakensAuthChecks(input.originalContent, input.fullContent)
  ) {
    blocked = true;
    warnings.push(
      "[DEVELOPER_AUTH_WEAKENING] Output weakens authentication or authorization."
    );
  }

  if (introducesNewEmptyCatch(input.originalContent, input.fullContent)) {
    warnings.push(
      "[DEVELOPER_EMPTY_CATCH] Output introduces empty catch blocks."
    );
    confidencePenalty += 20;
  }

  const originalNormalized = normalizeWhitespace(input.originalContent);
  const nextNormalized = normalizeWhitespace(input.fullContent);
  const originalWithoutCommentLines = normalizeWhitespace(
    stripCommentOnlyLines(input.originalContent)
  );
  const nextWithoutCommentLines = normalizeWhitespace(
    stripCommentOnlyLines(input.fullContent)
  );
  const originalWithoutComments = normalizeWhitespace(
    stripCommentsForComparison(input.originalContent)
  );
  const nextWithoutComments = normalizeWhitespace(
    stripCommentsForComparison(input.fullContent)
  );
  if (
    originalWithoutCommentLines === nextWithoutCommentLines ||
    originalNormalized === nextNormalized ||
    originalWithoutComments === nextWithoutComments
  ) {
    warnings.push("[DEVELOPER_FILLER_PATCH] No meaningful changes detected.");
    confidencePenalty += 30;
  }

  const totalLines = countTotalLines(input.originalContent || input.fullContent);
  const changedLines = countChangedLines(input.originalContent, input.fullContent);
  if (totalLines > 50 && changedLines / Math.max(totalLines, 1) > 0.6) {
    warnings.push(
      "[DEVELOPER_MASS_CHANGE] Patch modifies more than 60% of the file."
    );
    confidencePenalty += 25;
  }

  return {
    blocked,
    warnings,
    confidencePenalty: Math.min(confidencePenalty, 100),
  };
}

export function isVagueDeveloperTask(task: string): boolean {
  const normalizedTask = task.trim().toLowerCase().replace(/\s+/g, " ");
  const words = normalizedTask.split(/\s+/).filter(Boolean);
  if (DEVELOPER_GENERIC_TASK_PHRASES.has(normalizedTask)) return true;
  if (VAGUE_COMBINATIONS.some((pattern) => pattern.test(task.trim()))) {
    return true;
  }

  const tokens = normalizedTask
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter(Boolean);

  if (
    tokens.length > 0 &&
    tokens.every(
      (token) =>
        DEVELOPER_GENERIC_TASK_TOKENS.has(token) ||
        DEVELOPER_TASK_STOPWORDS.has(token)
    )
  ) {
    return true;
  }

  const hasSpecificTarget = tokens.some(
    (token) =>
      token.length >= 3 &&
      !DEVELOPER_GENERIC_TASK_TOKENS.has(token) &&
      !DEVELOPER_TASK_STOPWORDS.has(token)
  );

  if (words.length < 4 && !hasSpecificTarget) {
    return true;
  }

  return !hasSpecificTarget;
}

function isHiddenDeveloperWarning(warning: string): boolean {
  return (
    warning.startsWith("[DEVELOPER_EMPTY_CATCH]") ||
    warning.startsWith("[DEVELOPER_FILLER_PATCH]") ||
    warning.startsWith("[DEVELOPER_MASS_CHANGE]")
  );
}

export function filterVisibleDeveloperWarnings(warnings: string[]): string[] {
  return warnings.filter((warning) => !isHiddenDeveloperWarning(warning));
}

function hasDeveloperWarning(
  warnings: string[],
  code:
    | "[DEVELOPER_EMPTY_CATCH]"
    | "[DEVELOPER_FILLER_PATCH]"
    | "[DEVELOPER_MASS_CHANGE]"
): boolean {
  return warnings.some((warning) => warning.startsWith(code));
}

export function calculateDeveloperConfidence(input: {
  baseConfidence?: number;
  warnings: string[];
  changedFileCount: number;
  changedFileMetrics: Array<{ totalLines: number; changedLines: number }>;
  vagueTask: boolean;
}): number {
  let totalPenalty = 0;

  if (hasDeveloperWarning(input.warnings, "[DEVELOPER_MASS_CHANGE]")) {
    totalPenalty += 10;
  }
  if (hasDeveloperWarning(input.warnings, "[DEVELOPER_EMPTY_CATCH]")) {
    totalPenalty += 10;
  }
  if (hasDeveloperWarning(input.warnings, "[DEVELOPER_FILLER_PATCH]")) {
    totalPenalty += 15;
  }

  for (const metric of input.changedFileMetrics) {
    if (
      metric.totalLines > 200 &&
      metric.changedLines / Math.max(metric.totalLines, 1) > 0.4
    ) {
      totalPenalty += 10;
    }
  }

  if (input.changedFileCount > 2) {
    totalPenalty += (input.changedFileCount - 2) * 5;
  }

  let confidence = Math.max(
    0,
    Math.min(input.baseConfidence ?? 95, 95 - totalPenalty)
  );

  if (input.vagueTask) {
    confidence = Math.min(confidence, 60);
  }

  return confidence;
}

export type DeveloperPatchScope = {
  changedFileCount: number;
  totalAddedLines: number;
  totalRemovedLines: number;
  totalChangedLines: number;
  rewriteLikeSuspicion: boolean;
  cssRewriteSuspicion: boolean;
};

type TaskRiskResult = ReturnType<typeof computeRiskScore>;

const REWRITE_SUSPICION_MIN_TOTAL_LINES = 20;
const REWRITE_SUSPICION_MIN_CHANGED_LINES = 20;

function logRiskDebug(label: string, payload: Record<string, unknown>): void {
  console.log(`[zone-debug] ${label}: ${JSON.stringify(payload)}`);
}

export function analyzePatchScope(input: {
  applyPatches: Array<{ filePath: string; fullContent: string }>;
  originalContents: Record<string, string>;
}): DeveloperPatchScope {
  let totalAddedLines = 0;
  let totalRemovedLines = 0;
  let rewriteLikeSuspicion = false;
  let cssRewriteSuspicion = false;

  for (const patch of input.applyPatches) {
    const before = input.originalContents[patch.filePath] ?? "";
    const diff = computeFileDiff(before, patch.fullContent);
    const addedLines = diff.filter((line) => line.type === "added").length;
    const removedLines = diff.filter((line) => line.type === "removed").length;
    const changedLines = addedLines + removedLines;
    const totalLines = countTotalLines(before || patch.fullContent);
    const changedRatio = changedLines / Math.max(totalLines, 1);

    totalAddedLines += addedLines;
    totalRemovedLines += removedLines;

    if (
      before.trim() &&
      totalLines >= REWRITE_SUSPICION_MIN_TOTAL_LINES &&
      changedLines >= REWRITE_SUSPICION_MIN_CHANGED_LINES &&
      changedRatio > 0.6
    ) {
      rewriteLikeSuspicion = true;
    }

    if (
      patch.filePath.toLowerCase().endsWith(".css") &&
      before.trim() &&
      totalLines > 0 &&
      (changedLines > 30 || changedRatio > 0.45)
    ) {
      cssRewriteSuspicion = true;
    }
  }

  return {
    changedFileCount: input.applyPatches.length,
    totalAddedLines,
    totalRemovedLines,
    totalChangedLines: totalAddedLines + totalRemovedLines,
    rewriteLikeSuspicion,
    cssRewriteSuspicion,
  };
}

function isSmallLocalizedPatchScope(patchScope: DeveloperPatchScope): boolean {
  return (
    patchScope.changedFileCount <= 1 &&
    patchScope.totalChangedLines <= 20 &&
    !patchScope.rewriteLikeSuspicion &&
    !patchScope.cssRewriteSuspicion
  );
}

function softenTaskRiskForLocalizedPatch(input: {
  taskRiskResult: TaskRiskResult;
  patchScope: DeveloperPatchScope;
}): TaskRiskResult {
  const { taskRiskResult, patchScope } = input;
  const nonCriticalSignals = taskRiskResult.signals.filter(
    (signal) => signal !== "critical_domain" && signal !== "low_risk"
  );

  if (
    !isSmallLocalizedPatchScope(patchScope) ||
    nonCriticalSignals.length > 0 ||
    !taskRiskResult.signals.includes("critical_domain")
  ) {
    return taskRiskResult;
  }

  return {
    ...taskRiskResult,
    score: Math.min(taskRiskResult.score, 20),
  };
}

function formatDeveloperRiskSignals(input: {
  breakdown: {
    destructive: number;
    schema: number;
    massScope: number;
  };
}): string[] {
  const signals: string[] = [];

  if (input.breakdown.destructive > 0) signals.push("destructive");
  if (input.breakdown.schema > 0) signals.push("schema");
  if (input.breakdown.massScope > 0) signals.push("mass_scope");

  return signals;
}

function syncDeveloperRiskWarnings(input: {
  warnings: string[];
  developerRisk: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      massScope: number;
    };
  };
}): string[] {
  const withoutTaskRiskWarnings = input.warnings.filter(
    (warning) =>
      !warning.startsWith("[HIGH_RISK] Task risk score") &&
      !warning.startsWith("[ELEVATED_RISK] Task risk score") &&
      !warning.startsWith("[HIGH_RISK] Risk signals detected:") &&
      !warning.startsWith("[ELEVATED_RISK] Risk signals detected:")
  );

  const riskSignals = formatDeveloperRiskSignals({
    breakdown: input.developerRisk.breakdown,
  });

  if (riskSignals.length === 0) {
    return withoutTaskRiskWarnings;
  }

  if (input.developerRisk.score >= 71) {
    return [
      ...withoutTaskRiskWarnings,
      `[HIGH_RISK] Risk signals detected: ${riskSignals.join(
        ", "
      )}. Review carefully before applying.`,
    ];
  }

  if (input.developerRisk.score >= 31) {
    return [
      ...withoutTaskRiskWarnings,
      `[ELEVATED_RISK] Risk signals detected: ${riskSignals.join(", ")}.`,
    ];
  }

  return withoutTaskRiskWarnings;
}

const SMALL_SAFE_PATCH_MAX_CHANGED_LINES = 20;
const SMALL_SAFE_PATCH_RISK_CAP = 25;

function qualifiesForSafePatchRiskCap(input: {
  developerRisk: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      massScope: number;
    };
  };
  patchScope: DeveloperPatchScope;
  hasIntentMismatch: boolean;
  hasMicroEditViolation: boolean;
  hasValidationBlock: boolean;
}): boolean {
  return (
    input.developerRisk.breakdown.destructive === 0 &&
    input.developerRisk.breakdown.schema === 0 &&
    input.developerRisk.breakdown.massScope === 0 &&
    input.patchScope.changedFileCount <= 1 &&
    input.patchScope.totalChangedLines <= SMALL_SAFE_PATCH_MAX_CHANGED_LINES &&
    !input.patchScope.rewriteLikeSuspicion &&
    !input.patchScope.cssRewriteSuspicion &&
    !input.hasIntentMismatch &&
    !input.hasMicroEditViolation &&
    !input.hasValidationBlock
  );
}

function applySafePatchRiskCap(input: {
  developerRisk: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      massScope: number;
    };
  };
  patchScope: DeveloperPatchScope;
  hasIntentMismatch: boolean;
  hasMicroEditViolation: boolean;
  hasValidationBlock: boolean;
}): number {
  if (!qualifiesForSafePatchRiskCap(input)) {
    return input.developerRisk.score;
  }

  return Math.min(input.developerRisk.score, SMALL_SAFE_PATCH_RISK_CAP);
}

function collectAddedPatchLines(input: {
  applyPatches: Array<{ filePath: string; fullContent: string }>;
  originalContents: Record<string, string>;
}): string[] {
  return input.applyPatches.flatMap((patch) => {
    const before = input.originalContents[patch.filePath] ?? "";
    return computeFileDiff(before, patch.fullContent)
      .filter((line) => line.type === "added")
      .map((line) => line.content);
  });
}

export function evaluateIntentPatchMismatch(input: {
  task: string;
  patchScope: DeveloperPatchScope;
}): {
  suspicious: boolean;
  confidenceCap?: number;
  warnings: string[];
  risk: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      massScope: number;
      };
    };
  } {
  const mismatch = detectIntentMismatch({
    taskIntent: detectMicroEditIntent(input.task) ? "micro_edit" : "standard",
    patchScope: input.patchScope,
  });

  if (!mismatch.hasMismatch) {
      return {
        suspicious: false,
        warnings: [],
      risk: {
        score: 0,
        breakdown: {
          destructive: 0,
          schema: 0,
          massScope: 0,
        },
        },
      };
    }

    let massScope = 35;
    if (input.patchScope.changedFileCount > 1) {
    massScope = Math.max(massScope, 45);
  }
  if (input.patchScope.totalChangedLines > 30) {
    massScope = Math.max(massScope, 55);
  }
  if (input.patchScope.cssRewriteSuspicion) {
    massScope = Math.max(massScope, 60);
  }
  if (input.patchScope.rewriteLikeSuspicion) {
      massScope = Math.max(massScope, 65);
    }

    return {
      suspicious: true,
      confidenceCap: mismatch.confidenceCap,
      warnings: mismatch.warnings,
      risk: {
        score: massScope,
        breakdown: {
        destructive: 0,
        schema: 0,
        massScope,
      },
    },
  };
}

export function evaluateUiMappingRisk(input: {
  task: string;
  patchScope: DeveloperPatchScope;
}): {
  applies: boolean;
  confidenceCap?: number;
  forcePreviewOnly: boolean;
  warnings: string[];
  risk: {
    score: number;
    breakdown: {
      destructive: number;
      schema: number;
      massScope: number;
    };
  };
} {
  if (!detectUiMappingRiskIntent(input.task)) {
    return {
      applies: false,
      forcePreviewOnly: false,
      warnings: [],
      risk: {
        score: 0,
        breakdown: {
          destructive: 0,
          schema: 0,
          massScope: 0,
        },
      },
    };
  }

  const massScope =
    input.patchScope.changedFileCount > 1 ||
    input.patchScope.totalChangedLines > 40 ||
    input.patchScope.rewriteLikeSuspicion
      ? 45
      : 25;

  return {
    applies: true,
    confidenceCap: 70,
    forcePreviewOnly: massScope >= 40,
    warnings: [
      "UI mapping/order changes are higher-risk and should be reviewed carefully.",
    ],
    risk: {
      score: massScope,
      breakdown: {
        destructive: 0,
        schema: 0,
        massScope,
      },
    },
  };
}

export function normalizeLineForMatch(line: string): string {
  return line.replace(/\t/g, "  ").replace(/\s+/g, " ").trim();
}

function buildTrigrams(value: string): string[] {
  if (value.length < 3) {
    return value ? [value] : [];
  }

  const trigrams: string[] = [];
  for (let i = 0; i <= value.length - 3; i += 1) {
    trigrams.push(value.slice(i, i + 3));
  }
  return trigrams;
}

export function scoreLineSimilarity(a: string, b: string): number {
  const left = normalizeLineForMatch(a);
  const right = normalizeLineForMatch(b);

  if (!left && !right) {
    return 1;
  }

  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  if (left.includes(right) || right.includes(left)) {
    return 0.9;
  }

  const leftTrigrams = buildTrigrams(left);
  const rightTrigrams = buildTrigrams(right);

  if (leftTrigrams.length === 0 || rightTrigrams.length === 0) {
    return 0;
  }

  const rightCounts = new Map<string, number>();
  for (const trigram of rightTrigrams) {
    rightCounts.set(trigram, (rightCounts.get(trigram) ?? 0) + 1);
  }

  let intersection = 0;
  for (const trigram of leftTrigrams) {
    const count = rightCounts.get(trigram) ?? 0;
    if (count > 0) {
      intersection += 1;
      rightCounts.set(trigram, count - 1);
    }
  }

  const score = (2 * intersection) / (leftTrigrams.length + rightTrigrams.length);
  return Math.max(0, score);
}

type FuzzyReplaceResult =
  | {
      success: true;
      content: string;
      score: number;
      bestMatch: string;
    }
  | {
      success: false;
      reason: "low_confidence";
      score: number;
      bestMatch: string;
    };

function buildLineFrequencyMap(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function scoreLineOverlap(targetLines: string[], candidateLines: string[]): number {
  const targetCounts = buildLineFrequencyMap(targetLines);
  const candidateCounts = buildLineFrequencyMap(candidateLines);
  let overlap = 0;

  for (const [line, targetCount] of targetCounts.entries()) {
    overlap += Math.min(targetCount, candidateCounts.get(line) ?? 0);
  }

  return overlap / Math.max(targetLines.length, candidateLines.length, 1);
}

export function scoreOrderedSimilarity(
  targetLines: string[],
  candidateLines: string[]
): number {
  let bestRatio = 0;

  for (let offset = -3; offset <= 3; offset += 1) {
    let matches = 0;

    for (let i = 0; i < targetLines.length; i += 1) {
      const candidateIndex = i + offset;
      if (candidateIndex < 0 || candidateIndex >= candidateLines.length) {
        continue;
      }

      matches += scoreLineSimilarity(targetLines[i], candidateLines[candidateIndex]);
    }

    const ratio = matches / Math.max(targetLines.length, candidateLines.length, 1);
    if (ratio > bestRatio) {
      bestRatio = ratio;
    }
  }

  return bestRatio;
}

export function scoreCandidateMatch(
  targetLines: string[],
  candidateLines: string[]
): number {
  if (targetLines.length === 0 && candidateLines.length === 0) {
    return 100;
  }

  const orderedScore = scoreOrderedSimilarity(targetLines, candidateLines);
  const overlapScore = scoreLineOverlap(targetLines, candidateLines);
  const lengthPenalty = Math.min(
    Math.abs(targetLines.length - candidateLines.length) * 4,
    12
  );

  return Math.min(
    100,
    Math.max(
      0,
      Math.round(orderedScore * 70 + overlapScore * 30 - lengthPenalty)
    )
  );
}

function buildMicroEditSnippet(filePath: string, content: string, task: string): string {
  if (!content.trim()) return content;

  const lines = content.split("\n");
  const cssTerms = task.match(/[.#]?[\w-]+(?:\s*\{)?/g) || [];
  const colorTerms = task.match(/#[0-9a-fA-F]{3,6}/g) || [];
  const classTerms = task.match(/[\w-]+-btn|[\w-]+-badge|[\w-]+-bar/g) || [];

  const searchTerms = [
    ...new Set(
      [
        ...cssTerms.map((term) => term.replace(/[{}]/g, "").trim()),
        ...colorTerms,
        ...classTerms,
      ].filter((term) => term.length > 2)
    ),
  ];

  let bestLine = -1;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    const score = searchTerms.filter((term) =>
      lineLower.includes(term.toLowerCase())
    ).length;
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  if (bestLine === -1) {
    return lines.slice(0, 30).join("\n");
  }

  const start = Math.max(0, bestLine - 10);
  const end = Math.min(lines.length, bestLine + 11);

  return [
    `// === SNIPPET: ${filePath} lines ${start + 1}-${end} of ${lines.length} ===`,
    ...lines.slice(start, end),
    "// === END SNIPPET ===",
  ].join("\n");
}

type ContextAnchor = {
  lineIndex: number;
  score: number;
};

function isAnchorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  return /^(import\s|const\s+\w+\s*=\s*require\(|.*\sfrom\s+["']|export\s|class\s|interface\s|enum\s|struct\s|async function\s|function\s|def\s|fun\s|\s*(public|private|protected)\s+[\w<>\[\],\s]+\()/.test(
    trimmed
  );
}

function countTaskOverlap(taskWords: string[], line: string): number {
  const normalizedLine = line.toLowerCase();
  return taskWords.filter((word) => normalizedLine.includes(word)).length;
}

export function smartContextWindow(input: {
  fileContent: string;
  task: string;
  maxChars?: number;
}): {
  snippet: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  isTruncated: boolean;
} {
  const maxChars = input.maxChars ?? 6000;
  const lines = input.fileContent.split("\n");
  const totalLines = lines.length;

  if (input.fileContent.length <= maxChars) {
    return {
      snippet: input.fileContent,
      startLine: 1,
      endLine: totalLines,
      totalLines,
      isTruncated: false,
    };
  }

  const taskWords = [...new Set(
    input.task
      .toLowerCase()
      .split(/[^a-z0-9_#.-]+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3)
  )];

  const anchorIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => isAnchorLine(line))
    .map(({ index }) => index);

  const indexes = anchorIndexes.length > 0 ? anchorIndexes : [0];
  const anchors: ContextAnchor[] = indexes.map((lineIndex) => ({
    lineIndex,
    score: countTaskOverlap(taskWords, lines[lineIndex]),
  }));

  let centerAnchorIndex = 0;
  for (let i = 1; i < anchors.length; i += 1) {
    if (
      anchors[i].score > anchors[centerAnchorIndex].score ||
      (anchors[i].score === anchors[centerAnchorIndex].score &&
        anchors[i].lineIndex < anchors[centerAnchorIndex].lineIndex)
    ) {
      centerAnchorIndex = i;
    }
  }

  const blockRanges = indexes.map((lineIndex, index) => ({
    start: lineIndex,
    end: (indexes[index + 1] ?? totalLines) - 1,
  }));

  let left = centerAnchorIndex;
  let right = centerAnchorIndex;

  const buildSnippet = (startBlock: number, endBlock: number) => {
    const firstTenEnd = Math.min(10, totalLines);
    const mainStart = blockRanges[startBlock].start;
    const mainEnd = blockRanges[endBlock].end + 1;

    const selectedLines = [
      ...lines.slice(0, firstTenEnd),
      ...(mainStart < firstTenEnd ? lines.slice(firstTenEnd, mainEnd) : lines.slice(mainStart, mainEnd)),
    ];

    const startLine = 1;
    const endLine =
      mainStart < firstTenEnd ? mainEnd : Math.max(firstTenEnd, mainEnd);

    return {
      snippet: selectedLines.join("\n"),
      startLine,
      endLine,
    };
  };

  let window = buildSnippet(left, right);

  while (window.snippet.length < maxChars) {
    const canExpandLeft = left > 0;
    const canExpandRight = right < blockRanges.length - 1;

    if (!canExpandLeft && !canExpandRight) {
      break;
    }

    const nextLeftSize = canExpandLeft
      ? buildSnippet(left - 1, right).snippet.length
      : Number.POSITIVE_INFINITY;
    const nextRightSize = canExpandRight
      ? buildSnippet(left, right + 1).snippet.length
      : Number.POSITIVE_INFINITY;

    if (nextLeftSize <= maxChars && nextLeftSize <= nextRightSize) {
      left -= 1;
      window = buildSnippet(left, right);
      continue;
    }

    if (nextRightSize <= maxChars) {
      right += 1;
      window = buildSnippet(left, right);
      continue;
    }

    break;
  }

  return {
    snippet: window.snippet,
    startLine: window.startLine,
    endLine: window.endLine,
    totalLines,
    isTruncated: true,
  };
}

export function computeFileDiff(before: string, after: string): DiffLine[] {
  const beforeLines = before === "" ? [] : before.split("\n");
  const afterLines = after === "" ? [] : after.split("\n");
  const rows = beforeLines.length + 1;
  const cols = afterLines.length + 1;
  const lcs = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      if (beforeLines[i] === afterLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      diff.push({
        type: "unchanged",
        content: afterLines[j],
        lineNumber: j + 1,
      });
      i += 1;
      j += 1;
      continue;
    }

    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      diff.push({
        type: "removed",
        content: beforeLines[i],
        lineNumber: Math.min(j + 1, afterLines.length + 1),
      });
      i += 1;
      continue;
    }

    diff.push({
      type: "added",
      content: afterLines[j],
      lineNumber: j + 1,
    });
    j += 1;
  }

  while (i < beforeLines.length) {
    diff.push({
      type: "removed",
      content: beforeLines[i],
      lineNumber: Math.min(j + 1, afterLines.length + 1),
    });
    i += 1;
  }

  while (j < afterLines.length) {
    diff.push({
      type: "added",
      content: afterLines[j],
      lineNumber: j + 1,
    });
    j += 1;
  }

  return diff;
}

export function fuzzyFindAndReplace(
  content: string,
  find: string,
  replace: string
): FuzzyReplaceResult {
  if (content.includes(find)) {
    return {
      success: true,
      content: content.replace(find, replace),
      score: 100,
      bestMatch: find,
    };
  }

  const contentLines = content.replace(/\r\n/g, "\n").split("\n");
  const targetLinesRaw = find.replace(/\r\n/g, "\n").split("\n");
  const targetLines = targetLinesRaw.map(normalizeLineForMatch).filter(Boolean);

  if (targetLines.length === 0) {
    return {
      success: false,
      reason: "low_confidence",
      score: 0,
      bestMatch: "",
    };
  }

  let bestCandidate:
    | {
        start: number;
        length: number;
        score: number;
        bestMatch: string;
      }
    | undefined;

  const minWindow = Math.max(1, targetLines.length - 3);
  const maxWindow = Math.min(contentLines.length, targetLines.length + 3);

  for (let windowSize = minWindow; windowSize <= maxWindow; windowSize += 1) {
    for (let start = 0; start <= contentLines.length - windowSize; start += 1) {
      const rawSlice = contentLines.slice(start, start + windowSize);
      const normalizedSlice = rawSlice.map(normalizeLineForMatch).filter(Boolean);
      if (normalizedSlice.length === 0) {
        continue;
      }

      const score = scoreCandidateMatch(targetLines, normalizedSlice);
      if (!bestCandidate || score > bestCandidate.score) {
        bestCandidate = {
          start,
          length: windowSize,
          score,
          bestMatch: rawSlice.join("\n"),
        };
      }
    }
  }

  if (!bestCandidate || bestCandidate.score < 80) {
    return {
      success: false,
      reason: "low_confidence",
      score: bestCandidate?.score ?? 0,
      bestMatch: bestCandidate?.bestMatch ?? "",
    };
  }

  const replaceLines = replace.replace(/\r\n/g, "\n").split("\n");
  const updatedLines = [
    ...contentLines.slice(0, bestCandidate.start),
    ...replaceLines,
    ...contentLines.slice(bestCandidate.start + bestCandidate.length),
  ];

  return {
    success: true,
    content: updatedLines.join("\n"),
    score: bestCandidate.score,
    bestMatch: bestCandidate.bestMatch,
  };
}

interface ParsedDeveloperPatch {
  filePath: string;
  edits: Array<{ find: string; replace: string }>;
  createContent?: string;
  noChangeNeeded?: boolean;
}

export function detectZoneInternalTask(task: string): boolean {
  const normalized = task.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  if (ZONE_INTERNAL_ZONE_TERMS.some((term) => normalized.includes(term))) {
    return true;
  }

  if (!/\bzone\b/i.test(normalized)) {
    return false;
  }

  return ZONE_INTERNAL_RUNTIME_TERMS.some((term) => normalized.includes(term));
}

function stripPatchTextFences(rawPatchText: string): string {
  return rawPatchText
    .replace(/^```(?:text|txt|patch)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseFindReplacePatch(rawPatchText: string): {
  find: string;
  replace: string;
} | null {
  const match = rawPatchText.match(
    /--- FIND ---\s*\n([\s\S]*?)\n--- REPLACE ---\s*\n([\s\S]*)$/i
  );
  if (!match) return null;

  return {
    find: match[1],
    replace: match[2],
  };
}

function parseDeveloperPatchText(rawPatchText: string): ParsedDeveloperPatch | null {
  const normalizedPatchText = stripPatchTextFences(rawPatchText);
  if (normalizedPatchText === "NO_CHANGE_NEEDED") {
    return {
      filePath: "",
      edits: [],
      noChangeNeeded: true,
    };
  }

  const barePatch = parseFindReplacePatch(normalizedPatchText);
  if (barePatch) {
    return {
      filePath: "",
      edits: [barePatch],
    };
  }

  const match = normalizedPatchText.match(
    /--- FILE:\s*(.+?)\s*---\s*([\s\S]*)$/i
  );
  if (!match) return null;

  const filePath = match[1].trim();
  const body = match[2].trim();

  const createMatch = body.match(/^CREATE:\s*\n?([\s\S]*)$/i);
  if (createMatch) {
    return {
      filePath,
      edits: [],
      createContent: createMatch[1],
    };
  }

  const edits: Array<{ find: string; replace: string }> = [];
  const editRegex =
    /FIND:\s*\n([\s\S]*?)\nREPLACE:\s*\n([\s\S]*?)(?=\nFIND:\s*\n|$)/gi;
  let editMatch: RegExpExecArray | null = null;

  while ((editMatch = editRegex.exec(body)) !== null) {
    edits.push({
      find: editMatch[1],
      replace: editMatch[2],
    });
  }

  return edits.length > 0 ? { filePath, edits } : null;
}

function applyDeveloperPatchText(
  currentContent: string,
  rawPatchText: string
): { ok: true; fullContent: string } | { ok: false; warning: string } {
  const parsed = parseDeveloperPatchText(rawPatchText);
  if (!parsed) {
    return {
      ok: false,
      warning:
        "[DEVELOPER_PATCH_FORMAT] Model did not return a valid patch-style edit format.",
    };
  }

  if (parsed.createContent !== undefined) {
    if (currentContent.trim()) {
      return {
        ok: false,
        warning:
          "[DEVELOPER_PATCH_FORMAT] CREATE blocks are not allowed for existing files.",
      };
    }
    return { ok: true, fullContent: parsed.createContent };
  }

  if (parsed.noChangeNeeded) {
    return { ok: true, fullContent: currentContent };
  }

  let updatedContent = currentContent;
  for (const edit of parsed.edits) {
    if (!edit.find.trim()) {
      return {
        ok: false,
        warning:
          "[DEVELOPER_PATCH_FORMAT] FIND blocks must target an existing non-empty block.",
      };
    }
    const nextContent = fuzzyFindAndReplace(
      updatedContent,
      edit.find,
      edit.replace
    );
    if (!nextContent.success) {
      return {
        ok: false,
        warning:
          "[PATCH_FIND_NOT_FOUND] " +
          JSON.stringify({
            success: false,
            reason: nextContent.reason,
            score: nextContent.score,
            bestMatch: nextContent.bestMatch,
          }),
      };
    }
    updatedContent = nextContent.content;
  }

  return { ok: true, fullContent: updatedContent };
}

const SAFE_PREVIEW_REUSE_MAX_CHARS = 4000;

function canReusePatchPreviewAsFinalPatch(input: {
  patchCount: number;
  contentPreview: string;
  taskRiskResult: TaskRiskResult;
}): boolean {
  return (
    input.patchCount === 1 &&
    input.taskRiskResult.score === 0 &&
    input.taskRiskResult.breakdown.destructive === 0 &&
    input.taskRiskResult.breakdown.schema === 0 &&
    input.taskRiskResult.breakdown.massScope === 0 &&
    input.contentPreview.trim().length > 0 &&
    input.contentPreview.length <= SAFE_PREVIEW_REUSE_MAX_CHARS
  );
}

function buildApplyPatchFromPreview(input: {
  patch: { operation: "create" | "modify"; contentPreview: string };
  currentContent: string;
}): { ok: true; fullContent: string } | { ok: false } {
  if (input.patch.operation === "create" && !input.currentContent.trim()) {
    return {
      ok: true,
      fullContent: input.patch.contentPreview,
    };
  }

  const applied = applyDeveloperPatchText(
    input.currentContent,
    input.patch.contentPreview
  );
  if (!applied.ok) {
    return { ok: false };
  }

  return applied;
}

function detectSuspiciousUiOverwrite(input: {
  task: string;
  filePath: string;
  currentContent: string;
  nextContent: string;
}): string | null {
  if (!isUiFilePath(input.filePath)) return null;
  if (!input.currentContent.trim()) return null;
  if (!isSmallUiPolishTask(input.task)) return null;

  const currentContentNormalized = normalizeUiContent(input.currentContent);
  const nextContentLower = normalizeUiContent(input.nextContent);
  const hasGenericScaffold = GENERIC_UI_SCAFFOLD_PATTERNS.some((pattern) =>
    nextContentLower.includes(pattern)
  );
  const hasGenericDocumentScaffold = GENERIC_DOCUMENT_SCAFFOLD_PATTERNS.some(
    (pattern) => nextContentLower.includes(pattern)
  );
  const introducesFullDocumentSkeleton =
    nextContentLower.includes("<!doctype html") ||
    (nextContentLower.includes("<html") &&
      nextContentLower.includes("<head") &&
      nextContentLower.includes("<body"));
  const currentHasFullDocumentSkeleton =
    currentContentNormalized.includes("<!doctype html") ||
    (currentContentNormalized.includes("<html") &&
      currentContentNormalized.includes("<head") &&
      currentContentNormalized.includes("<body"));

  const currentTokens = extractStructureTokens(input.currentContent);
  const nextTokens = extractStructureTokens(input.nextContent);
  const preservedTokenCount = countPreservedTokens(currentTokens, nextTokens);
  const preservedRatio =
    currentTokens.length > 0 ? preservedTokenCount / currentTokens.length : 1;
  const currentAnchors = extractCriticalAnchors(input.currentContent);
  const preservedAnchorCount = currentAnchors.filter((anchor) =>
    nextContentLower.includes(anchor)
  ).length;
  const preservedAnchorRatio =
    currentAnchors.length > 0 ? preservedAnchorCount / currentAnchors.length : 1;
  const replacementRatio =
    input.currentContent.length > 0
      ? input.nextContent.length / input.currentContent.length
      : 1;
  const broadMarkupRewrite =
    currentContentNormalized.includes("<") &&
    nextContentLower.includes("<") &&
    (replacementRatio > 1.6 || replacementRatio < 0.6);

  if (hasGenericScaffold && preservedRatio < 0.35) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} looks like a generic UI scaffold overwrite instead of a small in-place update.`;
  }

  if (
    hasGenericDocumentScaffold &&
    (!currentHasFullDocumentSkeleton || preservedAnchorRatio < 0.75)
  ) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} looks like a generic document skeleton instead of a small in-place UI update.`;
  }

  if (
    introducesFullDocumentSkeleton &&
    !currentHasFullDocumentSkeleton &&
    (preservedRatio < 0.75 || preservedAnchorRatio < 1)
  ) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} introduces a new full-document UI skeleton for a small UI task.`;
  }

  if (currentAnchors.length >= 3 && preservedAnchorRatio < 0.5) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} removes critical existing UI anchors for a small UI task.`;
  }

  if (
    broadMarkupRewrite &&
    (preservedRatio < 0.55 || preservedAnchorRatio < 0.75)
  ) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} looks like a broad markup replacement for a small UI task instead of a localized polish edit.`;
  }

  if (currentTokens.length >= 5 && preservedRatio < 0.2) {
    return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} removes most existing UI structure identifiers/classes for a small UI task.`;
  }

  return null;
}

function parsePatchFailureWarning(
  warning: string
): {
  reason: string;
  score?: number;
  bestMatch?: string;
  normalizedFailureReason?: string;
} {
  if (warning.startsWith("[PATCH_FIND_NOT_FOUND] ")) {
    try {
      const payload = JSON.parse(
        warning.slice("[PATCH_FIND_NOT_FOUND] ".length)
      ) as {
        reason?: string;
        score?: number;
        bestMatch?: string;
      };

      return {
        reason: "patch_find_not_found",
        score: payload.score,
        bestMatch: payload.bestMatch,
        normalizedFailureReason:
          normalizePatchOutcomeReason(payload.reason) ?? undefined,
      };
    } catch {
      return { reason: "patch_find_not_found" };
    }
  }

  if (warning.startsWith("[DEVELOPER_PATCH_FORMAT]")) {
    return { reason: "invalid_patch_format" };
  }

  return { reason: "warning" };
}

function buildPatchConflictWarning(input: {
  filePath: string;
  reason: string;
  score?: number;
  bestMatch?: string;
}): string {
  return `[PATCH_CONFLICT] ${JSON.stringify({
    filePath: input.filePath,
    status: "failed",
    reason: input.reason,
    ...(typeof input.score === "number" ? { score: input.score } : {}),
    ...(typeof input.bestMatch === "string" ? { bestMatch: input.bestMatch } : {}),
  })}`;
}

function logPatchConversionDebug(input: {
  filePath: string;
  chosenOutputMode: "full_content" | "find_replace_patch";
  responseMode: "full_content" | "patch";
  status: "applied" | "failed";
  failureReason?: string;
  normalizedFailureReason?: string;
}): void {
  if (input.status === "applied" && input.responseMode === "full_content") {
    return;
  }

  console.log(
    "[zone-patch-conversion]",
    JSON.stringify({
      filePath: input.filePath,
      chosenOutputMode: input.chosenOutputMode,
      responseMode: input.responseMode,
      status: input.status,
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      ...(input.normalizedFailureReason
        ? { normalizedFailureReason: input.normalizedFailureReason }
        : {}),
    })
  );
}

function normalizePatchOutcomeReason(reason: string | undefined): string | null {
  const normalized = String(reason ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || null;
}

function deriveNoCodeChangeReason(patchResults: PatchResult[]): string {
  const failedReason = patchResults.find(
    (result) => result.status === "failed" && result.reason
  )?.reason;
  const skippedReason = patchResults.find(
    (result) => result.status === "skipped" && result.reason
  )?.reason;
  const normalizedFailedReason = normalizePatchOutcomeReason(failedReason);

  return (
    (normalizedFailedReason === "warning"
      ? "patch_conversion_failed"
      : normalizedFailedReason) ??
    normalizePatchOutcomeReason(skippedReason) ??
    "no_code_change_produced"
  );
}

function renderPatchResultLine(result: PatchResult, warnings: string[]): string {
  if (result.status === "applied") {
    return `✓ ${result.filePath}        applied`;
  }

  if (result.status === "skipped") {
    return `~ ${result.filePath}        skipped (${result.reason ?? "skipped"})`;
  }

  const conflictWarning = warnings.find(
    (warning) =>
      warning.startsWith("[PATCH_CONFLICT] ") &&
      warning.includes(`"filePath":"${result.filePath}"`)
  );

  let details = result.reason ?? "failed";
  if (conflictWarning) {
    try {
      const payload = JSON.parse(
        conflictWarning.slice("[PATCH_CONFLICT] ".length)
      ) as { reason?: string; score?: number };
      details = payload.reason ?? details;
      if (typeof payload.score === "number") {
        details += `, score: ${payload.score}`;
      }
    } catch {
      // keep best-effort summary rendering stable
    }
  }

  return `✗ ${result.filePath}        failed (${details})`;
}

export async function runLlmPatchFlow(input: {
  task: string;
  repoPath: string;
  atomicPatch?: boolean;
  dryRun?: boolean;
  conversationId?: string;
  billingMode?: ConversationBillingMode;
  hostedContext?: HostedDeveloperContextInput;
  onProgress?: (stage: string) => void;
  perfLabel?: string;
}): Promise<LlmPatchFlowResult> {
  const reportProgress = (stage: string): void => {
    try {
      input.onProgress?.(stage);
    } catch {
      // keep progress reporting best-effort
    }
  };
  const perf = startZoneApiPerfRun(input.perfLabel ?? "runLlmPatchFlow");

  const taskIntent =
    typeof input.task === "string" ? parseTaskIntent(input.task) : UNKNOWN_INTENT;
  const zoneInternalTask = detectZoneInternalTask(input.task);

  if (zoneInternalTask) {
    reportProgress("Ready");
    perf.finish("zone internal task blocked");
    return {
      ok: true,
      reason: "zone_internal_task_target",
      patchPreview: ZONE_INTERNAL_TASK_WARNING,
      warnings: [ZONE_INTERNAL_TASK_WARNING],
      developerConfidence: 0,
      decisionMode: "blocked",
      finalState: "blocked",
      finalExecutionOutcome: "completed_with_issues",
      validationBlocked: true,
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
      contextFiles: [],
    };
  }

  const hostedAvailableFiles: RepoFile[] | undefined =
    input.hostedContext?.availableFiles.map((file) => ({
      path: file.path,
      absolutePath: file.path,
      extension: file.extension,
      category: file.category as RepoFile["category"],
    }));

  // 1. Scan repo
  reportProgress("Scanning repo...");
  let allFiles: RepoFile[] = hostedAvailableFiles ?? [];
  if (!hostedAvailableFiles) {
    try {
      allFiles = await scanRepo(input.repoPath);
    } catch {
      allFiles = [];
    }
  }
  perf.mark("repo scan ready");
  if (!input.hostedContext && allFiles.length === 0 && !isHostedEnvironment()) {
    perf.finish("repo access blocked");
    return { ok: false, reason: "repo_not_accessible_in_hosted_mode" };
  }
  const developerContextFiles = allFiles.filter(
    (file) => !isIrrelevantDeveloperContextPath(file.path)
  );

  // 2. Detect structure
  reportProgress("Detecting project structure...");
  const structure = detectProjectStructure(developerContextFiles);
  perf.mark("project structure detected");
  const projectSummary =
    input.hostedContext?.repoSummary ||
    structure.notes.join(" ") ||
    "No project summary available.";
  const projectNotes = input.hostedContext?.projectNotes ?? structure.notes;

  // 3. Rank relevant files — top 8
  reportProgress("Ranking relevant files...");
  const relevantFiles = rankRelevantFiles({
    task: input.task,
    files: developerContextFiles,
    intent: taskIntent,
  }).slice(0, 8);
  perf.mark("relevant files ranked");

  const existingFilesSummary =
    input.hostedContext?.existingFilesSummary ??
    (() => {
      const topRelevantPaths = relevantFiles
        .slice(0, 4)
        .map((file) => file.path);
      return topRelevantPaths.length > 0
        ? "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):\n" +
            topRelevantPaths.map((filePath) => `- ${filePath}`).join("\n")
        : "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):\n(none)";
    })();

  let executionPlan: ExecutionPlan | null = null;
  try {
    executionPlan = await generateExecutionPlan({
      task: input.task,
      repoSummary: projectSummary,
      relevantFiles: relevantFiles.map((file) => file.path),
    });
    console.log(`[zone-plan] generated steps=${executionPlan.steps.length}`);
    console.log(`[zone-plan] scope=${executionPlan.scopeSummary}`);
  } catch (err) {
    console.warn(
      `[zone-plan] skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 4. Plan feature with LLM
  reportProgress("Planning feature...");
  let llmPlan: Awaited<ReturnType<typeof planFeatureWithLlm>> | null = null;
  if (!input.hostedContext) {
    try {
      perf.mark("feature model call start");
      llmPlan = await planFeatureWithLlm({
        task: input.task,
        intent: taskIntent,
        projectSummary,
        projectNotes,
        relevantFiles: relevantFiles.map((f) => ({
          path: f.path,
          category: f.category,
        })),
        existingFilesSummary,
        schemaAwareSummary: [],
      });
      perf.mark("feature model response received");
    } catch (err) {
      perf.finish("feature planning failed");
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason };
    }
  }

  // 5. Read top suggested files
  const relevantFileScores = new Map(
    relevantFiles.map((file) => [file.path, file.score])
  );
  const llmSuggestedPaths = new Set((llmPlan?.suggestedFiles ?? []).map((file) => file.path));
  const preliminaryContextFiles =
    input.hostedContext?.contextFiles.map((file) => ({
      path: file.path,
      action: file.action,
      reason: file.reason,
    })) ??
    [
      ...(llmPlan?.suggestedFiles ?? []).map((file) => ({
        path: file.path,
        action: file.action,
        reason: file.reason,
      })),
      ...relevantFiles.map((file) => ({
        path: file.path,
        action: "inspect",
        reason: "High repo relevance for the requested developer task",
      })),
    ]
      .filter((file) => !isIrrelevantDeveloperContextPath(file.path))
      .filter(
        (file, index, files) =>
          files.findIndex((candidate) => candidate.path === file.path) === index
      )
      .sort((a, b) => {
        const scoreDifference =
          (relevantFileScores.get(b.path) ?? -1) - (relevantFileScores.get(a.path) ?? -1);
        if (scoreDifference !== 0) {
          return scoreDifference;
        }

        const suggestionDifference =
          Number(llmSuggestedPaths.has(b.path)) - Number(llmSuggestedPaths.has(a.path));
        if (suggestionDifference !== 0) {
          return suggestionDifference;
        }

        return a.path.localeCompare(b.path);
      })
      .slice(0, 6);

  reportProgress("Loading file context...");
  let selectedContextFiles = preliminaryContextFiles;
  let resolvedFileContexts: Array<{ path: string; content: string }>;
  if (input.hostedContext) {
    resolvedFileContexts = input.hostedContext.contextFiles.map((file) => ({
      path: file.path,
      content: file.content,
    }));
  } else {
    const filePaths = preliminaryContextFiles
      .map((f) => developerContextFiles.find((rf) => rf.path === f.path)?.absolutePath)
      .filter((p): p is string => typeof p === "string");

    const fileContentsMap = await readProjectFiles(filePaths);
    resolvedFileContexts = preliminaryContextFiles
      .map((file) => {
        const absolutePath = developerContextFiles.find((rf) => rf.path === file.path)?.absolutePath;
        if (!absolutePath) {
          return null;
        }

        return {
          path: file.path,
          content: fileContentsMap[absolutePath] ?? "",
        };
      })
      .filter((file): file is { path: string; content: string } => file !== null);

    const constraintAwareScores = new Map(
      resolvedFileContexts.map((file) => [
        file.path,
        scoreConstraintAwareContextFile({
          task: input.task,
          content: file.content,
        }),
      ])
    );

    selectedContextFiles = [...preliminaryContextFiles]
      .sort((a, b) => {
        const constraintDifference =
          (constraintAwareScores.get(b.path) ?? 0) - (constraintAwareScores.get(a.path) ?? 0);
        if (constraintDifference !== 0) {
          return constraintDifference;
        }

        const scoreDifference =
          (relevantFileScores.get(b.path) ?? -1) - (relevantFileScores.get(a.path) ?? -1);
        if (scoreDifference !== 0) {
          return scoreDifference;
        }

        const suggestionDifference =
          Number(llmSuggestedPaths.has(b.path)) - Number(llmSuggestedPaths.has(a.path));
        if (suggestionDifference !== 0) {
          return suggestionDifference;
        }

        return a.path.localeCompare(b.path);
      })
      .slice(0, 4);

    const fileContextByPath = new Map(
      resolvedFileContexts.map((file) => [file.path, file] as const)
    );
    resolvedFileContexts = selectedContextFiles
      .map((file) => fileContextByPath.get(file.path))
      .filter((file): file is { path: string; content: string } => file !== undefined);
  }
  perf.mark("file context loaded");
// ── TOKEN BUDGET GUARD ──────────────────────────────────────────
  const SIMPLE_BUDGET_CHARS = 320_000;  // ~80K tokens (4o-mini)
  const COMPLEX_BUDGET_CHARS = 320_000; // ~80K tokens (4.1-mini)
  const totalContextChars = resolvedFileContexts.reduce(
    (sum, file) => sum + (file.content?.length ?? 0), 0
  ) + (input.task?.length ?? 0);
  const contextBudget = resolvedFileContexts.length <= 6
    ? SIMPLE_BUDGET_CHARS
    : COMPLEX_BUDGET_CHARS;
  if (totalContextChars > contextBudget) {
    perf.finish("context budget exceeded");
    return {
      ok: false,
      reason: `Context too large (${Math.round(totalContextChars / 4000)}K tokens). ` +
        `Limit is ${Math.round(contextBudget / 4000)}K tokens. ` +
        `Select a smaller folder or specify exact files to change.`,
    };
  }
  perf.mark("token budget checked");
  // 6. Plan patch preview with LLM
  reportProgress("Planning patch preview...");
  let patchPlan: Awaited<ReturnType<typeof planPatchPreviewWithLlm>>;
  try {
    perf.mark("patch preview model call start");
    patchPlan = await planPatchPreviewWithLlm({
      task: input.task,
      intent: taskIntent,
      projectSummary,
      projectNotes,
      suggestedFiles: selectedContextFiles,
      fileContexts: resolvedFileContexts,
      schemaAwareSummary: [],
      executionPlan,
    });
    perf.mark("patch preview model response received");
  } catch (err) {
    perf.finish("patch preview failed");
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
  if (input.hostedContext) {
    patchPlan = {
      ...patchPlan,
      patches: patchPlan.patches.filter((p) =>
        Object.prototype.hasOwnProperty.call(
          input.hostedContext!.originalContents,
          p.path
        )
      ),
    };
    console.log("[hosted] filtered patches count:", patchPlan.patches.length);
  }

  const vagueTask = isVagueDeveloperTask(input.task);
  const selectedTargetFile = patchPlan.patches[0]?.path ?? null;
  // Task-level risk scoring for developer
  const taskRiskResult = computeRiskScore({ task: input.task, role: "developer", codeIntent: taskIntent.codeIntent });
  logRiskDebug("runLlmPatchFlow taskRiskResult", {
    task: input.task,
    taskRiskResult,
  });
  if (taskRiskResult.score >= 71) {
    reportProgress("Ready");
    return {
      ok: true,
      patchPreview: `[BLOCKED] Risk score ${taskRiskResult.score} — task was blocked before patch generation. Detected signals: ${taskRiskResult.signals.join(", ")}.`,
      warnings: [`[HIGH_RISK] Task risk score ${taskRiskResult.score} — blocked before patch generation.`],
      developerConfidence: 0,
      decisionMode: "preview_only",
      ...(selectedTargetFile ? { targetFile: selectedTargetFile } : {}),
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
      contextFiles: [],
      ...(executionPlan ? { plan: executionPlan } : {}),
    };
  }
  if (vagueTask) {
    reportProgress("Ready");
    perf.mark("decision evaluation complete");
    perf.finish("vague task response ready");
    return {
      ok: true,
      patchPreview: DEVELOPER_VAGUE_TASK_WARNING,
      warnings: [DEVELOPER_VAGUE_TASK_WARNING],
      developerConfidence: 60,
      decisionMode: "preview_only",
      ...(selectedTargetFile ? { targetFile: selectedTargetFile } : {}),
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
      contextFiles: selectedContextFiles.map((file) => file.path).slice(0, 5),
      ...(executionPlan ? { plan: executionPlan } : {}),
    };
  }

  // 6b. Generate full file content for modify/create patches
  reportProgress("Generating file patches...");
  let applyPatches: Array<{ filePath: string; fullContent: string }> = [];
  const originalContents: Record<string, string> = {
    ...(input.hostedContext?.originalContents ?? {}),
  };
  const internalWarnings = [...patchPlan.warnings];
  const visibleWarnings = filterVisibleDeveloperWarnings(patchPlan.warnings);
  const patchResults: PatchResult[] = [];
  let hostedPatchAvailability: Array<{
  path: string;
  hasOriginalContent: boolean;
  hasContextFile: boolean;
  reason: string;
}> = [];
  try {
    hostedPatchAvailability = input.hostedContext
      ? patchPlan.patches.map((patch) => {
          const hasOriginalContent = Object.prototype.hasOwnProperty.call(
            input.hostedContext!.originalContents,
            patch.path
          );
          const hasContextFile = input.hostedContext!.contextFiles.some(
            (file) => file.path === patch.path
          );
          return {
            path: patch.path,
            hasOriginalContent,
            hasContextFile,
            reason: !hasOriginalContent
              ? "missing from originalContents"
              : !hasContextFile
                ? "missing from contextFiles"
                : "available in hosted context",
          };
        })
      : [];
    const applyTargets = patchPlan.patches.filter(
      (p) => p.operation === "modify" || p.operation === "create"
    );
    const applyResults: Array<{ filePath: string; fullContent: string }> = [];

    for (const patch of applyTargets) {
      if (patch.path.startsWith("src/ui/") || patch.path === "src/ui/index.html") {
        internalWarnings.push(
          "[PROTECTED_FILE] src/ui/ files cannot be modified by Zone developer mode"
        );
        visibleWarnings.push(
          "[PROTECTED_FILE] src/ui/ files cannot be modified by Zone developer mode"
        );
        patchResults.push({
          filePath: patch.path,
          status: "skipped",
          reason: "protected file",
        });
        continue;
      }

      const hostedOriginalContent =
        input.hostedContext &&
        Object.prototype.hasOwnProperty.call(
          input.hostedContext.originalContents,
          patch.path
        )
          ? input.hostedContext.originalContents[patch.path] ?? ""
          : undefined;
      const hostedContextFileContent =
        input.hostedContext?.contextFiles.find((file) => file.path === patch.path)
          ?.content;

      if (
        input.hostedContext &&
        typeof hostedOriginalContent === "undefined" &&
        typeof hostedContextFileContent === "undefined"
      ) {
        patchResults.push({
          filePath: patch.path,
          status: "skipped",
          reason: "missing hosted context",
        });
        continue;
      }

      const repoFile = allFiles.find((f) => f.path === patch.path);
      const absolutePath = repoFile?.absolutePath;

      const fileContent = input.hostedContext
        ? hostedOriginalContent ?? hostedContextFileContent ?? ""
        : absolutePath !== undefined
          ? ((await readProjectFiles([absolutePath]))[absolutePath] ?? "")
          : "";
      originalContents[patch.path] = fileContent;

      // Include a few page-like files as extra context for UI/test-heavy repos.
      let resolvedPageObjectContext = "";
      if (input.hostedContext) {
        resolvedPageObjectContext = resolvedFileContexts
          .filter(
            (file) =>
              file.path !== patch.path &&
              (file.path.endsWith(".java") || file.path.includes("page"))
          )
          .slice(0, 5)
          .map((file) => `FILE: ${file.path}\n${file.content}`)
          .join("\n\n");
      } else {
        const pageObjectFiles = allFiles
          .filter(
            (f) =>
              !isIrrelevantDeveloperContextPath(f.path) &&
              (f.path.endsWith(".java") || f.path.includes("page"))
          )
          .slice(0, 5);

        const pageObjectPaths = pageObjectFiles
          .map((f) => f.absolutePath)
          .filter((p): p is string => typeof p === "string");

        const pageObjectContentsMap =
          pageObjectPaths.length > 0 ? await readProjectFiles(pageObjectPaths) : {};

        resolvedPageObjectContext = Object.entries(pageObjectContentsMap)
          .map(([absPath, content]) => {
            const relPath =
              allFiles.find((f) => f.absolutePath === absPath)?.path ?? absPath;
            return `FILE: ${relPath}\n${content}`;
          })
          .join("\n\n");
      }
      const microEditMode =
        isUiFilePath(patch.path) && isMicroEditUiTask(input.task);
      const contextWindow =
        fileContent.length > 8000
          ? smartContextWindow({
              fileContent,
              task: input.task,
            })
          : null;
      const preferConstrainedFullContent =
        applyTargets.length === 1 &&
        contextWindow !== null &&
        isConstrainedLocalizedPatchTask(input.task);
      const fullPatchMode =
        fileContent.length > 8000 && !preferConstrainedFullContent
          ? "find_replace_patch"
          : "full_content";
      const llmFileContent = contextWindow?.snippet ?? fileContent;
      if (isConstrainedLocalizedPatchTask(input.task)) {
        const targetEligibility = assessConstrainedTargetEligibility({
          task: input.task,
          filePath: patch.path,
          fileContent,
        });
        console.log(
          "[zone-target-eligibility]",
          JSON.stringify({
            filePath: patch.path,
            structureScore: targetEligibility.structureScore,
            entityMatch: targetEligibility.entityMatch,
            eligible: targetEligibility.eligible,
            reason: targetEligibility.reason,
          })
        );
        if (!targetEligibility.eligible) {
          const mismatchWarning = buildPatchConflictWarning({
            filePath: patch.path,
            reason: targetEligibility.reason,
            score: targetEligibility.score,
          });
          internalWarnings.push(mismatchWarning);
          visibleWarnings.push(mismatchWarning);
          patchResults.push({
            filePath: patch.path,
            status: "failed",
            reason: targetEligibility.reason,
          });
          continue;
        }
      }
      const targetedRelevantFiles = microEditMode
        ? [
            {
              path: patch.path,
              content: buildMicroEditSnippet(patch.path, fileContent, input.task),
            },
            ...resolvedFileContexts
              .filter((file) => file.path !== patch.path)
              .slice(0, 2)
              .map((file) => ({ path: file.path })),
          ]
        : resolvedFileContexts;
      const normalizedTaskIntentForPrompt = detectMicroEditIntent(input.task)
        ? "micro_edit"
        : "standard";
      const safePreviewPatch =
        canReusePatchPreviewAsFinalPatch({
          patchCount: patchPlan.patches.length,
          contentPreview: patch.contentPreview,
          taskRiskResult,
        })
          ? buildApplyPatchFromPreview({
              patch,
              currentContent: fileContent,
            })
          : { ok: false as const };
      if (safePreviewPatch.ok) {
        console.log(
          "[zone-api] skipping full patch generation (safe micro edit)"
        );
      }
      const nextContent = safePreviewPatch.ok
        ? safePreviewPatch.fullContent
        : await (() => {
            perf.mark(`full patch model call start ${patch.path}`);
            return planFullPatchWithLlm({
              task: input.task,
              filePath: patch.path,
              fileContent: llmFileContent,
              repoSummary: projectSummary,
              repoPath: input.repoPath,
              taskIntent: taskIntent.normalizedTask || taskIntent.action,
              normalizedTaskIntent: normalizedTaskIntentForPrompt,
              outputMode: fullPatchMode,
              relevantFiles: targetedRelevantFiles,
              existingTargetFiles: allFiles.map((file) => file.path),
              executionPlan,
              relatedContext: [
                contextWindow
                  ? `// CONTEXT WINDOW: lines ${contextWindow.startLine}-${contextWindow.endLine} of ${contextWindow.totalLines} total`
                  : "",
                patch.summary,
                resolvedPageObjectContext,
                "IMPORTANT: Do NOT remove or rewrite existing functions, classes, or methods unless the task explicitly asks you to. Only add or modify what is necessary. Preserve all existing code structure, comments, and patterns.",
              ]
                .filter(Boolean)
                .join("\n\n"),
            });
          })().then((fullPatch) => {
            perf.mark(`full patch model response received ${patch.path}`);
            if (fullPatch.mode === "patch") {
              const appliedPatch = applyDeveloperPatchText(
                fileContent,
                fullPatch.patchText
              );
              if (!appliedPatch.ok) {
                internalWarnings.push(appliedPatch.warning);
                if (!isHiddenDeveloperWarning(appliedPatch.warning)) {
                  visibleWarnings.push(appliedPatch.warning);
                }
                const failure = parsePatchFailureWarning(appliedPatch.warning);
                logPatchConversionDebug({
                  filePath: patch.path,
                  chosenOutputMode: fullPatchMode,
                  responseMode: fullPatch.mode,
                  status: "failed",
                  failureReason: failure.reason,
                  normalizedFailureReason: failure.normalizedFailureReason,
                });
                const patchConflictWarning = buildPatchConflictWarning({
                  filePath: patch.path,
                  reason: failure.reason,
                  score: failure.score,
                  bestMatch: failure.bestMatch,
                });
                internalWarnings.push(patchConflictWarning);
                visibleWarnings.push(patchConflictWarning);
                patchResults.push({
                  filePath: patch.path,
                  status: "failed",
                  reason: failure.reason,
                });
                return null;
              }
              logPatchConversionDebug({
                filePath: patch.path,
                chosenOutputMode: fullPatchMode,
                responseMode: fullPatch.mode,
                status: "applied",
              });
              return appliedPatch.fullContent;
            }
            logPatchConversionDebug({
              filePath: patch.path,
              chosenOutputMode: fullPatchMode,
              responseMode: fullPatch.mode,
              status: "applied",
            });
            return fullPatch.fullContent;
          });

      if (nextContent === null) {
        continue;
      }

      if (
        nextContent.includes("--- FIND ---") ||
        nextContent.includes("--- REPLACE ---")
      ) {
        const patchConflictWarning = buildPatchConflictWarning({
          filePath: patch.path,
          reason: "patch_format_leaked",
        });
        internalWarnings.push(patchConflictWarning);
        visibleWarnings.push(patchConflictWarning);
        patchResults.push({
          filePath: patch.path,
          status: "failed",
          reason: "patch_format_leaked",
        });
        continue;
      }

      const suspiciousUiOverwrite = detectSuspiciousUiOverwrite({
        task: input.task,
        filePath: patch.path,
        currentContent: fileContent,
        nextContent,
      });

      if (suspiciousUiOverwrite) {
        internalWarnings.push(suspiciousUiOverwrite);
        visibleWarnings.push(suspiciousUiOverwrite);
        const patchConflictWarning = buildPatchConflictWarning({
          filePath: patch.path,
          reason: "ui_overwrite_guard",
        });
        internalWarnings.push(patchConflictWarning);
        visibleWarnings.push(patchConflictWarning);
        patchResults.push({
          filePath: patch.path,
          status: "failed",
          reason: "ui_overwrite_guard",
        });
        continue;
      }

      const validation = validateDeveloperOutput({
        task: input.task,
        filePath: patch.path,
        fullContent: nextContent,
        originalContent: fileContent,
        diffLines: computeFileDiff(fileContent, nextContent).map((line) =>
          `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}${line.content}`
        ),
      });

      if (validation.warnings.length > 0) {
        internalWarnings.push(...validation.warnings);
        visibleWarnings.push(
          ...filterVisibleDeveloperWarnings(validation.warnings)
        );
      }

      if (validation.blocked) {
        patchResults.push({
          filePath: patch.path,
          status: "failed",
          reason: "developer_validation_blocked",
        });
        continue;
      }

        applyResults.push({
          filePath: patch.path,
          fullContent: nextContent,
        });
        if (
          nextContent.includes("--- FIND ---") ||
          nextContent.includes("--- REPLACE ---") ||
          nextContent.includes("--- END ---")
        ) {
          applyResults.pop();
          patchResults.push({
            filePath: patch.path,
            status: "failed",
            reason: "patch_format_leaked",
          });
          continue;
        }
        patchResults.push({
          filePath: patch.path,
          status: "applied",
        });
    }

    applyPatches = applyResults;
    perf.mark("patch conversion complete");
  } catch (err) {
    // step 6b is best-effort — never block the preview result
    console.error(
      "[hosted] step 6b failed:",
      err instanceof Error ? err.message : String(err)
    );
    applyPatches = [];
    perf.mark("patch conversion fallback complete");
  }
  console.log("[hosted] applyPatches count:", applyPatches.length);
  if (
    input.hostedContext &&
    applyPatches.length === 0 &&
    patchPlan.patches.length > 0
  ) {
    console.log(
      "[hosted] patch paths filtered by hosted context:",
      hostedPatchAvailability
        .filter(
          (patch) => !patch.hasOriginalContent || !patch.hasContextFile
        )
        .map(({ path, reason }) => ({ path, reason }))
    );
    console.log(
      "[hosted] patch paths still present after hosted filtering:",
      patchPlan.patches.map((patch) => patch.path)
    );
  }

  if (input.atomicPatch && patchResults.some((result) => result.status === "failed")) {
    reportProgress("Ready");
    perf.finish("atomic patch failed");
    return { ok: false, reason: "atomic_patch_failed" };
  }

  reportProgress("Validating developer output...");
  const changedFileMetrics = applyPatches.map((patch) => {
    const before = originalContents[patch.filePath] ?? "";
    return {
      totalLines: countTotalLines(before || patch.fullContent),
      changedLines: countChangedLines(before, patch.fullContent),
    };
  });
  const normalizeForDiff = (content: string): string =>
    content.replace(/\r\n/g, "\n").replace(/\t/g, "  ").trimEnd();

  reportProgress("Building diff preview...");
  const fileDiffs = applyPatches.map((patch) => {
    const before = normalizeForDiff(originalContents[patch.filePath] ?? "");
    const after = normalizeForDiff(patch.fullContent);
    const diff = computeFileDiff(before, after);
    return {
      filePath: patch.filePath,
      diff,
      addedLines: diff.filter((line) => line.type === "added").length,
      removedLines: diff.filter((line) => line.type === "removed").length,
    };
  });
  const hasRealPatchEvidence =
    applyPatches.length > 0 &&
    fileDiffs.some((fileDiff) => fileDiff.addedLines > 0 || fileDiff.removedLines > 0);
  const noCodeChangeReason = hasRealPatchEvidence
    ? null
    : deriveNoCodeChangeReason(patchResults);
  const patchScope = analyzePatchScope({
    applyPatches,
    originalContents,
  });
  const isCommentOnlyRun =
    fileDiffs.length > 0 &&
    fileDiffs.every((fd) =>
      fd.diff
        .filter((line) => line.type !== "unchanged")
        .every(
          (line) =>
            line.type === "removed" || /^\s*(\/\/|\/\*|\*)/.test(line.content)
        )
    );

  if (isCommentOnlyRun) {
    patchScope.rewriteLikeSuspicion = false;
    patchScope.totalChangedLines = fileDiffs.reduce(
      (sum, fd) => sum + fd.addedLines + fd.removedLines,
      0
    );
  }
  const designSystemSignals = detectDesignSystemSignals({
    addedLines: collectAddedPatchLines({
      applyPatches,
      originalContents,
    }),
  });
  const normalizedIntent = detectMicroEditIntent(input.task)
    ? "micro_edit"
    : "standard";
  const intentMismatchDecision = detectIntentMismatch({
    taskIntent: normalizedIntent,
    patchScope,
    codeIntent: taskIntent.codeIntent,
  });
  const intentMismatch = evaluateIntentPatchMismatch({
    task: input.task,
    patchScope,
  });
  const uiMappingRisk = evaluateUiMappingRisk({
    task: input.task,
    patchScope,
  });
  const effectiveTaskRiskResult = softenTaskRiskForLocalizedPatch({
    taskRiskResult,
    patchScope,
  });
  let planAlignment: PlanAlignmentResult | null = null;
  if (executionPlan && applyPatches.length > 0) {
    try {
      planAlignment = evaluatePlanAlignment({
        plan: executionPlan,
        changedFiles: applyPatches.map((patch) => patch.filePath),
        massScopeScore: Math.max(
          intentMismatch.risk.breakdown.massScope,
          uiMappingRisk.risk.breakdown.massScope,
          effectiveTaskRiskResult.breakdown.massScope
        ),
      });
      console.log(
        `[zone-plan-align] score=${planAlignment.score} outOfPlan=${planAlignment.outOfPlanFiles.length} scopeMismatch=${planAlignment.scopeMismatch}`
      );
      if (planAlignment.warning) {
        internalWarnings.push(planAlignment.warning);
        visibleWarnings.push(planAlignment.warning);
      }
    } catch (err) {
      console.warn(
        `[zone-plan-align] skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  let verification: VerificationResult | null = null;
  if (applyPatches.length > 0) {
    try {
      verification = verifyPatch({
        changedFiles: applyPatches.map((patch) => patch.filePath),
        patchContent: applyPatches
          .map((patch) => `FILE: ${patch.filePath}\n${patch.fullContent}`)
          .join("\n\n"),
        task: input.task,
        repoFiles: allFiles.map((file) => file.path),
      });
      console.log(
        `[zone-verify] score=${verification.score} warnings=${verification.warnings.length}`
      );
      if (verification.warnings.length > 0) {
        internalWarnings.push(...verification.warnings);
        visibleWarnings.push(...verification.warnings);
      }
    } catch (err) {
      console.warn(
        `[zone-verify] skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  let runtimeVerification: RuntimeVerificationResult | null = null;
  if (!input.hostedContext && applyPatches.length > 0) {
    try {
      const command = detectVerificationCommand({
        repoPath: input.repoPath,
        repoFiles: allFiles.map((file) => file.path),
      });
      runtimeVerification = await runRuntimeVerification({
        repoPath: input.repoPath,
        command,
      });
      if (runtimeVerification.command) {
        console.log(
          `[zone-runtime-verify] command="${runtimeVerification.command}" status=${runtimeVerification.status}`
        );
      }
      if (runtimeVerification.status === "failed") {
        const warning = `Runtime verification failed: ${runtimeVerification.command ?? "unknown command"}`;
        internalWarnings.push(warning);
        visibleWarnings.push(warning);
      } else if (runtimeVerification.status === "timeout") {
        const warning = `Runtime verification timed out: ${runtimeVerification.command ?? "unknown command"}`;
        internalWarnings.push(warning);
        visibleWarnings.push(warning);
      }
    } catch (err) {
      runtimeVerification = {
        attempted: false,
        status: "skipped",
        summary: `Runtime verification skipped: ${err instanceof Error ? err.message : String(err)}`,
      };
      console.warn(`[zone-runtime-verify] skipped`);
    }
  }
  logRiskDebug("runLlmPatchFlow after task-risk adjustments", {
    task: input.task,
    patchScope,
    taskRiskResult,
    effectiveTaskRiskResult,
    intentMismatchRisk: intentMismatch.risk,
    uiMappingRisk: uiMappingRisk.risk,
  });
  if (intentMismatch.warnings.length > 0) {
    internalWarnings.push(...intentMismatch.warnings);
    visibleWarnings.push(...intentMismatch.warnings);
  }
    if (uiMappingRisk.warnings.length > 0) {
      internalWarnings.push(...uiMappingRisk.warnings);
      visibleWarnings.push(...uiMappingRisk.warnings);
    }
    if (effectiveTaskRiskResult.score >= 71) {
      internalWarnings.push(
        `[HIGH_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}. Review carefully before applying.`
      );
      visibleWarnings.push(
        `[HIGH_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}. Review carefully before applying.`
      );
    } else if (effectiveTaskRiskResult.score >= 31) {
      internalWarnings.push(
        `[ELEVATED_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}.`
      );
      visibleWarnings.push(
        `[ELEVATED_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}.`
      );
    }

  let syncedInternalWarnings = internalWarnings.filter(
    (warning) =>
      !warning.startsWith("[HIGH_RISK] Task risk score") &&
      !warning.startsWith("[ELEVATED_RISK] Task risk score")
  );
  let syncedVisibleWarnings = visibleWarnings.filter(
    (warning) =>
      !warning.startsWith("[HIGH_RISK] Task risk score") &&
      !warning.startsWith("[ELEVATED_RISK] Task risk score")
  );

    const developerConfidenceBaseRaw = calculateDeveloperConfidence({
      warnings: syncedInternalWarnings,
      changedFileCount: applyPatches.length,
      changedFileMetrics,
      vagueTask,
    });
    let developerConfidenceBase = isCommentOnlyRun
      ? Math.max(developerConfidenceBaseRaw, 85)
      : developerConfidenceBaseRaw;
    if (applyPatches.length === 0 && patchPlan.patches.length > 0) {
      developerConfidenceBase = Math.min(developerConfidenceBase, 40);
    }
  const confidenceCaps = [
    intentMismatchDecision.severity === "medium"
      ? intentMismatchDecision.confidenceCap
      : undefined,
    uiMappingRisk.confidenceCap,
    planAlignment?.score,
    verification?.score,
    runtimeVerification?.status === "failed"
      ? Math.max(0, developerConfidenceBase - 15)
      : undefined,
  ].filter((value): value is number => typeof value === "number");
  const developerConfidence =
    confidenceCaps.length > 0
      ? Math.min(developerConfidenceBase, ...confidenceCaps)
      : developerConfidenceBase;
  const runtimeVerificationFailed =
    runtimeVerification?.attempted === true &&
    (runtimeVerification.status === "failed" || runtimeVerification.status === "timeout");
  const runtimeFailureGuidance =
    runtimeVerificationFailed && runtimeVerification
      ? buildRetryGuidanceFromFailure({
          issues: [
            {
              code:
                runtimeVerification.status === "timeout"
                  ? "RUNTIME_VERIFICATION_TIMEOUT"
                  : "RUNTIME_VERIFICATION_FAILED",
              message: [
                runtimeVerification.command
                  ? `Command: ${runtimeVerification.command}`
                  : "",
                runtimeVerification.summary,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        })
      : null;

  const allDiffLines = fileDiffs.flatMap((fd) =>
    fd.diff.map(
      (line) =>
        `${line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}${line.content}`
    )
  );
  const patchQuality = scorePatchQuality({
    taskIntent: normalizedIntent,
    patchScope,
    validationWarnings: visibleWarnings,
    designSystemSignals,
    intentMismatch: intentMismatchDecision,
    diffLines: allDiffLines,
  });
  const microEditProtection = enforceMicroEditProtection({
    taskIntent: normalizedIntent,
    patchScope,
    intentMismatch: intentMismatchDecision,
    patchQuality,
  });
  const mergedDeveloperRisk = {
      score: Math.max(
        intentMismatch.risk.score,
        uiMappingRisk.risk.score,
        effectiveTaskRiskResult.score
      ),
      breakdown: {
        destructive: Math.max(
          intentMismatch.risk.breakdown.destructive,
          uiMappingRisk.risk.breakdown.destructive,
          effectiveTaskRiskResult.breakdown.destructive
      ),
      schema: Math.max(
        intentMismatch.risk.breakdown.schema,
          uiMappingRisk.risk.breakdown.schema,
          effectiveTaskRiskResult.breakdown.schema
      ),
      massScope: Math.max(
        intentMismatch.risk.breakdown.massScope,
          uiMappingRisk.risk.breakdown.massScope,
          effectiveTaskRiskResult.breakdown.massScope
      ),
    },
  };
  if (microEditProtection.isViolation) {
    syncedInternalWarnings.push(...microEditProtection.violationReasons);
    syncedVisibleWarnings.push(...microEditProtection.violationReasons);
  }

const hasBlockedPatch = patchResults.some(r => r.status === "failed" && r.reason === "developer_validation_blocked");
if (
  input.hostedContext &&
  patchResults.some((result) => result.status === "failed") &&
  applyPatches.length > 0
) {
  const rolledBackPaths = new Set(applyPatches.map((patch) => patch.filePath));
  if (rolledBackPaths.size > 0) {
    applyPatches = [];
    for (const result of patchResults) {
      if (
        result.status === "applied" &&
        rolledBackPaths.has(result.filePath)
      ) {
        result.status = "failed";
        result.reason = "atomic_rollback";
      }
    }
    syncedVisibleWarnings.push(
      "[ATOMIC_ROLLBACK] One or more files failed validation. All changes in this patch set have been rolled back."
    );
  }
}
const finalDeveloperRiskScore = applySafePatchRiskCap({
  developerRisk: mergedDeveloperRisk,
  patchScope,
  hasIntentMismatch: intentMismatchDecision.hasMismatch,
  hasMicroEditViolation: microEditProtection.isViolation,
  hasValidationBlock: hasBlockedPatch,
});
const finalDeveloperRisk = {
  ...mergedDeveloperRisk,
  score: finalDeveloperRiskScore,
};
logRiskDebug("runLlmPatchFlow final risk", {
  task: input.task,
  patchScope,
  mergedDeveloperRisk,
  finalDeveloperRisk,
  decisionMode:
    hasBlockedPatch ||
    vagueTask ||
    microEditProtection.shouldForcePreview ||
    intentMismatchDecision.forcePreviewOnly ||
    uiMappingRisk.forcePreviewOnly ||
    developerConfidence < 70 ||
    finalDeveloperRisk.score >= 31
      ? "preview_only"
      : "safe_to_apply",
});
syncedInternalWarnings = syncDeveloperRiskWarnings({
  warnings: syncedInternalWarnings,
  developerRisk: finalDeveloperRisk,
});
syncedVisibleWarnings = syncDeveloperRiskWarnings({
  warnings: syncedVisibleWarnings,
  developerRisk: finalDeveloperRisk,
});
if (noCodeChangeReason) {
  const noCodeChangeWarning = `[NO_CODE_CHANGE_PRODUCED] ${noCodeChangeReason}`;
  if (!syncedInternalWarnings.includes(noCodeChangeWarning)) {
    syncedInternalWarnings.push(noCodeChangeWarning);
  }
  if (!syncedVisibleWarnings.includes(noCodeChangeWarning)) {
    syncedVisibleWarnings.push(noCodeChangeWarning);
  }
}

const decisionMode =
  runtimeVerificationFailed
    ? "blocked"
    : hasBlockedPatch ||
        vagueTask ||
        microEditProtection.shouldForcePreview ||
        intentMismatchDecision.forcePreviewOnly ||
        uiMappingRisk.forcePreviewOnly ||
        developerConfidence < 70 ||
        finalDeveloperRisk.score >= 31
      ? "preview_only"
      : "safe_to_apply";
  const finalExecutionOutcome =
    runtimeVerification?.status === "failed"
      ? "failed_verification"
      : runtimeVerification?.status === "timeout" || noCodeChangeReason
        ? "completed_with_issues"
        : "completed";
  const finalState =
    finalExecutionOutcome === "failed_verification" ||
    finalExecutionOutcome === "completed_with_issues"
      ? "blocked"
      : decisionMode;
  const validationBlocked = finalState === "blocked";
  if (runtimeVerificationFailed && runtimeVerification) {
    const warning = `Final verification did not pass: ${runtimeVerification.command ?? "unknown command"} (${runtimeVerification.status}).`;
    if (!syncedInternalWarnings.includes(warning)) syncedInternalWarnings.push(warning);
    if (!syncedVisibleWarnings.includes(warning)) syncedVisibleWarnings.push(warning);
    if (runtimeFailureGuidance) {
      const correctionWarning = `Required correction: ${runtimeFailureGuidance.requiredFix}`;
      const noChangeWarning =
        "Verification failed; do not treat this as no changes needed unless the repo can be proven to already match the requested correct state.";
      if (!syncedInternalWarnings.includes(correctionWarning)) {
        syncedInternalWarnings.push(correctionWarning);
      }
      if (!syncedVisibleWarnings.includes(correctionWarning)) {
        syncedVisibleWarnings.push(correctionWarning);
      }
      if (!syncedInternalWarnings.includes(noChangeWarning)) {
        syncedInternalWarnings.push(noChangeWarning);
      }
      if (!syncedVisibleWarnings.includes(noChangeWarning)) {
        syncedVisibleWarnings.push(noChangeWarning);
      }
    }
  }
  const safetyResolution = resolveSafetyLevel({
    hasBlockedPatch: hasBlockedPatch || runtimeVerificationFailed,
    developerConfidence,
    decisionMode: decisionMode === "blocked" ? "preview_only" : decisionMode,
    developerRiskScore: finalDeveloperRisk.score,
    intentMismatch: {
      hasMismatch: intentMismatchDecision.hasMismatch,
      severity: intentMismatchDecision.severity,
    },
    patchQuality,
  });
  const finalSafetyResolution =
    microEditProtection.shouldDowngradeSafety &&
    safetyResolution.safetyLevel !== "high_risk_blocked"
      ? {
          ...safetyResolution,
          safetyLevel: "preview_only" as const,
          safetyReasons: [
            ...safetyResolution.safetyReasons,
            ...microEditProtection.violationReasons,
          ],
        }
      : safetyResolution;
  perf.mark("decision evaluation complete");

  // 7. Build patchPreview string
  const patchPreview = [
    "=== LLM PATCH PREVIEW ===",
    `Summary: ${patchPlan.summary}`,
    ...(selectedTargetFile ? [`Targeted file: ${selectedTargetFile}`] : []),
    "",
    "Patches:",
    ...patchPlan.patches.map(
      (p) =>
        `- ${p.path} [${p.operation}]\n  ${p.summary}\n  Hint: ${p.targetHint}`
    ),
    ...(patchResults.length > 0
      ? [
          "",
          "=== PATCH RESULTS ===",
          ...patchResults.map((result) =>
            renderPatchResultLine(result, syncedInternalWarnings)
          ),
        ]
      : []),
    ...(syncedVisibleWarnings.length > 0
      ? ["", "Warnings:", ...syncedVisibleWarnings.map((w) => `- ${w}`)]
      : []),
  ].join("\n");

  // 8. Return
  reportProgress("Ready");
  perf.mark("response payload ready");
  perf.finish("complete");
  return {
    ok: true,
    patchPreview,
    warnings: syncedVisibleWarnings,
    ...(noCodeChangeReason ? { reason: noCodeChangeReason } : {}),
    ...(selectedTargetFile ? { targetFile: selectedTargetFile } : {}),
    developerConfidence,
    developerRisk: finalDeveloperRisk,
    intentMismatch: {
      hasMismatch: intentMismatchDecision.hasMismatch,
      severity: intentMismatchDecision.severity,
      reasonCodes: intentMismatchDecision.reasonCodes,
      warnings: intentMismatchDecision.warnings,
    },
    patchQuality,
    designSystemSignals,
    safetyResolution: finalSafetyResolution,
    microEditProtection,
    decisionMode,
    finalState,
    finalExecutionOutcome,
    attemptsUsed: runtimeVerification ? 1 : undefined,
    validationBlocked,
    ...(runtimeVerificationFailed && runtimeVerification
      ? {
          finalVerificationFailure: {
            status: runtimeVerification.status,
            command: runtimeVerification.command,
            summary: runtimeVerification.summary,
            ...(runtimeFailureGuidance
              ? {
                  rootCause: runtimeFailureGuidance.rootCause,
                  normalizedFailureReason:
                    runtimeFailureGuidance.normalizedFailureReason,
                  incorrectAssumption:
                    runtimeFailureGuidance.incorrectAssumption,
                  requiredFix: runtimeFailureGuidance.requiredFix,
                  constraint: runtimeFailureGuidance.nextAttemptConstraint,
                  scopeConstraint: runtimeFailureGuidance.scopeConstraint,
                }
              : {}),
          },
        }
      : {}),
    applyPatches,
    patchResults,
    fileDiffs,
    contextFiles: selectedContextFiles.map((file) => file.path).slice(0, 5),
    ...(executionPlan ? { plan: executionPlan } : {}),
    ...(planAlignment ? { planAlignment } : {}),
    ...(verification ? { verification } : {}),
    ...(runtimeVerification ? { runtimeVerification } : {}),
  };
}
