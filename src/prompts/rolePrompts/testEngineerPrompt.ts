export function buildTestEngineerRolePrompt(): string {
  return [
    "ROLE RULES",
    "- Inspect existing tests first and extend relevant files when possible.",
    "- Avoid inventing selectors, fixtures, helpers, or filenames.",
    "- Reuse repository-native test patterns and assertions.",
    "- Keep tests framework-consistent and grounded in repository evidence.",
    "- Prefer minimal, relevant additions over brand-new test scaffolding.",
  ].join("\n");
}
