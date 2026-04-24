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
import { parseDeveloperPatchText } from "./developerPatchParse.js";
import { parseTaskIntent, type TaskIntent } from "./taskIntentParser.js";
import type { PatchPreviewItem } from "../types/agent.js";
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

/** Lead words before page/form/… must not become entity anchors (instruction / meta noise). */
const CONSTRAINT_ENTITY_EXTRACTED_ANCHOR_STOPWORDS = new Set([
  "e2e",
  "random",
  "task",
  "goal",
  "form",
  "create",
  "add",
  "modify",
  "existing",
  "file",
  "page",
  "component",
  "logic",
]);

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
  const unique = [...new Set(found.map((word) => word.toLowerCase()))];
  return unique.filter(
    (word) =>
      word.length >= 4 &&
      !CONSTRAINT_ENTITY_EXTRACTED_ANCHOR_STOPWORDS.has(word)
  );
}

function escapeRegExpChars(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ConstrainedEntitySource = "path" | "content" | "none";

function splitIdentifierTokens(identifier: string): string[] {
  const raw = identifier.trim();
  if (!raw) {
    return [];
  }
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2");
  return spaced
    .split(/[^a-zA-Z0-9]+/g)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

const PATH_ENTITY_COMPOUND_SUFFIXES = [
  "page",
  "pages",
  "form",
  "forms",
  "list",
  "lists",
  "view",
  "views",
  "grid",
  "table",
  "modal",
  "dialog",
  "panel",
  "screen",
  "wizard",
];

function expandGluedLowercaseCompoundTokens(token: string): string[] {
  const lower = token.toLowerCase();
  if (!/^[a-z0-9]+$/.test(lower) || lower.length < 6) {
    return [];
  }
  const out: string[] = [];
  for (const suffix of PATH_ENTITY_COMPOUND_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length + 2) {
      out.push(lower.slice(0, -suffix.length));
    }
  }
  return out;
}

function tokenizePathSegmentForEntityMatch(segment: string): string[] {
  const withoutExt = segment.replace(/\.[^/.]+$/, "");
  const tokens = new Set<string>();
  for (const token of splitIdentifierTokens(withoutExt)) {
    tokens.add(token);
    for (const extra of expandGluedLowercaseCompoundTokens(token)) {
      tokens.add(extra);
    }
  }
  for (const part of withoutExt.toLowerCase().split(/[-_]+/g)) {
    if (part.length > 0) {
      tokens.add(part);
      for (const token of splitIdentifierTokens(part)) {
        tokens.add(token);
      }
      for (const extra of expandGluedLowercaseCompoundTokens(part)) {
        tokens.add(extra);
      }
    }
  }
  return [...tokens];
}

function collectPathEntityTokens(filePath: string): string[] {
  const normalizedSlashes = filePath.replace(/\\/g, "/");
  const segments = normalizedSlashes.split("/").filter(Boolean);
  const tokens = new Set<string>();
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const withoutExt =
      index === segments.length - 1 ? segment.replace(/\.[^/.]+$/, "") : segment;
    for (const token of tokenizePathSegmentForEntityMatch(withoutExt)) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function variantsForConstrainedEntityAnchor(anchor: string): string[] {
  const lower = anchor.toLowerCase();
  const variants = new Set<string>([lower]);
  if (lower.length >= 4 && lower.endsWith("s")) {
    variants.add(lower.slice(0, -1));
  } else if (lower.length >= 4 && !lower.endsWith("s")) {
    variants.add(`${lower}s`);
  }
  return [...variants];
}

function pathTokensHitEntityVariants(
  pathTokens: string[],
  entityAnchors: string[]
): boolean {
  if (!Array.isArray(pathTokens) || !Array.isArray(entityAnchors)) {
    return false;
  }

  for (const anchor of entityAnchors) {
    const normalizedAnchor = anchor.toLowerCase();

    for (const token of pathTokens) {
      const normalizedToken = token.toLowerCase();

      // Exact match
      if (normalizedToken === normalizedAnchor) {
        return true;
      }

      // Singular / plural variations
      if (
        normalizedToken === normalizedAnchor + "s" ||
        normalizedToken === normalizedAnchor + "es" ||
        normalizedAnchor === normalizedToken + "s" ||
        normalizedAnchor === normalizedToken + "es"
      ) {
        return true;
      }

      // Partial / contains match
      if (
        normalizedToken.includes(normalizedAnchor) ||
        normalizedAnchor.includes(normalizedToken)
      ) {
        return true;
      }
    }
  }

  return false;
}

function pathAlignsWithConstrainedTaskEntityAnchors(
  filePath: string,
  entityAnchors: string[]
): boolean {
  if (entityAnchors.length === 0) {
    return true;
  }
  const normalizedAnchors = entityAnchors.map((anchor) => anchor.toLowerCase());
  const pathTokens = collectPathEntityTokens(filePath);
  return normalizedAnchors.every((anchor) =>
    pathTokensHitEntityVariants(pathTokens, [anchor])
  );
}

const CONSTRAINED_FALLBACK_RANKED_READ_LIMIT = 12;
const CONSTRAINED_FALLBACK_ENTITY_PATH_CAP = 16;
const CONSTRAINED_FALLBACK_MAX_READ_PATHS = 24;

function buildConstrainedFallbackPathTokensDebug(
  paths: string[]
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    out[path] = collectPathEntityTokens(path);
  }
  return out;
}

function collectConstrainedFallbackEntityPathCandidates(input: {
  developerContextFiles: RepoFile[];
  entityAnchors: string[];
  rejectedPaths: Set<string>;
}): Array<{ path: string; score: number }> {
  if (input.entityAnchors.length === 0) {
    return [];
  }
  const matches: Array<{ path: string; score: number }> = [];
  const seen = new Set<string>();
  for (const file of input.developerContextFiles) {
    const { path } = file;
    if (input.rejectedPaths.has(path) || seen.has(path)) {
      continue;
    }
    if (
      isIrrelevantDeveloperContextPath(path) ||
      isProtectedDeveloperUiPath(path)
    ) {
      continue;
    }
    if (!pathAlignsWithConstrainedTaskEntityAnchors(path, input.entityAnchors)) {
      continue;
    }
    seen.add(path);
    matches.push({ path, score: 0 });
  }
  matches.sort((a, b) => a.path.localeCompare(b.path));
  return matches.slice(0, CONSTRAINED_FALLBACK_ENTITY_PATH_CAP);
}

function extractLeadingExportedComponentTokens(fileContent: string): string[] {
  const head = fileContent.slice(0, 8000);
  const names: string[] = [];
  const defaultFn = head.match(/export\s+default\s+function\s+(\w+)/);
  if (defaultFn?.[1]) {
    names.push(defaultFn[1]);
  }
  const namedExportFn = head.match(/export\s+function\s+(\w+)/);
  if (namedExportFn?.[1]) {
    names.push(namedExportFn[1]);
  }
  const exportConst = head.match(/export\s+const\s+(\w+)\s*=/);
  if (exportConst?.[1]) {
    names.push(exportConst[1]);
  }
  const tokens = new Set<string>();
  for (const name of names) {
    for (const token of splitIdentifierTokens(name)) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

function stripQuotedJsxStringsForHeadingScan(fragment: string): string {
  return fragment.replace(
    /(["'`])(?:\\.|(?!\1).)*\1/g,
    " "
  );
}

function strictFormHeadingMatchesEntityVariants(
  fileContent: string,
  variants: string[]
): boolean {
  const lower = fileContent.toLowerCase();
  const formIndex = lower.indexOf("<form");
  if (formIndex < 0) {
    return false;
  }
  const closeTag = lower.indexOf("</form>", formIndex);
  const slice =
    closeTag >= 0
      ? fileContent.slice(formIndex, closeTag)
      : fileContent.slice(formIndex, formIndex + 4000);
  const dequoted = stripQuotedJsxStringsForHeadingScan(slice);
  const headingPattern = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
  const legendPattern = /<legend[^>]*>([\s\S]*?)<\/legend>/gi;
  const chunks: string[] = [];
  let headingMatch: RegExpExecArray | null = null;
  headingPattern.lastIndex = 0;
  while ((headingMatch = headingPattern.exec(dequoted)) !== null) {
    chunks.push(headingMatch[1]);
  }
  legendPattern.lastIndex = 0;
  while ((headingMatch = legendPattern.exec(dequoted)) !== null) {
    chunks.push(headingMatch[1]);
  }
  return chunks.some((chunk) => {
    const plain = chunk
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return variants.some((variant) => {
      if (variant.length < 3) {
        return false;
      }
      const boundary = new RegExp(
        `\\b${escapeRegExpChars(variant)}s?\\b`,
        "i"
      );
      return boundary.test(plain);
    });
  });
}

function strictSecondaryEntitySignals(
  fileContent: string,
  variants: string[]
): boolean {
  const exportTokens = extractLeadingExportedComponentTokens(fileContent);
  if (pathTokensHitEntityVariants(exportTokens, variants)) {
    return true;
  }
  return strictFormHeadingMatchesEntityVariants(fileContent, variants);
}

function evaluateConstrainedEntityAlignment(input: {
  filePath: string;
  fileContent: string;
  anchors: string[];
}): {
  entityMatch: boolean;
  entitySource: ConstrainedEntitySource;
} {
  if (input.anchors.length === 0) {
    return { entityMatch: true, entitySource: "none" };
  }
  const pathTokens = collectPathEntityTokens(input.filePath);
  let pathHitAll = true;
  let secondaryHitAll = true;
  for (const anchor of input.anchors) {
    const variants = variantsForConstrainedEntityAnchor(anchor);
    if (!pathTokensHitEntityVariants(pathTokens, [anchor])) {
      pathHitAll = false;
    }
    if (!strictSecondaryEntitySignals(input.fileContent, variants)) {
      secondaryHitAll = false;
    }
  }
  const entityMatch = pathHitAll;
  const entitySource: ConstrainedEntitySource = entityMatch
    ? "path"
    : secondaryHitAll
      ? "content"
      : "none";
  return { entityMatch, entitySource };
}

function assessConstrainedTargetEligibility(input: {
  task: string;
  filePath: string;
  fileContent: string;
  topRankedRelevantPath?: string | null;
}): {
  eligible: boolean;
  score: number;
  structureScore: number;
  entityMatch: boolean;
  entitySource: ConstrainedEntitySource;
  reason: string;
  topRankedEntityMatch: boolean;
  overrideReason: string | null;
  pathTokens: string[];
  entityAnchors: string[];
} {
  const normalizedTask = normalizeConstrainedTaskText(input.task);
  const entityAnchors = extractConstrainedTaskEntityAnchors(normalizedTask);
  const pathTokens = collectPathEntityTokens(input.filePath);
  const structureScore = scoreConstraintAwareContextFile({
    task: input.task,
    content: input.fileContent,
  });
  const structureOk = structureScore >= 20;
  const { entityMatch, entitySource } = evaluateConstrainedEntityAlignment({
    filePath: input.filePath,
    fileContent: input.fileContent,
    anchors: entityAnchors,
  });

  const topRankedPath =
    typeof input.topRankedRelevantPath === "string" &&
    input.topRankedRelevantPath.length > 0
      ? input.topRankedRelevantPath
      : null;
  const topRankedEntityMatch =
    topRankedPath !== null &&
    topRankedPath === input.filePath &&
    entityAnchors.length > 0 &&
    entityMatch &&
    !isProtectedDeveloperUiPath(input.filePath) &&
    !isConstrainedGenericShellPatchPath(input.filePath);

  if (!structureOk) {
    if (topRankedEntityMatch) {
      return {
        eligible: true,
        score: structureScore,
        structureScore,
        entityMatch: true,
        entitySource: "path",
        reason: "top_ranked_entity_target_preview",
        topRankedEntityMatch: true,
        overrideReason: "top_ranked_entity_target_preview",
        pathTokens,
        entityAnchors,
      };
    }
    return {
      eligible: false,
      score: structureScore,
      structureScore,
      entityMatch,
      entitySource,
      reason: "target_file_constraint_mismatch",
      topRankedEntityMatch,
      overrideReason: null,
      pathTokens,
      entityAnchors,
    };
  }

  if (!entityMatch) {
    return {
      eligible: false,
      score: structureScore,
      structureScore,
      entityMatch: false,
      entitySource,
      reason: "target_entity_mismatch",
      topRankedEntityMatch,
      overrideReason: null,
      pathTokens,
      entityAnchors,
    };
  }

  return {
    eligible: true,
    score: structureScore,
    structureScore,
    entityMatch: true,
    entitySource,
    reason: "constraint_structure_ok",
    topRankedEntityMatch,
    overrideReason: null,
    pathTokens,
    entityAnchors,
  };
}

const CONSTRAINED_ELIGIBILITY_FALLBACK_REJECT_REASONS = new Set([
  "target_entity_mismatch",
  "target_file_constraint_mismatch",
]);

function isProtectedDeveloperUiPath(patchPath: string): boolean {
  return patchPath.startsWith("src/ui/") || patchPath === "src/ui/index.html";
}

const CONSTRAINED_GENERIC_SHELL_BASENAMES = new Set([
  "app.jsx",
  "app.tsx",
  "app.js",
  "app.ts",
  "index.jsx",
  "index.tsx",
  "index.js",
  "index.ts",
  "layout.jsx",
  "layout.tsx",
  "layout.js",
  "layout.ts",
]);

function isConstrainedGenericShellPatchPath(filePath: string): boolean {
  const base = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  return CONSTRAINED_GENERIC_SHELL_BASENAMES.has(base);
}

async function loadDeveloperModifyPatchSourceContent(input: {
  patchPath: string;
  hostedContext: HostedDeveloperContextInput | undefined;
  allFiles: RepoFile[];
}): Promise<
  | { ok: true; content: string }
  | { ok: false; reason: "missing_hosted_context" }
> {
  const hostedOriginalContent =
    input.hostedContext &&
    Object.prototype.hasOwnProperty.call(
      input.hostedContext.originalContents,
      input.patchPath
    )
      ? input.hostedContext.originalContents[input.patchPath] ?? ""
      : undefined;
  const hostedContextFileContent =
    input.hostedContext?.contextFiles.find((file) => file.path === input.patchPath)
      ?.content;

  if (
    input.hostedContext &&
    typeof hostedOriginalContent === "undefined" &&
    typeof hostedContextFileContent === "undefined"
  ) {
    return { ok: false, reason: "missing_hosted_context" };
  }

  const repoFile = input.allFiles.find((f) => f.path === input.patchPath);
  const absolutePath = repoFile?.absolutePath;

  const content = input.hostedContext
    ? hostedOriginalContent ?? hostedContextFileContent ?? ""
    : absolutePath !== undefined
      ? ((await readProjectFiles([absolutePath]))[absolutePath] ?? "")
      : "";
  return { ok: true, content };
}

async function buildConstrainedFallbackContentByPath(input: {
  resolvedFileContexts: Array<{ path: string; content: string }>;
  selectedContextFiles: Array<{ path: string }>;
  rankedCandidates: Array<{ path: string; score: number }>;
  hostedContext: HostedDeveloperContextInput | undefined;
  allFiles: RepoFile[];
}): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const file of input.resolvedFileContexts) {
    map.set(file.path, file.content);
  }
  if (input.hostedContext) {
    for (const file of input.hostedContext.contextFiles) {
      map.set(file.path, file.content);
    }
    for (const [pathKey, value] of Object.entries(
      input.hostedContext.originalContents
    )) {
      if (!map.has(pathKey)) {
        map.set(pathKey, value ?? "");
      }
    }
  }

  async function ensureRepoPathLoaded(path: string): Promise<void> {
    if (
      map.has(path) ||
      isIrrelevantDeveloperContextPath(path) ||
      isProtectedDeveloperUiPath(path)
    ) {
      return;
    }
    const absolutePath = input.allFiles.find((file) => file.path === path)
      ?.absolutePath;
    if (typeof absolutePath !== "string") {
      return;
    }
    const contents = await readProjectFiles([absolutePath]);
    map.set(path, contents[absolutePath] ?? "");
  }

  for (const entry of input.selectedContextFiles) {
    await ensureRepoPathLoaded(entry.path);
  }

  for (const ranked of input.rankedCandidates) {
    await ensureRepoPathLoaded(ranked.path);
  }

  return map;
}

function buildConstrainedSyntheticModifyPatch(filePath: string): PatchPreviewItem {
  return {
    path: filePath,
    operation: "modify",
    summary:
      "Constrained localized task fallback after preview target eligibility rejection",
    targetHint: "constrained_fallback_target",
    contentPreview: "",
  };
}

type ConstrainedFallbackPickResult =
  | {
      ok: true;
      path: string;
      content: string;
      rankScore: number;
      candidatesChecked: number;
      rejectedCandidates: Array<{ path: string; reason: string; score: number }>;
    }
  | {
      ok: false;
      candidatesChecked: number;
      rejectedCandidates: Array<{ path: string; reason: string; score: number }>;
    };

function pickConstrainedDeveloperApplyTargetFallback(input: {
  task: string;
  rejectedPaths: Set<string>;
  contentByPath: Map<string, string>;
  relevantFileScores: Map<string, number>;
}): ConstrainedFallbackPickResult {
  const rejectedCandidates: Array<{ path: string; reason: string; score: number }> =
    [];
  const entries = [...input.contentByPath.entries()].filter(
    ([path]) =>
      !input.rejectedPaths.has(path) &&
      !isIrrelevantDeveloperContextPath(path) &&
      !isProtectedDeveloperUiPath(path)
  );
  entries.sort(
    (a, b) =>
      (input.relevantFileScores.get(b[0]) ?? 0) -
        (input.relevantFileScores.get(a[0]) ?? 0) || a[0].localeCompare(b[0])
  );

  const eligible: Array<{
    path: string;
    content: string;
    rankScore: number;
  }> = [];
  for (const [path, content] of entries) {
    const eligibility = assessConstrainedTargetEligibility({
      task: input.task,
      filePath: path,
      fileContent: content,
    });
    if (!eligibility.eligible) {
      rejectedCandidates.push({
        path,
        reason: eligibility.reason,
        score: eligibility.structureScore,
      });
      continue;
    }
    eligible.push({
      path,
      content,
      rankScore: input.relevantFileScores.get(path) ?? 0,
    });
  }

  const candidatesChecked = entries.length;
  if (eligible.length === 0) {
    return { ok: false, candidatesChecked, rejectedCandidates };
  }
  eligible.sort((a, b) => {
    if (b.rankScore !== a.rankScore) {
      return b.rankScore - a.rankScore;
    }
    return a.path.localeCompare(b.path);
  });
  const best = eligible[0];
  return {
    ok: true,
    path: best.path,
    content: best.content,
    rankScore: best.rankScore,
    candidatesChecked,
    rejectedCandidates,
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

/** Constrained / micro-edit tasks must not ship huge rewrites as a normal safe patch. */
function assessConstrainedTaskLargeRewrite(input: {
  task: string;
  patchScope: DeveloperPatchScope;
}): { flagged: boolean; blockApply: boolean } {
  const constrained = isConstrainedLocalizedPatchTask(input.task);
  const microMinimal = detectMicroEditIntent(input.task);
  if (!constrained && !microMinimal) {
    return { flagged: false, blockApply: false };
  }
  const ps = input.patchScope;
  const removedHeavierThanAdded =
    ps.totalRemovedLines > ps.totalAddedLines + 50 &&
    ps.totalRemovedLines > 100;
  const flagged =
    ps.rewriteLikeSuspicion ||
    ps.totalChangedLines > 80 ||
    removedHeavierThanAdded;

  if (!flagged) {
    return { flagged: false, blockApply: false };
  }

  // Hard-block auto-apply only for constrained localized tasks (not micro-edit-only polish).
  const blockApply =
    constrained &&
    (ps.totalChangedLines > 80 ||
      ps.rewriteLikeSuspicion ||
      (ps.totalRemovedLines > ps.totalAddedLines * 1.5 &&
        ps.totalChangedLines > 100));

  return { flagged: true, blockApply };
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

function isDeveloperPatchParseStructurallyEmpty(
  parsed: NonNullable<ReturnType<typeof parseDeveloperPatchText>>
): boolean {
  if (parsed.noChangeNeeded) return false;
  if (parsed.createContent !== undefined) return false;
  return parsed.edits.length === 0;
}

function applyDeveloperPatchText(
  currentContent: string,
  rawPatchText: string
): { ok: true; fullContent: string } | { ok: false; warning: string } {
  console.log("[zone-patch-raw]", rawPatchText.slice(0, 1000));
  const trimmedPatch = rawPatchText.trim();
  if (
    trimmedPatch !== "NO_CHANGE_NEEDED" &&
    !rawPatchText.includes("--- FILE:")
  ) {
    console.warn(
      "[zone-patch] rejected patch text without --- FILE: (skipping parse)"
    );
    return {
      ok: false,
      warning:
        "[invalid_patch_format] Model did not return a valid patch structure",
    };
  }
  const parsed = parseDeveloperPatchText(rawPatchText);
  if (!parsed || isDeveloperPatchParseStructurallyEmpty(parsed)) {
    console.warn("[zone-patch] empty parse result");
    return {
      ok: false,
      warning:
        "[invalid_patch_format] Model response could not be parsed into a valid patch",
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

  if (warning.startsWith("[invalid_patch_format]")) {
    return { reason: "invalid_patch_format" };
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
  responseMode: "full_content" | "patch" | "invalid_patch_format";
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
  const noEligible = patchResults.find(
    (result) =>
      result.status === "failed" && result.reason === "no_eligible_target_found"
  )?.reason;
  if (noEligible) {
    return noEligible;
  }
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

/** Max file contexts kept when trimming to satisfy the patch-flow token budget. */
const HOSTED_CONTEXT_BUDGET_TRIM_CAP = 12;

/**
 * Orders paths by `rankRelevantFiles` ranking (plus original tail fill), capped at
 * `maxFiles`. Always prefers the #1 ranked path that appears in `resolvedFileContexts`
 * (the primary targeting / preview anchor).
 */
function selectRankedContextPathsWithinCap(
  resolvedFileContexts: Array<{ path: string; content: string }>,
  fullRankedFiles: Array<{ path: string }>,
  maxFiles: number
): string[] {
  const byPath = new Map(resolvedFileContexts.map((file) => [file.path, true]));
  const rankedInContext = fullRankedFiles
    .map((file) => file.path)
    .filter((path) => byPath.has(path));
  const previewTargetPath = rankedInContext[0];
  const ordered: string[] = [];
  if (typeof previewTargetPath === "string") {
    ordered.push(previewTargetPath);
  }
  for (const path of rankedInContext) {
    if (ordered.length >= maxFiles) {
      break;
    }
    if (!ordered.includes(path)) {
      ordered.push(path);
    }
  }
  for (const file of resolvedFileContexts) {
    if (ordered.length >= maxFiles) {
      break;
    }
    if (!ordered.includes(file.path)) {
      ordered.push(file.path);
    }
  }
  return ordered;
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
  let allFiles: RepoFile[] = [];
  let fileSource: "scanRepo" | "hosted" | "empty" = "empty";

  // Determine whether repoPath points to an actually readable local directory.
  // In true hosted cloud mode the repoPath is absent, a tmp/hosted path, or
  // simply not readable — scanRepo will then throw and we fall through to the
  // hosted context list.
  const repoPathLooksLocal =
    typeof input.repoPath === "string" &&
    input.repoPath.length > 0 &&
    !input.repoPath.startsWith("/hosted") &&
    !input.repoPath.startsWith("/tmp/zone-hosted");

  if (repoPathLooksLocal) {
    try {
      const scanned = await scanRepo(input.repoPath);
      if (scanned.length > 0) {
        allFiles = scanned;
        fileSource = "scanRepo";
      }
    } catch {
      // Fall through — hostedAvailableFiles may still provide a usable list.
    }
  }

  if (allFiles.length === 0 && hostedAvailableFiles) {
    allFiles = hostedAvailableFiles;
    fileSource = "hosted";
  }

  console.log(
    "[zone-diag-scan]",
    JSON.stringify({
      repoPath: input.repoPath,
      hostedFilesCount: hostedAvailableFiles?.length ?? 0,
      finalCount: allFiles.length,
      source: fileSource,
      isHostedEnv: isHostedEnvironment(),
    })
  );

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

  // 3. Rank relevant files — top 8 (full ranking reused for diagnostics + budget trim)
  reportProgress("Ranking relevant files...");
  const fullRankedFiles = rankRelevantFiles({
    task: input.task,
    files: developerContextFiles,
    intent: taskIntent,
  });
  const relevantFiles = fullRankedFiles.slice(0, 8);
  perf.mark("relevant files ranked");

  // TEMP DIAGNOSTIC: surface top 20 ranker scores to verify PatientsPage presence
  console.log(
    "[zone-diag-ranker]",
    JSON.stringify({
      totalFiles: developerContextFiles.length,
      totalRanked: fullRankedFiles.length,
      top20: fullRankedFiles.slice(0, 20).map((f) => ({
        path: f.path,
        score: f.score,
      })),
      patientsMatches: fullRankedFiles
        .filter((f) => f.path.toLowerCase().includes("patient"))
        .map((f) => ({ path: f.path, score: f.score })),
    })
  );

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
  const SIMPLE_BUDGET_CHARS = 320_000; // ~80K tokens (4o-mini)
  const COMPLEX_BUDGET_CHARS = 320_000; // ~80K tokens (4.1-mini)
  const taskCharBudget = input.task?.length ?? 0;
  const sumContextChars = (files: Array<{ path: string; content: string }>) =>
    files.reduce((sum, file) => sum + (file.content?.length ?? 0), 0) + taskCharBudget;

  let contextBudgetWarnings: string[] = [];
  let contextBudget =
    resolvedFileContexts.length <= 6 ? SIMPLE_BUDGET_CHARS : COMPLEX_BUDGET_CHARS;
  let totalContextChars = sumContextChars(resolvedFileContexts);

  if (totalContextChars > contextBudget) {
    const originalFileCount = resolvedFileContexts.length;
    const trimmedPaths = selectRankedContextPathsWithinCap(
      resolvedFileContexts,
      fullRankedFiles,
      HOSTED_CONTEXT_BUDGET_TRIM_CAP
    );
    const pathToContent = new Map(
      resolvedFileContexts.map((file) => [file.path, file.content] as const)
    );
    const metaSources = input.hostedContext?.contextFiles ?? preliminaryContextFiles;
    const pathToMeta = new Map(
      metaSources.map((file) => [file.path, { action: file.action, reason: file.reason }] as const)
    );

    resolvedFileContexts = trimmedPaths.map((path) => ({
      path,
      content: pathToContent.get(path) ?? "",
    }));
    selectedContextFiles = trimmedPaths.map((path) => {
      const meta = pathToMeta.get(path);
      return {
        path,
        action: meta?.action ?? "inspect",
        reason: meta?.reason ?? "Retained for patch context after budget trim",
      };
    });

    contextBudget =
      resolvedFileContexts.length <= 6 ? SIMPLE_BUDGET_CHARS : COMPLEX_BUDGET_CHARS;
    totalContextChars = sumContextChars(resolvedFileContexts);

    const trimmedFileCount = resolvedFileContexts.length;
    const retainedPaths = resolvedFileContexts.map((file) => file.path);
    console.log(
      "[zone-diag-context-trim]",
      JSON.stringify({
        originalFileCount,
        trimmedFileCount,
        retainedPaths,
      })
    );

    if (originalFileCount > trimmedFileCount) {
      contextBudgetWarnings.push(
        `[hosted_context_trimmed_to_budget] Trimmed developer context from ${originalFileCount} to ${trimmedFileCount} files to fit the token budget.`
      );
    }
  }

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
  console.log("[zone-preview] received (ignored for patch application)");
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
  let fallbackForcePreviewOnly = false;
  const originalContents: Record<string, string> = {
    ...(input.hostedContext?.originalContents ?? {}),
  };
  const internalWarnings = [...contextBudgetWarnings, ...patchPlan.warnings];
  const visibleWarnings = filterVisibleDeveloperWarnings([
    ...contextBudgetWarnings,
    ...patchPlan.warnings,
  ]);
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
    let loopApplyTargets: PatchPreviewItem[] = applyTargets;
    let constrainedApplyEligibilityPrefiltered = false;

    if (isConstrainedLocalizedPatchTask(input.task) && applyTargets.length > 0) {
      constrainedApplyEligibilityPrefiltered = true;
      const prefilteredTargets: PatchPreviewItem[] = [];
      const constraintRejections: Array<{ filePath: string; reason: string }> =
        [];

      for (const previewPatch of applyTargets) {
        if (isProtectedDeveloperUiPath(previewPatch.path)) {
          prefilteredTargets.push(previewPatch);
          continue;
        }
        const hostedOriginalPre =
          input.hostedContext &&
          Object.prototype.hasOwnProperty.call(
            input.hostedContext.originalContents,
            previewPatch.path
          )
            ? input.hostedContext.originalContents[previewPatch.path] ?? ""
            : undefined;
        const hostedCtxPre = input.hostedContext?.contextFiles.find(
          (file) => file.path === previewPatch.path
        )?.content;
        if (
          input.hostedContext &&
          typeof hostedOriginalPre === "undefined" &&
          typeof hostedCtxPre === "undefined"
        ) {
          patchResults.push({
            filePath: previewPatch.path,
            status: "skipped",
            reason: "missing hosted context",
          });
          continue;
        }
        const loaded = await loadDeveloperModifyPatchSourceContent({
          patchPath: previewPatch.path,
          hostedContext: input.hostedContext,
          allFiles,
        });
        if (!loaded.ok) {
          patchResults.push({
            filePath: previewPatch.path,
            status: "skipped",
            reason: "missing hosted context",
          });
          continue;
        }
        const preflightEligibility = assessConstrainedTargetEligibility({
          task: input.task,
          filePath: previewPatch.path,
          fileContent: loaded.content,
          topRankedRelevantPath: fullRankedFiles[0]?.path ?? null,
        });
        console.log(
          "[zone-target-eligibility]",
          JSON.stringify({
            filePath: previewPatch.path,
            structureScore: preflightEligibility.structureScore,
            entityMatch: preflightEligibility.entityMatch,
            entitySource: preflightEligibility.entitySource,
            eligible: preflightEligibility.eligible,
            reason: preflightEligibility.reason,
            decision: preflightEligibility.eligible ? "accepted" : "rejected",
            topRankedEntityMatch: preflightEligibility.topRankedEntityMatch,
            overrideReason: preflightEligibility.overrideReason,
            pathTokens: preflightEligibility.pathTokens,
            entityAnchors: preflightEligibility.entityAnchors,
          })
        );
        if (!preflightEligibility.eligible) {
          const mismatchWarning = buildPatchConflictWarning({
            filePath: previewPatch.path,
            reason: preflightEligibility.reason,
            score: preflightEligibility.score,
          });
          internalWarnings.push(mismatchWarning);
          visibleWarnings.push(mismatchWarning);
          patchResults.push({
            filePath: previewPatch.path,
            status: "failed",
            reason: preflightEligibility.reason,
          });
          if (
            CONSTRAINED_ELIGIBILITY_FALLBACK_REJECT_REASONS.has(
              preflightEligibility.reason
            )
          ) {
            constraintRejections.push({
              filePath: previewPatch.path,
              reason: preflightEligibility.reason,
            });
          }
          continue;
        }
        if (preflightEligibility.reason === "top_ranked_entity_target_preview") {
          fallbackForcePreviewOnly = true;
          internalWarnings.push(
            "[top_ranked_entity_target_used_without_structure_confirmation] Top-ranked file matches the task entity/path, but structure heuristics were weak; keeping preview-only safety."
          );
          visibleWarnings.push(
            "[top_ranked_entity_target_used_without_structure_confirmation] Top-ranked file matches the task entity/path, but structure heuristics were weak; keeping preview-only safety."
          );
        }
        prefilteredTargets.push(previewPatch);
      }

      loopApplyTargets = prefilteredTargets;
      const hasNonProtectedApplyTarget = loopApplyTargets.some(
        (p) => !isProtectedDeveloperUiPath(p.path)
      );
      if (
        !hasNonProtectedApplyTarget &&
        constraintRejections.length > 0 &&
        constraintRejections.every((rejection) =>
          CONSTRAINED_ELIGIBILITY_FALLBACK_REJECT_REASONS.has(rejection.reason)
        )
      ) {
        const rejectedPaths = new Set(
          constraintRejections.map((rejection) => rejection.filePath)
        );
        const rejectedPreviewPaths = constraintRejections.map(
          (rejection) => rejection.filePath
        );
        const fallbackFullRanked = rankRelevantFiles({
          task: input.task,
          files: developerContextFiles,
          intent: taskIntent,
        });
        const fallbackEntityAnchors = extractConstrainedTaskEntityAnchors(
          normalizeConstrainedTaskText(input.task)
        );
        const entityPathCandidates = collectConstrainedFallbackEntityPathCandidates({
          developerContextFiles,
          entityAnchors: fallbackEntityAnchors,
          rejectedPaths,
        });
        const entityPathSet = new Set(
          entityPathCandidates.map((candidate) => candidate.path)
        );
        const rankedSlice = fallbackFullRanked
          .filter((file) => !entityPathSet.has(file.path))
          .slice(0, CONSTRAINED_FALLBACK_RANKED_READ_LIMIT);
        const rankedCandidatePaths = rankedSlice.map((file) => file.path);
        const entityPathCandidatePaths = entityPathCandidates.map(
          (candidate) => candidate.path
        );
        const mergedReadOrder: Array<{ path: string; score: number }> = [];
        const mergeSeen = new Set<string>();
        for (const item of [
          ...entityPathCandidates,
          ...rankedSlice.map((file) => ({ path: file.path, score: file.score })),
        ]) {
          if (mergeSeen.has(item.path) || rejectedPaths.has(item.path)) {
            continue;
          }
          mergeSeen.add(item.path);
          mergedReadOrder.push(item);
          if (mergedReadOrder.length >= CONSTRAINED_FALLBACK_MAX_READ_PATHS) {
            break;
          }
        }
        const fallbackRelevantScores = new Map(relevantFileScores);
        for (const file of fallbackFullRanked) {
          fallbackRelevantScores.set(file.path, file.score);
        }
        for (const candidate of entityPathCandidates) {
          const current = fallbackRelevantScores.get(candidate.path) ?? 0;
          fallbackRelevantScores.set(
            candidate.path,
            Math.max(current, 100_000)
          );
        }
        const fallbackContentByPath = await buildConstrainedFallbackContentByPath({
          resolvedFileContexts,
          selectedContextFiles,
          rankedCandidates: mergedReadOrder,
          hostedContext: input.hostedContext,
          allFiles,
        });
        const pathTokensDebug = buildConstrainedFallbackPathTokensDebug(
          mergedReadOrder.map((item) => item.path)
        );

        // Grounded candidate list. mergedReadOrder already places
        // entity-path candidates (tiers 1/2) before ranked-only candidates.
        // We do NOT rescan the repo or call any LLM to build this list.
        const orderedFallbackCandidates: Array<{
          path: string;
          content: string;
          rankScore: number;
        }> = [];
        const orderedFallbackSeen = new Set<string>();
        for (const item of mergedReadOrder) {
          if (orderedFallbackSeen.has(item.path)) continue;
          if (rejectedPaths.has(item.path)) continue;
          if (
            isIrrelevantDeveloperContextPath(item.path) ||
            isProtectedDeveloperUiPath(item.path)
          ) {
            continue;
          }
          const content = fallbackContentByPath.get(item.path);
          if (typeof content !== "string") continue;
          orderedFallbackSeen.add(item.path);
          orderedFallbackCandidates.push({
            path: item.path,
            content,
            rankScore: fallbackRelevantScores.get(item.path) ?? 0,
          });
        }

        const MAX_FALLBACK_ATTEMPTS = 3;
        const retryLogEntries: Array<{
          attempt: number;
          filePath: string;
          eligible: boolean;
          reason: string;
        }> = [];
        const retryRejectedCandidates: Array<{
          path: string;
          reason: string;
          score: number;
        }> = [];
        let attemptsMade = 0;
        let fallbackPick:
          | { path: string; content: string; rankScore: number }
          | null = null;
        let tier3Pick:
          | {
              path: string;
              content: string;
              rankScore: number;
              structureScore: number;
            }
          | null = null;
        let fallbackTier:
          | "tier12_eligible"
          | "tier3_structure_only_preview"
          | null = null;

        for (const candidate of orderedFallbackCandidates) {
          if (attemptsMade >= MAX_FALLBACK_ATTEMPTS) break;
          attemptsMade += 1;

          const eligibility = assessConstrainedTargetEligibility({
            task: input.task,
            filePath: candidate.path,
            fileContent: candidate.content,
          });

          const retryEntry = {
            attempt: attemptsMade,
            filePath: candidate.path,
            eligible: eligibility.eligible,
            reason: eligibility.reason,
          };
          retryLogEntries.push(retryEntry);
          console.log("[zone-target-retry]", JSON.stringify(retryEntry));

          if (eligibility.eligible) {
            fallbackPick = {
              path: candidate.path,
              content: candidate.content,
              rankScore: candidate.rankScore,
            };
            fallbackTier = "tier12_eligible";
            break;
          }

          retryRejectedCandidates.push({
            path: candidate.path,
            reason: eligibility.reason,
            score: eligibility.structureScore,
          });
        }

        // Tier 3: if tier 1/2 found nothing, do a second pass over ALL
        // grounded candidates (not bounded by MAX_FALLBACK_ATTEMPTS). This
        // pass makes no LLM calls — only cheap eligibility checks — and
        // picks the best structure-only match. If used, it will be forced
        // to preview_only downstream.
        if (fallbackPick === null) {
          for (const candidate of orderedFallbackCandidates) {
            const eligibility = assessConstrainedTargetEligibility({
              task: input.task,
              filePath: candidate.path,
              fileContent: candidate.content,
            });
            if (
              eligibility.reason === "target_entity_mismatch" &&
              eligibility.structureScore >= 20 &&
              (tier3Pick === null ||
                candidate.rankScore > tier3Pick.rankScore ||
                (candidate.rankScore === tier3Pick.rankScore &&
                  eligibility.structureScore > tier3Pick.structureScore))
            ) {
              tier3Pick = {
                path: candidate.path,
                content: candidate.content,
                rankScore: candidate.rankScore,
                structureScore: eligibility.structureScore,
              };
            }
          }
        }

        if (fallbackPick === null && tier3Pick !== null) {
          const tier3Entry = {
            attempt: attemptsMade + 1,
            filePath: tier3Pick.path,
            eligible: true,
            reason: "tier3_structure_only_preview",
          };
          retryLogEntries.push(tier3Entry);
          console.log("[zone-target-retry]", JSON.stringify(tier3Entry));
          fallbackPick = {
            path: tier3Pick.path,
            content: tier3Pick.content,
            rankScore: tier3Pick.rankScore,
          };
          fallbackTier = "tier3_structure_only_preview";
          fallbackForcePreviewOnly = true;
        }

        if (fallbackPick !== null) {
          console.log(
            "[zone-target-fallback]",
            JSON.stringify({
              rejectedPreviewPaths,
              entityAnchors: fallbackEntityAnchors,
              entityPathCandidates: entityPathCandidatePaths,
              rankedCandidates: rankedCandidatePaths,
              pathTokensDebug,
              candidatesChecked: attemptsMade,
              candidatesAvailable: orderedFallbackCandidates.length,
              rejectedCandidates: retryRejectedCandidates,
              fallback: fallbackPick.path,
              fallbackTier,
              reason:
                fallbackTier === "tier3_structure_only_preview"
                  ? "selected_fallback_tier3_preview_only"
                  : "selected_fallback",
              retryLog: retryLogEntries,
            })
          );
          originalContents[fallbackPick.path] = fallbackPick.content;
          loopApplyTargets = [
            buildConstrainedSyntheticModifyPatch(fallbackPick.path),
            ...loopApplyTargets,
          ];
        } else {
          console.log(
            "[zone-target-fallback]",
            JSON.stringify({
              rejectedPreviewPaths,
              entityAnchors: fallbackEntityAnchors,
              entityPathCandidates: entityPathCandidatePaths,
              rankedCandidates: rankedCandidatePaths,
              pathTokensDebug,
              candidatesChecked: attemptsMade,
              candidatesAvailable: orderedFallbackCandidates.length,
              rejectedCandidates: retryRejectedCandidates,
              fallback: null,
              fallbackTier: null,
              reason: "no_eligible_fallback",
              retryLog: retryLogEntries,
            })
          );
          patchResults.push({
            filePath:
              constraintRejections[0]?.filePath ??
              applyTargets[0]?.path ??
              "constrained_task",
            status: "failed",
            reason: "no_eligible_target_found",
          });
        }
      }
    }

    for (const patch of loopApplyTargets) {
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
        loopApplyTargets.length === 1 &&
        contextWindow !== null &&
        isConstrainedLocalizedPatchTask(input.task);
      const fullPatchMode =
        fileContent.length > 8000 && !preferConstrainedFullContent
          ? "find_replace_patch"
          : "full_content";
      const llmFileContent = contextWindow?.snippet ?? fileContent;
      const shouldRunInlineConstrainedEligibility =
        isConstrainedLocalizedPatchTask(input.task) &&
        !constrainedApplyEligibilityPrefiltered;
      if (shouldRunInlineConstrainedEligibility) {
        const targetEligibility = assessConstrainedTargetEligibility({
          task: input.task,
          filePath: patch.path,
          fileContent,
          topRankedRelevantPath: fullRankedFiles[0]?.path ?? null,
        });
        console.log(
          "[zone-target-eligibility]",
          JSON.stringify({
            filePath: patch.path,
            structureScore: targetEligibility.structureScore,
            entityMatch: targetEligibility.entityMatch,
            entitySource: targetEligibility.entitySource,
            eligible: targetEligibility.eligible,
            reason: targetEligibility.reason,
            decision: targetEligibility.eligible ? "accepted" : "rejected",
            topRankedEntityMatch: targetEligibility.topRankedEntityMatch,
            overrideReason: targetEligibility.overrideReason,
            pathTokens: targetEligibility.pathTokens,
            entityAnchors: targetEligibility.entityAnchors,
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
        if (targetEligibility.reason === "top_ranked_entity_target_preview") {
          fallbackForcePreviewOnly = true;
          internalWarnings.push(
            "[top_ranked_entity_target_used_without_structure_confirmation] Top-ranked file matches the task entity/path, but structure heuristics were weak; keeping preview-only safety."
          );
          visibleWarnings.push(
            "[top_ranked_entity_target_used_without_structure_confirmation] Top-ranked file matches the task entity/path, but structure heuristics were weak; keeping preview-only safety."
          );
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
      console.log("[zone-patch-source] using FULL PATCH ONLY");
      const nextContent = await (() => {
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
            if (fullPatch.mode === "invalid_patch_format") {
              fallbackForcePreviewOnly = true;
              for (const w of fullPatch.warnings) {
                internalWarnings.push(w);
                visibleWarnings.push(w);
              }
              logPatchConversionDebug({
                filePath: patch.path,
                chosenOutputMode: fullPatchMode,
                responseMode: "invalid_patch_format" as const,
                status: "failed",
                failureReason: "invalid_patch_format",
                normalizedFailureReason: "invalid_patch_format",
              });
              patchResults.push({
                filePath: patch.path,
                status: "failed",
                reason: "invalid_patch_format",
              });
              return null;
            }
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
                if (failure.reason === "invalid_patch_format") {
                  fallbackForcePreviewOnly = true;
                }
                logPatchConversionDebug({
                  filePath: patch.path,
                  chosenOutputMode: fullPatchMode,
                  responseMode:
                    failure.reason === "invalid_patch_format"
                      ? "invalid_patch_format"
                      : fullPatch.mode,
                  status: "failed",
                  failureReason:
                    failure.reason === "invalid_patch_format"
                      ? "invalid_patch_format"
                      : failure.reason,
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

  const constrainedLargeRewriteAssessment = assessConstrainedTaskLargeRewrite({
    task: input.task,
    patchScope,
  });
  const constrainedTaskLargeRewriteBlocked =
    constrainedLargeRewriteAssessment.blockApply;
  const constrainedTaskLargeRewriteForcePreview =
    constrainedLargeRewriteAssessment.flagged &&
    !constrainedLargeRewriteAssessment.blockApply;
  if (constrainedLargeRewriteAssessment.flagged) {
    const detail = `+${patchScope.totalAddedLines}/-${patchScope.totalRemovedLines} lines (totalChanged=${patchScope.totalChangedLines}, rewriteLikeSuspicion=${patchScope.rewriteLikeSuspicion}).`;
    const warnMsg = `[constrained_task_large_rewrite] Patch is too large for a constrained minimal task. ${detail}`;
    internalWarnings.push(warnMsg);
    visibleWarnings.push(warnMsg);
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
    runtimeVerificationFailed
      ? "blocked"
      : constrainedTaskLargeRewriteBlocked
        ? "blocked"
        : hasBlockedPatch ||
            vagueTask ||
            microEditProtection.shouldForcePreview ||
            intentMismatchDecision.forcePreviewOnly ||
            uiMappingRisk.forcePreviewOnly ||
            developerConfidence < 70 ||
            finalDeveloperRisk.score >= 31 ||
            fallbackForcePreviewOnly ||
            constrainedTaskLargeRewriteForcePreview
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
    : constrainedTaskLargeRewriteBlocked
      ? "blocked"
      : hasBlockedPatch ||
          vagueTask ||
          microEditProtection.shouldForcePreview ||
          intentMismatchDecision.forcePreviewOnly ||
          uiMappingRisk.forcePreviewOnly ||
          developerConfidence < 70 ||
          finalDeveloperRisk.score >= 31 ||
          fallbackForcePreviewOnly ||
          constrainedTaskLargeRewriteForcePreview
        ? "preview_only"
        : "safe_to_apply";
  const finalExecutionOutcome =
    runtimeVerification?.status === "failed"
      ? "failed_verification"
      : runtimeVerification?.status === "timeout" || noCodeChangeReason
        ? "completed_with_issues"
        : constrainedTaskLargeRewriteBlocked
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
    hasBlockedPatch:
      hasBlockedPatch ||
      runtimeVerificationFailed ||
      constrainedTaskLargeRewriteBlocked,
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
    ...(constrainedLargeRewriteAssessment.flagged
      ? ["Patch is too large for a constrained minimal task.", ""]
      : []),
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
