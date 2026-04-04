"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFeaturePlanningPrompt = buildFeaturePlanningPrompt;
exports.buildPatchPlanningPrompt = buildPatchPlanningPrompt;
function buildFeaturePlanningPrompt(input) {
    const relevantFilesText = input.relevantFiles.length > 0
        ? input.relevantFiles
            .map((file) => `- [${file.category}] ${file.path}`)
            .join("\n")
        : "- No relevant files found";
    const notesText = input.projectNotes.length > 0
        ? input.projectNotes.map((note) => `- ${note}`).join("\n")
        : "- No project notes";
    return `
You are a senior fullstack coding agent working on the Zone project.

Project rules:
- Preserve the existing architecture and folder structure
- Prefer minimal, focused changes
- Do not suggest unnecessary refactors
- Keep backend and frontend responsibilities separate
- If UI is involved, keep user-facing labels in Turkish
- Respect auth and clinic-based access control
- Follow existing service/route/controller patterns
- Avoid inventing files unless truly needed
- Prefer modifying existing related files before creating new ones

Requested task:
${input.task}

Project summary:
${input.projectSummary}

Project notes:
${notesText}

Relevant files:
${relevantFilesText}

Return valid JSON only in this exact shape:
{
  "implementationSummary": "short summary",
  "steps": ["step 1", "step 2"],
  "suggestedFiles": [
    {
      "path": "relative/path/to/file",
      "reason": "why this file matters",
      "action": "create" | "modify" | "inspect"
    }
  ],
  "risks": ["risk 1", "risk 2"]
}

Important:
- Return JSON only
- Do not wrap in markdown
- Suggested files should be realistic and consistent with the provided file list
- Prefer files that already exist in the project context
`.trim();
}
function buildPatchPlanningPrompt(input) {
    const notesText = input.projectNotes.length > 0
        ? input.projectNotes.map((note) => `- ${note}`).join("\n")
        : "- No project notes";
    const suggestedFilesText = input.suggestedFiles.length > 0
        ? input.suggestedFiles
            .map((file) => `- ${file.path} | action=${file.action} | reason=${file.reason}`)
            .join("\n")
        : "- No suggested files";
    const fileContextsText = input.fileContexts.length > 0
        ? input.fileContexts
            .map((file) => `
FILE: ${file.path}
CONTENT:
${file.content}
--- END FILE ---
`.trim())
            .join("\n\n")
        : "No file contents available";
    return `
You are a senior fullstack coding agent working on the Zone project.

Project rules:
- Preserve the existing architecture and naming patterns
- Prefer small, targeted edits
- Keep Turkish UI text if UI changes are involved
- Respect backend/frontend separation
- Preserve auth and clinic-based access control
- Do not produce full rewrites for large files
- Generate preview-oriented patch suggestions, not final code dumps
- Be realistic and only reference files that exist unless a new file is clearly needed

Requested task:
${input.task}

Project summary:
${input.projectSummary}

Project notes:
${notesText}

Suggested files from the planning phase:
${suggestedFilesText}

Relevant file contents:
${fileContextsText}

Return valid JSON only in this exact shape:
{
  "summary": "short patch strategy summary",
  "patches": [
    {
      "path": "relative/path/to/file",
      "operation": "create" | "modify",
      "summary": "what should change in this file",
      "targetHint": "where or around what code this change should happen",
      "contentPreview": "short preview of the intended code or pseudocode"
    }
  ],
  "warnings": ["warning 1", "warning 2"]
}

Important:
- Return JSON only
- Do not wrap in markdown
- contentPreview should be concise, focused, and partial
- Do not dump entire large files
- Prefer modify over create when possible
`.trim();
}
//# sourceMappingURL=prompts.js.map