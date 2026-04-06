export function buildGlobalPrompt(): string {
  return [
    "GLOBAL RULES",
    "- Preserve repository structure, naming, and existing patterns.",
    "- Prefer modifying existing relevant files over creating new ones.",
    "- Never generate filenames from raw user task text.",
    "- Infer names and placement only from repository evidence.",
    "- Avoid invented selectors, APIs, helpers, or utilities when evidence is missing.",
    "- Keep changes minimal, deterministic, and explainable.",
  ].join("\n");
}
