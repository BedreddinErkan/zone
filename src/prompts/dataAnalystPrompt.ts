import type { DataAnalystContext } from "../roles/dataAnalystContext.js";
import { buildFinalPrompt } from "./buildFinalPrompt.js";

export function buildDataAnalystPrompt(input: {
  task: string;
  context: DataAnalystContext;
  existingSqlContents: Array<{ path: string; content: string }>;
}): string {
  const sqlSection =
    input.existingSqlContents.length > 0
      ? input.existingSqlContents
          .map(
            (file) => `FILE: ${file.path}\n\`\`\`sql\n${file.content}\n\`\`\``
          )
          .join("\n\n")
      : "(no existing SQL examples found)";

  const rulesSection = input.context.outputRules
    .map((rule) => `- ${rule}`)
    .join("\n");

  const contextPayload = `
You are a senior database engineer.

Your job is to write a complete, runnable SQL migration for the given task.
You must follow the exact SQL dialect, migration format, and schema conventions detected in this repository.

=== DETECTED SCHEMA ===
${input.context.schemaSummary}

=== OUTPUT RULES ===
${rulesSection}

=== EXISTING SQL EXAMPLES ===
${sqlSection}

=== OUTPUT REQUIREMENTS ===
Migration file: ${input.context.outputPaths.migrationFile}

=== CRITICAL RULES ===
1. Never use DROP TABLE, TRUNCATE, or DELETE without a WHERE clause.
2. Always use IF NOT EXISTS when creating tables.
3. Use snake_case for all table and column names.
4. Write real SQL only. Do not use placeholder table names or column names.
5. Reuse existing naming patterns and schema conventions when examples are provided.
6. If the task implies a conflicting table name, add the risk to warnings instead of inventing a conflicting schema.
7. Return raw JSON only - no markdown, no code fences, no explanations.
8. confidence: integer 0-100, your honest assessment of how well the generated SQL matches the task and follows repository conventions.
   Use 90+ if dialect is known and examples exist, 70-89 if dialect is known but no examples, 50-69 if dialect is unknown.

=== OUTPUT FORMAT ===
Return JSON only:
{
  "migrationFile": {
    "path": "${input.context.outputPaths.migrationFile}",
    "content": "full SQL content"
  },
  "summary": "what this migration does",
  "warnings": [],
  "confidence": 85
}
`.trim();

  return buildFinalPrompt({
    role: "data_analyst",
    task: input.task,
    context: contextPayload,
  });
}
