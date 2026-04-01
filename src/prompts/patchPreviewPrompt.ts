import type { TaskIntent } from "../core/taskIntentParser.js";

interface PatchPreviewPromptInput {
  task: string;
  intent: TaskIntent;
  filePath: string;
  fileContent: string;
  repoSummary: string;
  relatedContext: string;
  schemaAwareSummary?: string;
}

export function buildPatchPreviewPrompt(input: PatchPreviewPromptInput): string {
  const {
    task,
    intent,
    filePath,
    fileContent,
    repoSummary,
    relatedContext,
    schemaAwareSummary
  } = input;

  return `
You are generating a safe patch preview for a code agent working inside an existing production-style codebase.

Your goal is to propose the smallest correct patch for the target file while preserving the current architecture and conventions.

TASK
${task}

TASK INTENT
- action: ${intent.action}
- resourceKind: ${intent.resourceKind}
- scope: ${intent.scope}
- parentResource: ${intent.parentResource ?? "unknown"}
- nestedResource: ${intent.nestedResource ?? "unknown"}
- routeHints: ${intent.routeHints.join(", ") || "none"}
- paramHints: ${intent.paramHints.join(", ") || "none"}
- mentionsNestedItem: ${intent.mentionsNestedItem ? "yes" : "no"}
- destructiveRisk: ${intent.destructiveRisk ? "yes" : "no"}

REPO SUMMARY
${repoSummary}

SCHEMA-AWARE SUMMARY
${schemaAwareSummary || "No schema-aware summary available."}

TARGET FILE
${filePath}

RELATED CONTEXT
${relatedContext}

CURRENT FILE CONTENT
\`\`\`
${fileContent}
\`\`\`

STRICT PATCH RULES
1. Do not rewrite unrelated parts of the file.
2. Keep the patch as small and localized as possible.
3. If task intent is nested_resource, do not replace, delete, or redesign parent resource logic unless explicitly required.
4. For nested delete/update operations, target only the nested item and preserve the parent record.
5. Use exact identifiers when relevant, such as treatmentId + timelineId, patientId + noteId, or parent-child scoped filters.
6. If schema-aware summary identifies known tables, columns, storage kind, auth middleware, or response shape, you MUST follow them.
7. If storage kind is "separate_table", do not switch to json_field logic.
8. If storage kind is "json_field", do not invent a new table.
9. Do not invent new tables, columns, or route patterns if the schema-aware summary contradicts them.
10. Prefer existing naming patterns, controller patterns, route patterns, and service conventions already used in the repo.
11. Preserve multi-tenant or clinic/org scoping if present in the file or related context.
12. If confidence is low, add a warning instead of inventing architecture.
13. Return patch previews in the existing agent format.
14. Do not include markdown fences in the JSON response.

PATCH THINKING GUIDELINES
- First determine whether this file should be modified at all.
- If this file is not the right target, return a warning and keep the patch minimal.
- Reuse existing helpers/imports if they already exist.
- Avoid duplicate imports, duplicate routes, and duplicate handlers.
- For backend files, preserve auth and response conventions.
- For frontend files, preserve current service call patterns and payload shape.

OUTPUT FORMAT
Return JSON only:
{
  "summary": "string",
  "patches": [
    {
      "path": "string",
      "operation": "create" | "modify",
      "summary": "string",
      "targetHint": "string",
      "contentPreview": "string"
    }
  ],
  "warnings": ["string"]
}
`.trim();
}