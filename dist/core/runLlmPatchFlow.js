"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runLlmPatchFlow = runLlmPatchFlow;
const scanRepo_js_1 = require("../repo/scanRepo.js");
const detectProjectStructure_js_1 = require("../repo/detectProjectStructure.js");
const rankRelevantFiles_js_1 = require("../repo/rankRelevantFiles.js");
const readProjectFiles_js_1 = require("../repo/readProjectFiles.js");
const planFeature_js_1 = require("../llm/planFeature.js");
const planPatchPreview_js_1 = require("../llm/planPatchPreview.js");
const planFullPatch_js_1 = require("../llm/planFullPatch.js");
const taskIntentParser_js_1 = require("./taskIntentParser.js");
/** A fully-populated TaskIntent representing "I don't know what this is". */
const UNKNOWN_INTENT = {
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
function isUiFilePath(filePath) {
    const normalized = filePath.toLowerCase();
    return (normalized.endsWith(".html") ||
        normalized.endsWith(".tsx") ||
        normalized.endsWith(".jsx") ||
        normalized.includes("/ui/") ||
        normalized.includes("/components/") ||
        normalized.includes("/pages/"));
}
function isSmallUiPolishTask(task) {
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
function isMicroEditUiTask(task) {
    const normalized = task.toLowerCase();
    return (isSmallUiPolishTask(task) &&
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
        ].some((term) => normalized.includes(term)));
}
function extractStructureTokens(content) {
    const tokens = new Set();
    const regex = /\b(?:id|class)=["']([^"']+)["']/gi;
    let match = null;
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
function normalizeUiContent(content) {
    return content.toLowerCase().replace(/\s+/g, " ").trim();
}
function countPreservedTokens(currentTokens, nextTokens) {
    return currentTokens.filter((token) => nextTokens.includes(token)).length;
}
function extractCriticalAnchors(content) {
    const normalized = normalizeUiContent(content);
    return CRITICAL_UI_ANCHORS.filter((anchor) => normalized.includes(anchor));
}
function normalizeWhitespace(s) {
    return s.replace(/\r\n/g, "\n").replace(/\t/g, "  ").trim();
}
function buildMicroEditSnippet(filePath, content, task) {
    if (!content.trim())
        return content;
    const lines = content.split("\n");
    const cssTerms = task.match(/[.#]?[\w-]+(?:\s*\{)?/g) || [];
    const colorTerms = task.match(/#[0-9a-fA-F]{3,6}/g) || [];
    const classTerms = task.match(/[\w-]+-btn|[\w-]+-badge|[\w-]+-bar/g) || [];
    const searchTerms = [
        ...new Set([
            ...cssTerms.map((term) => term.replace(/[{}]/g, "").trim()),
            ...colorTerms,
            ...classTerms,
        ].filter((term) => term.length > 2)),
    ];
    let bestLine = -1;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        const score = searchTerms.filter((term) => lineLower.includes(term.toLowerCase())).length;
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
function fuzzyFindAndReplace(content, find, replace) {
    if (content.includes(find)) {
        return content.replace(find, replace);
    }
    const normalizedContent = normalizeWhitespace(content);
    const normalizedFind = normalizeWhitespace(find);
    if (!normalizedContent.includes(normalizedFind)) {
        return null;
    }
    const findLines = normalizedFind.split("\n");
    const contentLines = content.split("\n");
    for (let i = 0; i <= contentLines.length - findLines.length; i++) {
        const slice = contentLines
            .slice(i, i + findLines.length)
            .map((line) => line.trim())
            .join("\n");
        const target = findLines.map((line) => line.trim()).join("\n");
        if (slice === target) {
            const replaceLines = replace.split("\n");
            const newLines = [
                ...contentLines.slice(0, i),
                ...replaceLines,
                ...contentLines.slice(i + findLines.length),
            ];
            return newLines.join("\n");
        }
    }
    return null;
}
function parseFindReplacePatch(rawPatchText) {
    const match = rawPatchText.match(/--- FIND ---\s*\n([\s\S]*?)\n--- REPLACE ---\s*\n([\s\S]*)$/i);
    if (!match)
        return null;
    return {
        find: match[1],
        replace: match[2],
    };
}
function parseDeveloperPatchText(rawPatchText) {
    const barePatch = parseFindReplacePatch(rawPatchText);
    if (barePatch) {
        return {
            filePath: "",
            edits: [barePatch],
        };
    }
    const match = rawPatchText.match(/--- FILE:\s*(.+?)\s*---\s*([\s\S]*)$/i);
    if (!match)
        return null;
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
    const edits = [];
    const editRegex = /FIND:\s*\n([\s\S]*?)\nREPLACE:\s*\n([\s\S]*?)(?=\nFIND:\s*\n|$)/gi;
    let editMatch = null;
    while ((editMatch = editRegex.exec(body)) !== null) {
        edits.push({
            find: editMatch[1],
            replace: editMatch[2],
        });
    }
    return edits.length > 0 ? { filePath, edits } : null;
}
function applyDeveloperPatchText(currentContent, rawPatchText) {
    const parsed = parseDeveloperPatchText(rawPatchText);
    if (!parsed) {
        return {
            ok: false,
            warning: "[DEVELOPER_PATCH_FORMAT] Model did not return a valid patch-style edit format.",
        };
    }
    if (parsed.createContent !== undefined) {
        if (currentContent.trim()) {
            return {
                ok: false,
                warning: "[DEVELOPER_PATCH_FORMAT] CREATE blocks are not allowed for existing files.",
            };
        }
        return { ok: true, fullContent: parsed.createContent };
    }
    let updatedContent = currentContent;
    for (const edit of parsed.edits) {
        if (!edit.find.trim()) {
            return {
                ok: false,
                warning: "[DEVELOPER_PATCH_FORMAT] FIND blocks must target an existing non-empty block.",
            };
        }
        const nextContent = fuzzyFindAndReplace(updatedContent, edit.find, edit.replace);
        if (nextContent === null) {
            return {
                ok: false,
                warning: "[PATCH_FIND_NOT_FOUND] Could not locate the target block in the file",
            };
        }
        updatedContent = nextContent;
    }
    return { ok: true, fullContent: updatedContent };
}
function detectSuspiciousUiOverwrite(input) {
    if (!isUiFilePath(input.filePath))
        return null;
    if (!input.currentContent.trim())
        return null;
    if (!isSmallUiPolishTask(input.task))
        return null;
    const currentContentNormalized = normalizeUiContent(input.currentContent);
    const nextContentLower = normalizeUiContent(input.nextContent);
    const hasGenericScaffold = GENERIC_UI_SCAFFOLD_PATTERNS.some((pattern) => nextContentLower.includes(pattern));
    const hasGenericDocumentScaffold = GENERIC_DOCUMENT_SCAFFOLD_PATTERNS.some((pattern) => nextContentLower.includes(pattern));
    const introducesFullDocumentSkeleton = nextContentLower.includes("<!doctype html") ||
        (nextContentLower.includes("<html") &&
            nextContentLower.includes("<head") &&
            nextContentLower.includes("<body"));
    const currentHasFullDocumentSkeleton = currentContentNormalized.includes("<!doctype html") ||
        (currentContentNormalized.includes("<html") &&
            currentContentNormalized.includes("<head") &&
            currentContentNormalized.includes("<body"));
    const currentTokens = extractStructureTokens(input.currentContent);
    const nextTokens = extractStructureTokens(input.nextContent);
    const preservedTokenCount = countPreservedTokens(currentTokens, nextTokens);
    const preservedRatio = currentTokens.length > 0 ? preservedTokenCount / currentTokens.length : 1;
    const currentAnchors = extractCriticalAnchors(input.currentContent);
    const preservedAnchorCount = currentAnchors.filter((anchor) => nextContentLower.includes(anchor)).length;
    const preservedAnchorRatio = currentAnchors.length > 0 ? preservedAnchorCount / currentAnchors.length : 1;
    const replacementRatio = input.currentContent.length > 0
        ? input.nextContent.length / input.currentContent.length
        : 1;
    const broadMarkupRewrite = currentContentNormalized.includes("<") &&
        nextContentLower.includes("<") &&
        (replacementRatio > 1.6 || replacementRatio < 0.6);
    if (hasGenericScaffold && preservedRatio < 0.35) {
        return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} looks like a generic UI scaffold overwrite instead of a small in-place update.`;
    }
    if (hasGenericDocumentScaffold &&
        (!currentHasFullDocumentSkeleton || preservedAnchorRatio < 0.75)) {
        return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} looks like a generic document skeleton instead of a small in-place UI update.`;
    }
    if (introducesFullDocumentSkeleton &&
        !currentHasFullDocumentSkeleton &&
        (preservedRatio < 0.75 || preservedAnchorRatio < 1)) {
        return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} introduces a new full-document UI skeleton for a small UI task.`;
    }
    if (currentAnchors.length >= 3 && preservedAnchorRatio < 0.5) {
        return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} removes critical existing UI anchors for a small UI task.`;
    }
    if (broadMarkupRewrite &&
        (preservedRatio < 0.55 || preservedAnchorRatio < 0.75)) {
        return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} looks like a broad markup replacement for a small UI task instead of a localized polish edit.`;
    }
    if (currentTokens.length >= 5 && preservedRatio < 0.2) {
        return `[DEVELOPER_UI_OVERWRITE] ${input.filePath} removes most existing UI structure identifiers/classes for a small UI task.`;
    }
    return null;
}
async function runLlmPatchFlow(input) {
    const taskIntent = typeof input.task === "string" ? (0, taskIntentParser_js_1.parseTaskIntent)(input.task) : UNKNOWN_INTENT;
    // 1. Scan repo
    const allFiles = await (0, scanRepo_js_1.scanRepo)(input.repoPath);
    // 2. Detect structure
    const structure = (0, detectProjectStructure_js_1.detectProjectStructure)(allFiles);
    const projectSummary = structure.notes.join(" ") || "No project summary available.";
    // 3. Rank relevant files — top 8
    const relevantFiles = (0, rankRelevantFiles_js_1.rankRelevantFiles)({
        task: input.task,
        files: allFiles,
        intent: taskIntent,
    }).slice(0, 8);
    const topRelevantFilePaths = relevantFiles
        .slice(0, 4)
        .map((file) => file.absolutePath)
        .filter((filePath) => typeof filePath === "string");
    const topRelevantFileContentsMap = topRelevantFilePaths.length > 0
        ? await (0, readProjectFiles_js_1.readProjectFiles)(topRelevantFilePaths)
        : {};
    const existingRelevantPaths = Object.keys(topRelevantFileContentsMap).map((absPath) => allFiles.find((file) => file.absolutePath === absPath)?.path ?? absPath);
    const existingFilesSummary = existingRelevantPaths.length > 0
        ? "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):\n" +
            existingRelevantPaths.map((filePath) => `- ${filePath}`).join("\n")
        : "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):\n(none)";
    // 4. Plan feature with LLM
    let llmPlan;
    try {
        llmPlan = await (0, planFeature_js_1.planFeatureWithLlm)({
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
    }
    catch (err) {
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
        .filter((file, index, files) => files.findIndex((candidate) => candidate.path === file.path) === index)
        .slice(0, 4);
    const filePaths = selectedContextFiles
        .map((f) => allFiles.find((rf) => rf.path === f.path)?.absolutePath)
        .filter((p) => typeof p === "string");
    const fileContentsMap = await (0, readProjectFiles_js_1.readProjectFiles)(filePaths);
    const fileContexts = Object.entries(fileContentsMap).map(([absPath, content]) => ({
        path: allFiles.find((f) => f.absolutePath === absPath)?.path ?? absPath,
        content,
    }));
    // 6. Plan patch preview with LLM
    let patchPlan;
    try {
        patchPlan = await (0, planPatchPreview_js_1.planPatchPreviewWithLlm)({
            task: input.task,
            intent: taskIntent,
            projectSummary,
            projectNotes: structure.notes,
            suggestedFiles: selectedContextFiles,
            fileContexts,
            schemaAwareSummary: [],
        });
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, reason };
    }
    // 6b. Generate full file content for modify/create patches
    let applyPatches = [];
    const originalContents = {};
    const combinedWarnings = [...patchPlan.warnings];
    try {
        const applyTargets = patchPlan.patches.filter((p) => p.operation === "modify" || p.operation === "create");
        const applyResults = [];
        for (const patch of applyTargets) {
            if (patch.path.startsWith("src/ui/") || patch.path === "src/ui/index.html") {
                combinedWarnings.push("[PROTECTED_FILE] src/ui/ files cannot be modified by Zone developer mode");
                continue;
            }
            const repoFile = allFiles.find((f) => f.path === patch.path);
            const absolutePath = repoFile?.absolutePath;
            const currentContentMap = absolutePath !== undefined
                ? await (0, readProjectFiles_js_1.readProjectFiles)([absolutePath])
                : {};
            const fileContent = absolutePath !== undefined
                ? (currentContentMap[absolutePath] ?? "")
                : "";
            originalContents[patch.path] = fileContent;
            // Include a few page-like files as extra context for UI/test-heavy repos.
            const pageObjectFiles = allFiles
                .filter((f) => f.path.endsWith(".java") || f.path.includes("page"))
                .slice(0, 5);
            const pageObjectPaths = pageObjectFiles
                .map((f) => f.absolutePath)
                .filter((p) => typeof p === "string");
            const pageObjectContentsMap = pageObjectPaths.length > 0 ? await (0, readProjectFiles_js_1.readProjectFiles)(pageObjectPaths) : {};
            const pageObjectContext = Object.entries(pageObjectContentsMap)
                .map(([absPath, content]) => {
                const relPath = allFiles.find((f) => f.absolutePath === absPath)?.path ?? absPath;
                return `FILE: ${relPath}\n${content}`;
            })
                .join("\n\n");
            const microEditMode = isUiFilePath(patch.path) && isMicroEditUiTask(input.task);
            const fullPatchMode = fileContent.length > 8000 ? "find_replace_patch" : "full_content";
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
            const fullPatch = await (0, planFullPatch_js_1.planFullPatchWithLlm)({
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
            const nextContent = fullPatch.mode === "patch"
                ? (() => {
                    console.log("[zone:patch-debug] raw patchText:", fullPatch.patchText);
                    const appliedPatch = applyDeveloperPatchText(fileContent, fullPatch.patchText);
                    if (!appliedPatch.ok) {
                        combinedWarnings.push(appliedPatch.warning);
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
                continue;
            }
            applyResults.push({
                filePath: fullPatch.filePath,
                fullContent: nextContent,
            });
        }
        applyPatches = applyResults;
    }
    catch {
        // step 6b is best-effort — never block the preview result
        applyPatches = [];
    }
    // 7. Build patchPreview string
    const patchPreview = [
        "=== LLM PATCH PREVIEW ===",
        `Summary: ${patchPlan.summary}`,
        "",
        "Patches:",
        ...patchPlan.patches.map((p) => `- ${p.path} [${p.operation}]\n  ${p.summary}\n  Hint: ${p.targetHint}`),
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
        originalContents,
        contextFiles: selectedContextFiles.map((file) => file.path).slice(0, 5),
    };
}
//# sourceMappingURL=runLlmPatchFlow.js.map