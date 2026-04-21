"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFullPatchPrompt = buildFullPatchPrompt;
function isLikelyUiPatchTask(input) {
    const normalizedTask = input.task.toLowerCase();
    const normalizedPath = input.filePath.toLowerCase();
    const normalizedContent = input.fileContent.toLowerCase();
    return (normalizedPath.endsWith(".css") ||
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
        normalizedContent.includes("<button"));
}
function isSmallTargetedOrAmbiguousUiTask(input) {
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
    return (scopedUiSignals.some((signal) => normalizedTask.includes(signal)) ||
        ambiguousUiSignals.some((signal) => normalizedTask.includes(signal)));
}
function detectRenameIntent(task) {
    const renamePattern = /rename\s+(?:the\s+)?[`'"]?(\w+)[`'"]?\s+(?:function|method|class|variable|const|let|var)?\s*to\s+[`'"]?(\w+)[`'"]?/i;
    const match = task.match(renamePattern);
    if (match) {
        return { isRename: true, fromName: match[1], toName: match[2] };
    }
    return null;
}
function buildFullPatchPrompt(input) {
    const { task, filePath, fileContent, repoSummary, relatedContext, taskIntent, normalizedTaskIntent, outputMode = "full_content", executionPlanContext, } = input;
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
    const shouldHardenScopeControl = normalizedTaskIntent === "micro_edit" ||
        taskIntent === "micro_edit" ||
        isSmallTargetedOrAmbiguousUiTask({ task });
    const scopeControlInstruction = isLikelyUiPatchTask({ task, filePath, fileContent }) &&
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
    const microEditInstruction = normalizedTaskIntent === "micro_edit" || taskIntent === "micro_edit"
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
You are a senior software engineer applying a precise code change to a LARGE existing file.

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
${renameInstruction}${uiRulesInstruction}${scopeControlInstruction}${microEditInstruction}- The target file is large. Return ONLY the specific change as a FIND/REPLACE patch.
  - Do NOT return the full file.
  - Do NOT reconstruct the whole document.
  - Modify only the smallest existing block needed.
  - Your FIND block must be exact existing text from the file, usually 3-10 lines around the change.
  - Your REPLACE block must contain only the updated version of that exact block.
  - Do NOT include "--- END ---" or any marker after REPLACE block
  - Do NOT include any FILE: headers or context file contents in your output
  - Do NOT include CURRENT FILE CONTENT or INSTRUCTIONS in output
  - Your entire response must be ONLY the FIND/REPLACE patch, nothing else
  - If no change is needed, output exactly: NO_CHANGE_NEEDED
  - Do not add markdown fences or explanations.

OUTPUT FORMAT
Return plain text only in this exact format:
--- FIND ---
(exact existing text to find)
--- REPLACE ---
(updated text)
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
//# sourceMappingURL=fullPatchPrompt.js.map