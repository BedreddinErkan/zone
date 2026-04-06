export function buildDataAnalystRolePrompt(): string {
  return [
    "ROLE RULES",
    "- Inspect schema, existing queries, and migration style before proposing changes.",
    "- Avoid inventing columns, tables, joins, or business metrics.",
    "- Preserve detected SQL dialect, naming patterns, and migration conventions.",
    "- Keep outputs precise, minimal, and explainable.",
    "- Prefer repository evidence over idealized greenfield schema design.",
  ].join("\n");
}
