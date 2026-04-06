"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCucumberPrompt = buildCucumberPrompt;
function buildCucumberPrompt() {
    return [
        "FRAMEWORK AUGMENTATION",
        "- Reuse existing feature and step-definition style.",
        "- Avoid duplicate step phrases when repository phrasing already exists.",
        "- Infer feature naming from repository evidence, not the raw user task text.",
        "- Preserve the existing Gherkin tone, structure, and file layout.",
    ].join("\n");
}
//# sourceMappingURL=cucumberPrompt.js.map