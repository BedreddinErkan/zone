import { scanRepo } from "../repo/scanRepo.js";
import { detectProjectStructure } from "../repo/detectProjectStructure.js";
import { rankRelevantFiles } from "../repo/rankRelevantFiles.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { planFeatureWithLlm } from "../llm/planFeature.js";
import { planPatchPreviewWithLlm } from "../llm/planPatchPreview.js";
import { planFullPatchWithLlm } from "../llm/planFullPatch.js";
import { computeRiskScore } from "./computeRiskScore.js";
import { parseTaskIntent, type TaskIntent } from "./taskIntentParser.js";
import type { RepoFile } from "../types/project.js";

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
      decisionMode?: "preview_only" | "safe_to_apply";
      applyPatches: Array<{ filePath: string; fullContent: string }>;
      patchResults: PatchResult[];
      fileDiffs?: FileDiff[];
      originalContents?: Record<string, string>;
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
  before: string;
  after: string;
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
  fullContent: string
): boolean {
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
}): {
  blocked: boolean;
  warnings: string[];
  confidencePenalty: number;
} {
  const warnings: string[] = [];
  let blocked = false;
  let confidencePenalty = 0;

  if (hasSensitiveLogging(input.fullContent)) {
    blocked = true;
    warnings.push(
      "[DEVELOPER_SECRET_LOGGING] Output logs sensitive data. Apply is disabled."
    );
  }

  if (removesValidationOrGuards(input.originalContent, input.fullContent)) {
    blocked = true;
    warnings.push(
      "[DEVELOPER_VALIDATION_REMOVAL] Output removes input validation or guards."
    );
  }

  if (weakensAuthChecks(input.originalContent, input.fullContent)) {
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
  const originalWithoutComments = normalizeWhitespace(
    stripCommentsForComparison(input.originalContent)
  );
  const nextWithoutComments = normalizeWhitespace(
    stripCommentsForComparison(input.fullContent)
  );
  if (
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

    if (before.trim() && totalLines > 0 && changedRatio > 0.6) {
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
  const microEditIntent = detectMicroEditIntent(input.task);
  if (!microEditIntent) {
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

  const oversized =
    input.patchScope.changedFileCount > 1 ||
    input.patchScope.totalChangedLines > 30 ||
    input.patchScope.rewriteLikeSuspicion ||
    input.patchScope.cssRewriteSuspicion;

  if (!oversized) {
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

  const warnings = ["Micro-edit task produced a larger-than-expected patch."];
  if (input.patchScope.cssRewriteSuspicion) {
    warnings.push("CSS patch scope is too large for a spacing-only request.");
  }

  return {
    suspicious: true,
    confidenceCap: 55,
    warnings,
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
  const barePatch = parseFindReplacePatch(rawPatchText);
  if (barePatch) {
    return {
      filePath: "",
      edits: [barePatch],
    };
  }

  const match = rawPatchText.match(
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
): { reason: string; score?: number; bestMatch?: string } {
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
        reason: payload.reason ?? "patch_find_not_found",
        score: payload.score,
        bestMatch: payload.bestMatch,
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
  hostedContext?: HostedDeveloperContextInput;
}): Promise<LlmPatchFlowResult> {
  const taskIntent =
    typeof input.task === "string" ? parseTaskIntent(input.task) : UNKNOWN_INTENT;

  const hostedAvailableFiles: RepoFile[] | undefined =
    input.hostedContext?.availableFiles.map((file) => ({
      path: file.path,
      absolutePath: file.path,
      extension: file.extension,
      category: file.category as RepoFile["category"],
    }));

  // 1. Scan repo
  let allFiles: RepoFile[] = hostedAvailableFiles ?? [];
  if (!hostedAvailableFiles) {
    try {
      allFiles = await scanRepo(input.repoPath);
    } catch {
      allFiles = [];
    }
  }
  if (!input.hostedContext && allFiles.length === 0 && !isHostedEnvironment()) {
    return { ok: false, reason: "repo_not_accessible_in_hosted_mode" };
  }
  const developerContextFiles = allFiles.filter(
    (file) => !isIrrelevantDeveloperContextPath(file.path)
  );

  // 2. Detect structure
  const structure = detectProjectStructure(developerContextFiles);
  const projectSummary =
    input.hostedContext?.repoSummary ||
    structure.notes.join(" ") ||
    "No project summary available.";
  const projectNotes = input.hostedContext?.projectNotes ?? structure.notes;

  // 3. Rank relevant files — top 8
  const relevantFiles = rankRelevantFiles({
    task: input.task,
    files: developerContextFiles,
    intent: taskIntent,
  }).slice(0, 8);

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

  // 4. Plan feature with LLM
  let llmPlan: Awaited<ReturnType<typeof planFeatureWithLlm>> | null = null;
  if (!input.hostedContext) {
    try {
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
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason };
    }
  }

  // 5. Read top 4 suggested files
  const selectedContextFiles =
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
      .slice(0, 4);

  let resolvedFileContexts: Array<{ path: string; content: string }>;
  if (input.hostedContext) {
    resolvedFileContexts = input.hostedContext.contextFiles.map((file) => ({
      path: file.path,
      content: file.content,
    }));
  } else {
    const filePaths = selectedContextFiles
      .map((f) => developerContextFiles.find((rf) => rf.path === f.path)?.absolutePath)
      .filter((p): p is string => typeof p === "string");

    const fileContentsMap = await readProjectFiles(filePaths);
    resolvedFileContexts = Object.entries(fileContentsMap).map(([absPath, content]) => ({
      path: allFiles.find((f) => f.absolutePath === absPath)?.path ?? absPath,
      content,
    }));
  }

  // 6. Plan patch preview with LLM
  let patchPlan: Awaited<ReturnType<typeof planPatchPreviewWithLlm>>;
  try {
    patchPlan = await planPatchPreviewWithLlm({
      task: input.task,
      intent: taskIntent,
      projectSummary,
      projectNotes,
      suggestedFiles: selectedContextFiles,
      fileContexts: resolvedFileContexts,
      schemaAwareSummary: [],
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }

  const vagueTask = isVagueDeveloperTask(input.task);
  // Task-level risk scoring for developer
  const taskRiskResult = computeRiskScore({ task: input.task, role: "developer" });
  if (vagueTask) {
    return {
      ok: true,
      patchPreview: DEVELOPER_VAGUE_TASK_WARNING,
      warnings: [DEVELOPER_VAGUE_TASK_WARNING],
      developerConfidence: 60,
      decisionMode: "preview_only",
      applyPatches: [],
      patchResults: [],
      fileDiffs: [],
      originalContents: {},
      contextFiles: selectedContextFiles.map((file) => file.path).slice(0, 5),
    };
  }

  // 6b. Generate full file content for modify/create patches
  let applyPatches: Array<{ filePath: string; fullContent: string }> = [];
  const originalContents: Record<string, string> = {
    ...(input.hostedContext?.originalContents ?? {}),
  };
  const internalWarnings = [...patchPlan.warnings];
  const visibleWarnings = filterVisibleDeveloperWarnings(patchPlan.warnings);
  const patchResults: PatchResult[] = [];
  try {
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
      const fullPatchMode =
        fileContent.length > 8000 ? "find_replace_patch" : "full_content";
      const contextWindow =
        fileContent.length > 8000
          ? smartContextWindow({
              fileContent,
              task: input.task,
            })
          : null;
      const llmFileContent = contextWindow?.snippet ?? fileContent;
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

      const fullPatch = await planFullPatchWithLlm({
        task: input.task,
        filePath: patch.path,
        fileContent: llmFileContent,
        repoSummary: projectSummary,
        repoPath: input.repoPath,
        taskIntent: taskIntent.normalizedTask || taskIntent.action,
        relevantFiles: targetedRelevantFiles,
        existingTargetFiles: allFiles.map((file) => file.path),
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
      const nextContent =
        fullPatch.mode === "patch"
          ? (() => {
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
              return appliedPatch.fullContent;
            })()
          : fullPatch.fullContent;

      if (nextContent === null) {
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
        filePath: fullPatch.filePath,
        fullContent: nextContent,
      });
      patchResults.push({
        filePath: fullPatch.filePath,
        status: "applied",
      });
    }

    applyPatches = applyResults;
  } catch {
    // step 6b is best-effort — never block the preview result
    applyPatches = [];
  }

  if (input.atomicPatch && patchResults.some((result) => result.status === "failed")) {
    return { ok: false, reason: "atomic_patch_failed" };
  }

  const changedFileMetrics = applyPatches.map((patch) => {
    const before = originalContents[patch.filePath] ?? "";
    return {
      totalLines: countTotalLines(before || patch.fullContent),
      changedLines: countChangedLines(before, patch.fullContent),
    };
  });
  const patchScope = analyzePatchScope({
    applyPatches,
    originalContents,
  });
  const intentMismatch = evaluateIntentPatchMismatch({
    task: input.task,
    patchScope,
  });
  const uiMappingRisk = evaluateUiMappingRisk({
    task: input.task,
    patchScope,
  });
  if (intentMismatch.warnings.length > 0) {
    internalWarnings.push(...intentMismatch.warnings);
    visibleWarnings.push(...intentMismatch.warnings);
  }
    if (uiMappingRisk.warnings.length > 0) {
      internalWarnings.push(...uiMappingRisk.warnings);
      visibleWarnings.push(...uiMappingRisk.warnings);
    }
    if (taskRiskResult.score >= 71) {
      internalWarnings.push(
        `[HIGH_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}. Review carefully before applying.`
      );
      visibleWarnings.push(
        `[HIGH_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}. Review carefully before applying.`
      );
    } else if (taskRiskResult.score >= 31) {
      internalWarnings.push(
        `[ELEVATED_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}.`
      );
      visibleWarnings.push(
        `[ELEVATED_RISK] Task risk score ${taskRiskResult.score} — detected: ${taskRiskResult.signals.join(", ")}.`
      );
    }

    const developerConfidenceBase = calculateDeveloperConfidence({
      warnings: internalWarnings,
    changedFileCount: applyPatches.length,
    changedFileMetrics,
    vagueTask,
  });
  const confidenceCaps = [
    intentMismatch.confidenceCap,
    uiMappingRisk.confidenceCap,
  ].filter((value): value is number => typeof value === "number");
  const developerConfidence =
    confidenceCaps.length > 0
      ? Math.min(developerConfidenceBase, ...confidenceCaps)
      : developerConfidenceBase;

const normalizeForDiff = (content: string): string =>
  content.replace(/\r\n/g, "\n").replace(/\t/g, "  ").trimEnd();

const fileDiffs = applyPatches.map((patch) => {
  const before = normalizeForDiff(originalContents[patch.filePath] ?? "");
  const after = normalizeForDiff(patch.fullContent);
  const diff = computeFileDiff(before, after);
  return {
    filePath: patch.filePath,
    before,
    after,
    diff,
    addedLines: diff.filter((line) => line.type === "added").length,
    removedLines: diff.filter((line) => line.type === "removed").length,
  };
});
  const mergedDeveloperRisk = {
      score: Math.max(intentMismatch.risk.score, uiMappingRisk.risk.score, taskRiskResult.score),
      breakdown: {
        destructive: Math.max(
          intentMismatch.risk.breakdown.destructive,
        uiMappingRisk.risk.breakdown.destructive
      ),
      schema: Math.max(
        intentMismatch.risk.breakdown.schema,
        uiMappingRisk.risk.breakdown.schema
      ),
      massScope: Math.max(
        intentMismatch.risk.breakdown.massScope,
        uiMappingRisk.risk.breakdown.massScope
      ),
    },
  };

const hasBlockedPatch = patchResults.some(r => r.status === "failed" && r.reason === "developer_validation_blocked");

const decisionMode =
  hasBlockedPatch ||
  vagueTask ||
  intentMismatch.suspicious ||
  uiMappingRisk.forcePreviewOnly ||
  developerConfidence < 70 ||
  taskRiskResult.score >= 31
    ? "preview_only"
    : "safe_to_apply";

  // 7. Build patchPreview string
  const patchPreview = [
    "=== LLM PATCH PREVIEW ===",
    `Summary: ${patchPlan.summary}`,
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
            renderPatchResultLine(result, internalWarnings)
          ),
        ]
      : []),
    ...(visibleWarnings.length > 0
      ? ["", "Warnings:", ...visibleWarnings.map((w) => `- ${w}`)]
      : []),
  ].join("\n");

  // 8. Return
  return {
    ok: true,
    patchPreview,
    warnings: visibleWarnings,
    developerConfidence,
    developerRisk: mergedDeveloperRisk,
    decisionMode,
    applyPatches,
    patchResults,
    fileDiffs,
    originalContents,
    contextFiles: selectedContextFiles.map((file) => file.path).slice(0, 5),
  };
}
