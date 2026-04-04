import { scanRepo } from "../repo/scanRepo.js";
import { detectProjectStructure } from "../repo/detectProjectStructure.js";
import { rankRelevantFiles } from "../repo/rankRelevantFiles.js";
import { readProjectFiles } from "../repo/readProjectFiles.js";
import { planFeatureWithLlm } from "../llm/planFeature.js";
import { planPatchPreviewWithLlm } from "../llm/planPatchPreview.js";
import { planFullPatchWithLlm } from "../llm/planFullPatch.js";
import { parseTaskIntent, type TaskIntent } from "./taskIntentParser.js";

export type LlmPatchFlowResult =
  | {
      ok: true;
      patchPreview: string;
      warnings: string[];
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
}): Promise<LlmPatchFlowResult> {
  const taskIntent =
    typeof input.task === "string" ? parseTaskIntent(input.task) : UNKNOWN_INTENT;

  // 1. Scan repo
  const allFiles = await scanRepo(input.repoPath);

  // 2. Detect structure
  const structure = detectProjectStructure(allFiles);
  const projectSummary =
    structure.notes.join(" ") || "No project summary available.";

  // 3. Rank relevant files — top 8
  const relevantFiles = rankRelevantFiles({
    task: input.task,
    files: allFiles,
    intent: taskIntent,
  }).slice(0, 8);

  const topRelevantFilePaths = relevantFiles
    .slice(0, 4)
    .map((file) => file.absolutePath)
    .filter((filePath): filePath is string => typeof filePath === "string");
  const topRelevantFileContentsMap =
    topRelevantFilePaths.length > 0
      ? await readProjectFiles(topRelevantFilePaths)
      : {};
  const existingRelevantPaths = Object.keys(topRelevantFileContentsMap).map(
    (absPath) => allFiles.find((file) => file.absolutePath === absPath)?.path ?? absPath
  );
  const existingFilesSummary =
    existingRelevantPaths.length > 0
      ? "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):\n" +
        existingRelevantPaths.map((filePath) => `- ${filePath}`).join("\n")
      : "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):\n(none)";

  // 4. Plan feature with LLM
  let llmPlan: Awaited<ReturnType<typeof planFeatureWithLlm>>;
  try {
    llmPlan = await planFeatureWithLlm({
      task: input.task,
      intent: taskIntent,
      projectSummary,
      projectNotes: structure.notes,
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

  // 5. Read top 4 suggested files
  const selectedContextFiles = [
    ...llmPlan.suggestedFiles.map((file) => ({
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
    .filter(
      (file, index, files) =>
        files.findIndex((candidate) => candidate.path === file.path) === index
    )
    .slice(0, 4);

  const filePaths = selectedContextFiles
    .map((f) => allFiles.find((rf) => rf.path === f.path)?.absolutePath)
    .filter((p): p is string => typeof p === "string");

  const fileContentsMap = await readProjectFiles(filePaths);

  const fileContexts = Object.entries(fileContentsMap).map(
    ([absPath, content]) => ({
      path: allFiles.find((f) => f.absolutePath === absPath)?.path ?? absPath,
      content,
    })
  );

  // 6. Plan patch preview with LLM
  let patchPlan: Awaited<ReturnType<typeof planPatchPreviewWithLlm>>;
  try {
    patchPlan = await planPatchPreviewWithLlm({
      task: input.task,
      intent: taskIntent,
      projectSummary,
      projectNotes: structure.notes,
      suggestedFiles: selectedContextFiles,
      fileContexts,
      schemaAwareSummary: [],
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }

  // 6b. Generate full file content for modify/create patches
  let applyPatches: Array<{ filePath: string; fullContent: string }> = [];
  const originalContents: Record<string, string> = {};
  const combinedWarnings = [...patchPlan.warnings];
  const patchResults: PatchResult[] = [];
  try {
    const applyTargets = patchPlan.patches.filter(
      (p) => p.operation === "modify" || p.operation === "create"
    );
    const applyResults: Array<{ filePath: string; fullContent: string }> = [];

    for (const patch of applyTargets) {
      if (patch.path.startsWith("src/ui/") || patch.path === "src/ui/index.html") {
        combinedWarnings.push(
          "[PROTECTED_FILE] src/ui/ files cannot be modified by Zone developer mode"
        );
        patchResults.push({
          filePath: patch.path,
          status: "skipped",
          reason: "protected file",
        });
        continue;
      }

      const repoFile = allFiles.find((f) => f.path === patch.path);
      const absolutePath = repoFile?.absolutePath;

      const currentContentMap =
        absolutePath !== undefined
          ? await readProjectFiles([absolutePath])
          : {};

      const fileContent =
        absolutePath !== undefined
          ? (currentContentMap[absolutePath] ?? "")
          : "";
      originalContents[patch.path] = fileContent;

      // Include a few page-like files as extra context for UI/test-heavy repos.
      const pageObjectFiles = allFiles
        .filter((f) => f.path.endsWith(".java") || f.path.includes("page"))
        .slice(0, 5);

      const pageObjectPaths = pageObjectFiles
        .map((f) => f.absolutePath)
        .filter((p): p is string => typeof p === "string");

      const pageObjectContentsMap =
        pageObjectPaths.length > 0 ? await readProjectFiles(pageObjectPaths) : {};

      const pageObjectContext = Object.entries(pageObjectContentsMap)
        .map(([absPath, content]) => {
          const relPath =
            allFiles.find((f) => f.absolutePath === absPath)?.path ?? absPath;
          return `FILE: ${relPath}\n${content}`;
        })
        .join("\n\n");
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
            ...fileContexts
              .filter((file) => file.path !== patch.path)
              .slice(0, 2)
              .map((file) => ({ path: file.path })),
          ]
        : fileContexts;

      console.log("[zone:patch-debug] planFullPatch input:", {
        path: patch.path,
        fileContentLength: fileContent.length,
        mode: fullPatchMode,
      });

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
          pageObjectContext,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
      const nextContent =
        fullPatch.mode === "patch"
          ? (() => {
              console.log("[zone:patch-debug] raw patchText:", fullPatch.patchText);
              const appliedPatch = applyDeveloperPatchText(
                fileContent,
                fullPatch.patchText
              );
              if (!appliedPatch.ok) {
                combinedWarnings.push(appliedPatch.warning);
                const failure = parsePatchFailureWarning(appliedPatch.warning);
                combinedWarnings.push(
                  buildPatchConflictWarning({
                    filePath: patch.path,
                    reason: failure.reason,
                    score: failure.score,
                    bestMatch: failure.bestMatch,
                  })
                );
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
        combinedWarnings.push(suspiciousUiOverwrite);
        combinedWarnings.push(
          buildPatchConflictWarning({
            filePath: patch.path,
            reason: "ui_overwrite_guard",
          })
        );
        patchResults.push({
          filePath: patch.path,
          status: "failed",
          reason: "ui_overwrite_guard",
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

  const fileDiffs = input.dryRun
    ? applyPatches.map((patch) => {
        const before = originalContents[patch.filePath] ?? "";
        const diff = computeFileDiff(before, patch.fullContent);
        return {
          filePath: patch.filePath,
          before,
          after: patch.fullContent,
          diff,
          addedLines: diff.filter((line) => line.type === "added").length,
          removedLines: diff.filter((line) => line.type === "removed").length,
        };
      })
    : undefined;

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
            renderPatchResultLine(result, combinedWarnings)
          ),
        ]
      : []),
    ...(combinedWarnings.length > 0
      ? ["", "Warnings:", ...combinedWarnings.map((w) => `- ${w}`)]
      : []),
  ].join("\n");

  // 8. Return
  return {
    ok: true,
    patchPreview,
    warnings: combinedWarnings,
    applyPatches,
    patchResults,
    fileDiffs,
    originalContents,
    contextFiles: selectedContextFiles.map((file) => file.path).slice(0, 5),
  };
}
