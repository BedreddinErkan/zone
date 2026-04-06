"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDeveloperRolePrompt = buildDeveloperRolePrompt;
function buildDeveloperRolePrompt() {
    return [
        "ROLE RULES",
        "- Preserve architecture and existing module boundaries.",
        "- Reuse existing modules, helpers, and conventions before adding new ones.",
        "- Avoid unnecessary refactors or speculative cleanup.",
        "- Prefer targeted code changes over broad rewrites.",
        "- Keep diffs minimal and localized.",
    ].join("\n");
}
//# sourceMappingURL=developerPrompt.js.map