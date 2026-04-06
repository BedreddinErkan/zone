export function buildDeveloperRolePrompt(): string {
  return [
    "ROLE RULES",
    "- Preserve architecture and existing module boundaries.",
    "- Reuse existing modules, helpers, and conventions before adding new ones.",
    "- Avoid unnecessary refactors or speculative cleanup.",
    "- Prefer targeted code changes over broad rewrites.",
    "- Keep diffs minimal and localized.",
  ].join("\n");
}
