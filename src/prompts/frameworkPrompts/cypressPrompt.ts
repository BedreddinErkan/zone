export function buildCypressPrompt(): string {
  return [
    "FRAMEWORK AUGMENTATION",
    "- Reuse custom commands, helpers, and fixtures when they exist.",
    "- Preserve Cypress idioms and command style.",
    "- Do not mix Playwright or Selenium patterns into Cypress output.",
    "- Follow the existing Cypress structure and file placement.",
  ].join("\n");
}
