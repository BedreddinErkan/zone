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
      contextFiles?: string[];
    }
  | { ok: false; reason: string };

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

function buildMicroEditSnippet(filePath: string, content: string, task: string): string {
  if (!content.trim()) return content;

  const lines = content.split(/\r?\n/);
  if (lines.length > 1) {
    const taskTerms = task
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3);
    const matchedIndex = lines.findIndex((line) => {
      const normalizedLine = line.toLowerCase();
      return (
        taskTerms.some((term) => normalizedLine.includes(term)) ||
        CRITICAL_UI_ANCHORS.some((anchor) => normalizedLine.includes(anchor))
      );
    });
    if (matchedIndex >= 0) {
      const start = Math.max(0, matchedIndex - 2);
      const end = Math.min(lines.length, matchedIndex + 3);
      return lines.slice(start, end).join("\n");
    }
    return lines.slice(0, Math.min(lines.length, 6)).join("\n");
  }

  const anchors = [
    "style=",
    "class=",
    "line-height",
    "font-size",
    "padding",
    "margin",
    "badge-row",
    "progressBox",
    "patchSection",
  ];
  const lower = content.toLowerCase();
  const anchorIndex = anchors
    .map((anchor) => lower.indexOf(anchor.toLowerCase()))
    .find((index) => typeof index === "number" && index >= 0);

  if (typeof anchorIndex === "number" && anchorIndex >= 0) {
    const start = Math.max(0, anchorIndex - 180);
    const end = Math.min(content.length, anchorIndex + 320);
    return content.slice(start, end);
  }

  return content.slice(0, Math.min(content.length, 500));
}

interface ParsedDeveloperPatch {
  filePath: string;
  edits: Array<{ find: string; replace: string }>;
  createContent?: string;
}

function parseDeveloperPatchText(rawPatchText: string): ParsedDeveloperPatch | null {
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
    if (!updatedContent.includes(edit.find)) {
      return {
        ok: false,
        warning:
          "[DEVELOPER_PATCH_FORMAT] FIND block was not found in the existing file content.",
      };
    }
    updatedContent = updatedContent.replace(edit.find, edit.replace);
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

export async function runLlmPatchFlow(input: {
  task: string;
  repoPath: string;
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
  const combinedWarnings = [...patchPlan.warnings];
  try {
    const applyTargets = patchPlan.patches.filter(
      (p) => p.operation === "modify" || p.operation === "create"
    );
    const applyResults: Array<{ filePath: string; fullContent: string }> = [];

    for (const patch of applyTargets) {
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

      const fullPatch = await planFullPatchWithLlm({
        task: input.task,
        filePath: patch.path,
        fileContent,
        repoSummary: projectSummary,
        repoPath: input.repoPath,
        taskIntent: taskIntent.normalizedTask || taskIntent.action,
        relevantFiles: targetedRelevantFiles,
        existingTargetFiles: allFiles.map((file) => file.path),
        relatedContext: [patch.summary, pageObjectContext]
          .filter(Boolean)
          .join("\n\n"),
      });
      const appliedPatch = applyDeveloperPatchText(
        fileContent,
        fullPatch.patchText
      );

      if (!appliedPatch.ok) {
        combinedWarnings.push(appliedPatch.warning);
        continue;
      }

      const suspiciousUiOverwrite = detectSuspiciousUiOverwrite({
        task: input.task,
        filePath: patch.path,
        currentContent: fileContent,
        nextContent: appliedPatch.fullContent,
      });

      if (suspiciousUiOverwrite) {
        combinedWarnings.push(suspiciousUiOverwrite);
        continue;
      }

      applyResults.push({
        filePath: fullPatch.filePath,
        fullContent: appliedPatch.fullContent,
      });
    }

    applyPatches = applyResults;
  } catch {
    // step 6b is best-effort — never block the preview result
    applyPatches = [];
  }

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
    contextFiles: selectedContextFiles.map((file) => file.path).slice(0, 5),
  };
}
