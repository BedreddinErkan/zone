"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFullPatchPrompt = buildFullPatchPrompt;
function buildFullPatchPrompt(input) {
    const { task, filePath, fileContent, repoSummary, relatedContext, outputMode = "full_content", } = input;
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