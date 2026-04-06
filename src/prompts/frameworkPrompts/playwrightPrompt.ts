export function buildPlaywrightPrompt(): string {
  return [
    "FRAMEWORK AUGMENTATION",
    "- Reuse page objects, helpers, and fixtures when they exist.",
    "- Reuse the repository's locator strategy.",
    "- Avoid placeholder selectors.",
    "- Follow the existing Playwright structure and imports.",
    "- Do not generate generic example specs.",
    "- Only use expect(page).toHaveURL(...) when the repository examples or context provide route evidence.",
    "- Do not invent fallback URL regex assertions such as /.*\\/#/ or other arbitrary patterns.",
    "- When route evidence is weak, prefer visible state assertions such as error messages over speculative redirect checks.",
    "- Avoid comments or assumptions that are not grounded in repository evidence.",
  ].join("\n");
}
