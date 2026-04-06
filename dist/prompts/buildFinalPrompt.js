"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFinalPrompt = buildFinalPrompt;
const globalPrompt_js_1 = require("./globalPrompt.js");
const developerPrompt_js_1 = require("./rolePrompts/developerPrompt.js");
const testEngineerPrompt_js_1 = require("./rolePrompts/testEngineerPrompt.js");
const dataAnalystPrompt_js_1 = require("./rolePrompts/dataAnalystPrompt.js");
const playwrightPrompt_js_1 = require("./frameworkPrompts/playwrightPrompt.js");
const cypressPrompt_js_1 = require("./frameworkPrompts/cypressPrompt.js");
const seleniumPrompt_js_1 = require("./frameworkPrompts/seleniumPrompt.js");
const cucumberPrompt_js_1 = require("./frameworkPrompts/cucumberPrompt.js");
function buildRolePrompt(role) {
    switch (role) {
        case "developer":
            return (0, developerPrompt_js_1.buildDeveloperRolePrompt)();
        case "test_engineer":
            return (0, testEngineerPrompt_js_1.buildTestEngineerRolePrompt)();
        case "data_analyst":
            return (0, dataAnalystPrompt_js_1.buildDataAnalystRolePrompt)();
    }
}
function buildFrameworkPrompt(role, framework) {
    if (role !== "test_engineer" || !framework || framework === "unknown") {
        return null;
    }
    switch (framework) {
        case "playwright_ts":
        case "playwright_js":
            return (0, playwrightPrompt_js_1.buildPlaywrightPrompt)();
        case "cypress":
            return (0, cypressPrompt_js_1.buildCypressPrompt)();
        case "selenium_java":
        case "selenium_python":
        case "junit":
        case "testng":
            return (0, seleniumPrompt_js_1.buildSeleniumPrompt)();
        case "cucumber_java":
            return (0, cucumberPrompt_js_1.buildCucumberPrompt)();
        default:
            return null;
    }
}
function buildFinalPrompt(input) {
    const frameworkPrompt = buildFrameworkPrompt(input.role, input.detectedFramework);
    return [
        (0, globalPrompt_js_1.buildGlobalPrompt)(),
        buildRolePrompt(input.role),
        frameworkPrompt,
        "REPOSITORY / CONTEXT PAYLOAD",
        input.context.trim(),
        "USER TASK",
        input.task,
    ]
        .filter(Boolean)
        .join("\n\n");
}
//# sourceMappingURL=buildFinalPrompt.js.map