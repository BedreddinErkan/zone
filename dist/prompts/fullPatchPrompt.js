"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFullPatchPrompt = buildFullPatchPrompt;
function detectRenameIntent(task) {
    const normalized = task.toLowerCase();
    const renamePattern = /rename\s+(?:the\s+)?[`'"]?(\w+)[`'"]?\s+(?:function|method|class|variable|const|let|var)?\s*to\s+[`'"]?(\w+)[`'"]?/i;
    const match = task.match(renamePattern);
    if (match) {
        return { isRename: true, fromName: match[1], toName: match[2] };
    }
    return null;
}
function buildFullPatchPrompt(input) {
    const { task, filePath, fileContent, repoSummary, relatedContext, outputMode = "full_content", } = input;
    const renameIntent = detectRenameIntent(input.task);
    const renameInstruction = renameIntent
        ? `RENAME OPERATION DETECTED:
- You must find "${renameIntent.fromName}" in the file and rename it to "${renameIntent.toName}"
- DO NOT add a new function — find the EXISTING function/method/variable named "${renameIntent.fromName}" and rename it in-place
- Update ALL occurrences of "${renameIntent.fromName}" in the file
- Keep the function body, parameters, and decorators exactly as-is
- Only the name changes, nothing else
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

RELATED CONTEXT
${relatedContext}

CURRENT FILE CONTENT
\`\`\`
${fileContent}
\`\`\`

INSTRUCTIONS
${renameInstruction}- The target file is large. Return ONLY the specific change as a FIND/REPLACE patch.
- The target file is large. Return ONLY the specific change as a FIND/REPLACE patch.
- Do NOT return the full file.
- Do NOT reconstruct the whole document.
- Modify only the smallest existing block needed.
- Your FIND block must be exact existing text from the file, usually 3-10 lines around the change.
- Your REPLACE block must contain only the updated version of that exact block.
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

RELATED CONTEXT
${relatedContext}

CURRENT FILE CONTENT
\`\`\`
${fileContent}
\`\`\`

INSTRUCTIONS
${renameInstruction}- Apply the task to the file above
- Apply the task to the file above
- Return the COMPLETE updated file content
- Preserve all existing code that is unrelated to the task
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