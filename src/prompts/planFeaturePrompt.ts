import type { TaskIntent } from "../core/taskIntentParser.js";

export function buildPlanFeaturePrompt(input: {
  task: string;
  intent: TaskIntent;
  repoSummary: string;
  relevantFilesSummary: string;
  schemaAwareSummary?: string;
}): string {
  return `
You are an expert software engineering agent working inside an existing production-style codebase.

Your job is to analyze the requested feature and return a STRICT JSON object only.

You must respect the existing architecture, detected storage model, detected auth patterns, and detected response conventions.

=== TASK ===
${input.task}

=== INTENT ===
- action: ${input.intent.action}
- resourceKind: ${input.intent.resourceKind}
- scope: ${input.intent.scope}
- parentResource: ${input.intent.parentResource ?? "unknown"}
- nestedResource: ${input.intent.nestedResource ?? "none"}
- mentionsNestedItem: ${input.intent.mentionsNestedItem ? "yes" : "no"}
- destructiveRisk: ${input.intent.destructiveRisk ? "yes" : "no"}

=== PROJECT SUMMARY ===
${input.repoSummary}

=== RELEVANT FILES ===
${input.relevantFilesSummary || "(none)"}

=== SCHEMA-AWARE SUMMARY ===
${input.schemaAwareSummary || "No schema-aware summary available."}

STRICT RULES:
1. If schema-aware summary indicates known tables or columns, you MUST NOT invent different table names or columns.
2. If storage kind is "separate_table", prefer nested-resource architecture using that table.
3. If storage kind is "json_field", prefer updating the parent record field instead of inventing a new table.
4. If storage kind is unknown, explicitly mention that uncertainty in the risks section.
5. Reuse detected auth middleware and response conventions when suggesting backend changes.
6. Keep suggested files focused and minimal. Do not include speculative files unless clearly justified.
7. For delete/update of nested resources, preserve the parent resource unless the task explicitly requests parent deletion.
8. Prefer consistency with existing route/controller/service patterns over idealized greenfield architecture.
9. If a route or handler likely already exists, suggest inspecting it before creating a new one.
10. Do not output markdown. Do not wrap JSON in code fences. Return raw JSON only.

THINKING GUIDELINES:
- First determine whether the task targets a parent resource or a nested resource.
- Then determine whether the change belongs in backend, frontend, or both.
- Then identify the minimum file set needed.
- Prefer modifying existing files over creating new files unless new files are clearly necessary.
- For multi-tenant systems, preserve clinic/org scoping if detected in the project summary or schema-aware summary.

Return JSON only with this exact shape:
{
  "implementationSummary": "string",
  "steps": ["string"],
  "suggestedFiles": [
    {
      "path": "string",
      "reason": "string",
      "action": "modify" | "create" | "inspect"
    }
  ],
  "risks": ["string"]
}
`.trim();
}