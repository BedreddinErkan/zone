"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCypressPrompt = buildCypressPrompt;
function buildCypressPrompt() {
    return [
        "FRAMEWORK AUGMENTATION",
        "- Reuse custom commands, helpers, and fixtures when they exist.",
        "- Preserve Cypress idioms and command style.",
        "- Do not mix Playwright or Selenium patterns into Cypress output.",
        "- Follow the existing Cypress structure and file placement.",
    ].join("\n");
}
//# sourceMappingURL=cypressPrompt.js.map