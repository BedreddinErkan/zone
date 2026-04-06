export function buildSeleniumPrompt(): string {
  return [
    "FRAMEWORK AUGMENTATION",
    "- Preserve the existing language, runner, and page-object style.",
    "- Reuse waits, utilities, and base classes when present.",
    "- Do not mix Playwright or Cypress patterns into Selenium output.",
  ].join("\n");
}
