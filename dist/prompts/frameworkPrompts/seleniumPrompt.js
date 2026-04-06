"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSeleniumPrompt = buildSeleniumPrompt;
function buildSeleniumPrompt() {
    return [
        "FRAMEWORK AUGMENTATION",
        "- Preserve the existing language, runner, and page-object style.",
        "- Reuse waits, utilities, and base classes when present.",
        "- Do not mix Playwright or Cypress patterns into Selenium output.",
    ].join("\n");
}
//# sourceMappingURL=seleniumPrompt.js.map