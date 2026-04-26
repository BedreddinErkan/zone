export type FullPatchOutputMode = "full_content" | "find_replace_patch";

interface FullPatchPromptInput {
  task: string;
  filePath: string;
  fileContent: string;
  repoSummary: string;
  relatedContext: string;
  taskIntent?: string;
  normalizedTaskIntent?: string;
  outputMode?: FullPatchOutputMode;
  executionPlanContext?: string;
}

function detectCodeStyleFromSample(fileContent: string): {
  indentation: string;
  quotes: "single" | "double" | "unknown";
  semicolons: "yes" | "no" | "unknown";
} {
  const lines = String(fileContent || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(0, 50);

  const spaceIndentCounts = new Map<number, number>();
  let tabIndented = 0;
  let spaceIndented = 0;

  let singleQuoteHits = 0;
  let doubleQuoteHits = 0;

  let semiYes = 0;
  let semiNo = 0;

  for (const raw of lines) {
    const line = raw ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    const ws = line.match(/^[\t ]+/)?.[0] ?? "";
    if (ws) {
      if (ws.includes("\t")) tabIndented += 1;
      if (ws.includes(" ")) spaceIndented += 1;
      if (!ws.includes("\t")) {
        const spaces = ws.length;
        spaceIndentCounts.set(spaces, (spaceIndentCounts.get(spaces) ?? 0) + 1);
      }
    }

    // Skip comment-only lines for quote/semicolon heuristics.
    if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;

    singleQuoteHits += (line.match(/'/g) ?? []).length;
    doubleQuoteHits += (line.match(/"/g) ?? []).length;

    if (/[;]\s*$/.test(line)) semiYes += 1;
    else semiNo += 1;
  }

  const indentation =
    tabIndented > spaceIndented
      ? "tabs"
      : (() => {
          let bestWidth = 2;
          let bestCount = 0;
          for (const [width, count] of spaceIndentCounts) {
            if (count > bestCount) {
              bestCount = count;
              bestWidth = width;
            }
          }
          return `${bestWidth} spaces`;
        })();

  const quotes: "single" | "double" | "unknown" =
    singleQuoteHits === 0 && doubleQuoteHits === 0
      ? "unknown"
      : singleQuoteHits > doubleQuoteHits
        ? "single"
        : "double";

  const semicolons: "yes" | "no" | "unknown" =
    semiYes === 0 && semiNo === 0
      ? "unknown"
      : semiYes >= semiNo
        ? "yes"
        : "no";

  return { indentation, quotes, semicolons };
}

function isLikelyUiPatchTask(input: {
  task: string;
  filePath: string;
  fileContent: string;
}): boolean {
  const normalizedTask = input.task.toLowerCase();
  const normalizedPath = input.filePath.toLowerCase();
  const normalizedContent = input.fileContent.toLowerCase();

  return (
    normalizedPath.endsWith(".css") ||
    normalizedPath.endsWith(".scss") ||
    normalizedPath.endsWith(".sass") ||
    normalizedPath.endsWith(".less") ||
    normalizedPath.endsWith(".html") ||
    normalizedPath.endsWith(".tsx") ||
    normalizedPath.endsWith(".jsx") ||
    normalizedPath.endsWith(".vue") ||
    normalizedPath.endsWith(".svelte") ||
    normalizedPath.includes("/components/") ||
    normalizedPath.includes("/pages/") ||
    normalizedPath.includes("/ui/") ||
    normalizedTask.includes("ui") ||
    normalizedTask.includes("style") ||
    normalizedTask.includes("spacing") ||
    normalizedTask.includes("layout") ||
    normalizedTask.includes("design") ||
    normalizedTask.includes("component") ||
    normalizedTask.includes("css") ||
    normalizedTask.includes("html") ||
    normalizedContent.includes("classname=") ||
    normalizedContent.includes("<div") ||
    normalizedContent.includes("<section") ||
    normalizedContent.includes("<button")
  );
}

function isSmallTargetedOrAmbiguousUiTask(input: { task: string }): boolean {
  const normalizedTask = input.task.toLowerCase();

  const scopedUiSignals = [
    "small",
    "slight",
    "minor",
    "tiny",
    "tweak",
    "adjust",
    "fix spacing",
    "fix padding",
    "fix margin",
    "align",
    "move",
    "shift",
    "nudge",
    "one button",
    "one card",
    "one field",
    "one element",
    "specific",
    "targeted",
  ];
  const ambiguousUiSignals = [
    "make it look better",
    "improve ui",
    "clean up",
    "polish",
    "refine",
  ];

  return (
    scopedUiSignals.some((signal) => normalizedTask.includes(signal)) ||
    ambiguousUiSignals.some((signal) => normalizedTask.includes(signal))
  );
}

function detectRenameIntent(task: string): { isRename: boolean; fromName: string; toName: string } | null {
  const renamePattern =
    /rename\s+(?:the\s+)?[`'"]?(\w+)[`'"]?\s+(?:function|method|class|variable|const|let|var)?\s*to\s+[`'"]?(\w+)[`'"]?/i;
  const match = task.match(renamePattern);
  if (match) {
    return { isRename: true, fromName: match[1], toName: match[2] };
  }
  return null;
}

export function buildFullPatchPrompt(input: FullPatchPromptInput): string {
  const {
    task,
    filePath,
    fileContent,
    repoSummary,
    relatedContext,
    taskIntent,
    normalizedTaskIntent,
    outputMode = "full_content",
    executionPlanContext,
  } = input;
  const codeStyle = detectCodeStyleFromSample(fileContent);
  const renameIntent = detectRenameIntent(task);
  const renameInstruction = renameIntent
    ? `RENAME OPERATION DETECTED:
- You must find "${renameIntent.fromName}" in the file and rename it to "${renameIntent.toName}"
- DO NOT add a new function - find the EXISTING function/method/variable named "${renameIntent.fromName}" and rename it in-place
- Update ALL occurrences of "${renameIntent.fromName}" in the file
- Keep the function body, parameters, and decorators exactly as-is
- Only the name changes, nothing else
`
    : "";
  const uiRulesInstruction = isLikelyUiPatchTask({
    task,
    filePath,
    fileContent,
  })
    ? `UI / DESIGN SYSTEM RULES:
- Prefer existing className-based styling over inline styles
- Reuse existing UI classes and component patterns when possible
- Avoid introducing large inline style blocks
- Avoid hardcoded colors, spacing, and layout values unless clearly consistent with the existing file style
- Preserve existing component structure unless the task explicitly requires structural change
- Keep the diff minimal and localized
`
    : "";
  const shouldHardenScopeControl =
    normalizedTaskIntent === "micro_edit" ||
    taskIntent === "micro_edit" ||
    isSmallTargetedOrAmbiguousUiTask({ task });
  const scopeControlInstruction =
    isLikelyUiPatchTask({ task, filePath, fileContent }) &&
    shouldHardenScopeControl
      ? `SCOPE CONTROL FOR SMALL UI TASKS:
- Apply the change only to the most relevant instance
- Avoid repeating the same change across all similar components
- Avoid propagating style tweaks to sibling or neighboring elements unless explicitly requested
- Prefer one localized edit over repeated parallel edits
- Avoid turning a local tweak into a section-wide restyling
- Modify only one relevant instance unless the task explicitly requires broader consistency
- Do not apply the same change to every similar card, item, or section
- Do not convert a small local tweak into a repeated batch edit
`
      : "";
  const microEditInstruction =
    normalizedTaskIntent === "micro_edit" || taskIntent === "micro_edit"
      ? `MICRO-EDIT CONSTRAINTS:
- Modify as few lines as possible
- Do not rewrite the component
- Do not restructure layout
- Do not introduce broad styling changes
- Do not modify multiple files unless absolutely necessary
- Prefer existing classes over inline styles
- If a small class-based change is possible, prefer that over ad-hoc styling
`
      : "";

  if (outputMode === "find_replace_patch") {
    return `
You are a code patch generator working on a LARGE existing file. Your entire reply must be ONLY a patch (or the exact token NO_CHANGE_NEEDED). Never return explanations, summaries, plain instructions, or prose.

TASK
${task}

TARGET FILE
${filePath}

REPO SUMMARY
${repoSummary}

${executionPlanContext && executionPlanContext.trim()
  ? `EXECUTION PLAN
${executionPlanContext.trim()}

`
  : ""}RELATED CONTEXT
${relatedContext}

CURRENT FILE CONTENT
\`\`\`
${fileContent}
\`\`\`

CODE STYLE (mirror exactly):
- Indentation: ${codeStyle.indentation}
- Quotes: ${codeStyle.quotes}
- Semicolons: ${codeStyle.semicolons}
Match this style in REPLACE block exactly.

REASONING STEP (silent):
Before generating the patch, silently consider:
- What is the minimal change that satisfies the task?
- What lines in the file are the best unique anchor?
- What must NOT be touched?
Then output only the patch.

SCOPE BOUNDARY:
- Touch ONLY the lines required by the task
- Do NOT refactor surrounding code
- Do NOT rename variables not mentioned in the task
- Do NOT add imports unless strictly required

PATCH RULES
${renameInstruction}${uiRulesInstruction}${scopeControlInstruction}${microEditInstruction}- FIND must be an exact verbatim excerpt from CURRENT FILE CONTENT above (usually a small block around the change).
- REPLACE must be only the updated version of that same block.
- Do NOT return the full file, JSON, or markdown commentary outside the patch.
- If no change is needed, output exactly the single line: NO_CHANGE_NEEDED

REQUIRED OUTPUT FORMAT (plain text only)
--- FILE: ${filePath} ---
--- FIND ---
<exact existing code snippet>
--- REPLACE ---
<modified code snippet>
`.trim();
  }

  return `
You are a senior software engineer applying a precise code change to an existing file.

TASK
${task}

TARGET FILE
${filePath}

REPO SUMMARY
${repoSummary}

EXECUTION PLAN
${executionPlanContext || "No execution plan available."}

RELATED CONTEXT
${relatedContext}

CURRENT FILE CONTENT
\`\`\`
${fileContent}
\`\`\`

INSTRUCTIONS
${renameInstruction}${uiRulesInstruction}${scopeControlInstruction}${microEditInstruction}- Apply the task to the file above
- Return the COMPLETE updated file content
- CRITICAL: Preserve ALL existing code that is unrelated to the task
- Do NOT remove, rename, or restructure existing functions, components, state variables, or UI elements unless the task explicitly asks you to
- Do NOT simplify, clean up, or refactor existing code
- Do NOT remove existing features like forms, filters, stats, or other UI sections that are not mentioned in the task
- Only ADD or MODIFY the specific code mentioned in the task
- The output must contain everything the original file had, plus the requested change
- If you are unsure whether something should be preserved, preserve it
- NEVER return \`return null\` or placeholder comments like \`// actual code would continue\` - always return the complete file
- Keep existing imports, exports, formatting, and naming conventions
- Do not add markdown fences or explanations
- If the file does not need changes, return it unchanged

OUTPUT FORMAT
Return JSON only:
{
  "filePath": "string",
  "fullContent": "string",
  "summary": "string",
  "warnings": ["string"]
}
`.trim();
}
