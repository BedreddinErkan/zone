import { buildFinalPrompt } from "./buildFinalPrompt.js";

interface DeveloperPromptFile {
  path: string;
  content?: string;
}

export interface DeveloperPromptParams {
  task: string;
  repoPath: string;
  relevantFiles: DeveloperPromptFile[];
  taskIntent?: string;
  existingTargetFiles?: string[];
  targetFilePath?: string;
  targetFileContent?: string;
  repoSummary?: string;
  relatedContext?: string;
}

function isMicroEditUiTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return [
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
    "readability",
    "small ui",
    "small style",
  ].some((term) => normalized.includes(term));
}

function detectDeveloperMode(input: {
  task: string;
  targetFilePath?: string;
  relevantFiles: DeveloperPromptFile[];
}): "ui_polish" | "api_backend" | "config_build" | "general" {
  const normalizedTask = input.task.toLowerCase();
  const normalizedPaths = [
    input.targetFilePath ?? "",
    ...input.relevantFiles.map((file) => file.path),
  ]
    .join(" ")
    .toLowerCase();

  if (
    [
      "ui",
      "polish",
      "readability",
      "spacing",
      "font",
      "style",
      "layout",
      "badge",
      "theme",
    ].some((term) => normalizedTask.includes(term)) ||
    [".html", ".tsx", ".jsx", "/ui/", "/components/", "/pages/"].some((term) =>
      normalizedPaths.includes(term)
    )
  ) {
    return "ui_polish";
  }

  if (
    [
      "endpoint",
      "route",
      "api",
      "controller",
      "auth",
      "middleware",
      "backend",
      "server",
    ].some((term) => normalizedTask.includes(term)) ||
    ["/routes/", "/api/", "/controllers/", "/server/"].some((term) =>
      normalizedPaths.includes(term)
    )
  ) {
    return "api_backend";
  }

  if (
    [
      "config",
      "build",
      "vite",
      "webpack",
      "tsconfig",
      "eslint",
      "package",
      "npm",
      "script",
    ].some((term) => normalizedTask.includes(term)) ||
    [
      "package.json",
      "tsconfig",
      "vite.config",
      "webpack",
      "eslint",
      ".github/",
    ].some((term) => normalizedPaths.includes(term))
  ) {
    return "config_build";
  }

  return "general";
}

function buildModeInstructions(
  mode: ReturnType<typeof detectDeveloperMode>
): string[] {
  switch (mode) {
    case "ui_polish":
      return [
        "This is a UI polish/readability task. Prefer tiny in-place edits to styles, spacing, class names, copy, or existing component props.",
        "Do NOT generate a full HTML page, landing page, dashboard, or demo scaffold.",
        "Preserve the existing structure, IDs, classes, bindings, event handlers, and section ordering.",
        "If the file already exists, do NOT add <html>, <head>, or <body> wrappers unless they already exist in the current file content.",
        "Do NOT replace the page with generic content such as Welcome to My App, Get Started, Features, Application Dashboard, or any demo/marketing layout.",
      ];
    case "api_backend":
      return [
        "This is an API/backend task. Preserve route shape, auth, validation, response format, and existing service/controller boundaries.",
        "Prefer modifying existing handlers, services, middleware, or helpers over introducing parallel architecture.",
      ];
    case "config_build":
      return [
        "This is a config/build task. Make the smallest possible config change and preserve existing scripts, plugin order, and file conventions.",
        "Do not rewrite config files into a fresh scaffold.",
      ];
    default:
      return [
        "Preserve the repository's existing structure and conventions, and prefer the smallest safe change.",
      ];
  }
}

function formatRelevantFiles(files: DeveloperPromptFile[]): string {
  if (!files.length) return "(no additional relevant repo files provided)";

  return files
    .map((file) =>
      file.content
        ? `FILE: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``
        : `FILE: ${file.path}`
    )
    .join("\n\n");
}

export function buildDeveloperPrompt(params: DeveloperPromptParams): string {
  const relevantFiles = Array.isArray(params.relevantFiles)
    ? params.relevantFiles
    : [];
  const existingTargetFiles = Array.isArray(params.existingTargetFiles)
    ? params.existingTargetFiles
    : [];
  const mode = detectDeveloperMode({
    task: typeof params.task === "string" ? params.task : "",
    targetFilePath: params.targetFilePath,
    relevantFiles,
  });
  const microEditMode =
    mode === "ui_polish" &&
    isMicroEditUiTask(typeof params.task === "string" ? params.task : "");
  const modeInstructions = buildModeInstructions(mode)
    .map((line) => `- ${line}`)
    .join("\n");
  const microEditInstructions = microEditMode
    ? `
MICRO-EDIT MODE
- This task is a small UI/style edit. You MUST prefer a tiny in-place edit over any structural rewrite.
- Modify existing style, class, spacing, line-height, font-size, alignment, or label text where it already exists.
- Do NOT rewrite the page layout, move major sections, rename core anchors, or replace the document structure.
- Reuse the exact nearby existing block/snippet context when making the change.
`.trim()
    : "";

  const contextPayload = `
You are Zone's Developer role working inside a real existing repository.

Your job is to produce the smallest safe, grounded update to the target file while preserving the repository's real structure and conventions.

TASK INTENT
${params.taskIntent || "general"}

REPO PATH
${params.repoPath}

REPO SUMMARY
${params.repoSummary || "No repository summary available."}

TARGET FILE
${params.targetFilePath || "(unknown target file)"}

EXISTING TARGET FILES
${existingTargetFiles.length > 0 ? existingTargetFiles.join("\n") : "(no existing target files provided)"}

RELATED CONTEXT
${params.relatedContext || "(no additional related context provided)"}

RELEVANT REPOSITORY FILES
${formatRelevantFiles(relevantFiles)}

CURRENT TARGET FILE CONTENT
\`\`\`
${params.targetFileContent || ""}
\`\`\`

STRICT DEVELOPER RULES
- This is a real existing repository, not a greenfield scaffold.
- Modify existing files in place whenever possible instead of creating generic replacements.
- Preserve existing structure, IDs, classes, bindings, imports, exports, naming, and conventions unless the task explicitly requires otherwise.
- Keep the diff minimal and localized.
- Do NOT generate generic template/demo content.
- Do NOT output scaffold phrases such as Welcome to My App, Get Started, Features, Application Dashboard, or generic landing-page/demo output.
- If the task is small and the existing file is already functional, prefer precise edits over broad rewrites.
- If no safe grounded change can be made from the provided repository context, return the file unchanged and add a warning.

MODE-SPECIFIC INSTRUCTIONS
${modeInstructions}

${microEditInstructions}

OUTPUT REQUIREMENTS
- DO NOT output full file content.
- ONLY output patch-style edits that target existing lines or blocks.
- For existing files, use one or more FIND/REPLACE edit blocks against the current file content.
- If the target file truly does not exist, use a single CREATE block.
- Do not add markdown fences or explanations outside the JSON response.
- Preserve all existing code that is unrelated to the task.
- Preserve unrelated code exactly when possible.
- Keep existing imports, exports, formatting, and wiring intact.
- Do not introduce <html>, <head>, or <body> wrappers unless they already exist and the task explicitly requires touching them.

OUTPUT FORMAT
Return JSON only:
{
  "filePath": "string",
  "patchText": "--- FILE: path ---\\nFIND:\\nexisting block\\nREPLACE:\\nupdated block",
  "summary": "string",
  "warnings": ["string"]
}
`.trim();

  return buildFinalPrompt({
    role: "developer",
    task: params.task,
    context: contextPayload,
  });
}
