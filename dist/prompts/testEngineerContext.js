"use strict";
// src/roles/testEngineerContext.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTestEngineerContext = buildTestEngineerContext;
function findPageObjects(files) {
    return files.filter((f) => f.path.includes("Page") ||
        f.path.includes("page") ||
        f.path.includes("pages/") ||
        f.path.includes("pageobjects/") ||
        f.path.includes("PageObjects/"));
}
function findStepDefinitions(files) {
    return files.filter((f) => f.path.includes("steps/") ||
        f.path.includes("stepdefinitions/") ||
        f.path.includes("step_definitions/") ||
        f.path.includes("Steps.java") ||
        f.path.includes("_steps.py"));
}
function findFeatureFiles(files) {
    return files.filter((f) => f.path.endsWith(".feature"));
}
function findConfigFiles(files) {
    return files.filter((f) => f.path.includes("playwright.config") ||
        f.path.includes("cypress.config") ||
        f.path.includes("pytest.ini") ||
        f.path.includes("conftest.py") ||
        f.path.includes("testng.xml") ||
        f.path.includes("pom.xml") ||
        f.path.includes("build.gradle"));
}
function findExistingTestFiles(files, framework) {
    switch (framework.framework) {
        case "playwright_ts":
            return files.filter((f) => f.path.endsWith(".spec.ts") || f.path.endsWith(".test.ts"));
        case "playwright_js":
            return files.filter((f) => f.path.endsWith(".spec.js") || f.path.endsWith(".test.js"));
        case "cypress":
            return files.filter((f) => f.path.endsWith(".cy.ts") || f.path.endsWith(".cy.js"));
        case "cucumber_java":
            return files.filter((f) => f.path.endsWith(".feature"));
        case "selenium_java":
        case "junit":
        case "testng":
            return files.filter((f) => f.path.endsWith("Test.java") || f.path.endsWith("Tests.java"));
        case "pytest":
        case "selenium_python":
            return files.filter((f) => f.path.startsWith("test_") || f.path.includes("/test_"));
        default:
            return [];
    }
}
function buildFrameworkSummary(framework) {
    const lines = [];
    lines.push(`Test Framework: ${framework.framework}`);
    lines.push(`Language: ${framework.language}`);
    lines.push(`Confidence: ${framework.confidence}`);
    lines.push(`Evidence: ${framework.evidence.join(", ")}`);
    if (framework.testDir) {
        lines.push(`Test Directory: ${framework.testDir}`);
    }
    return lines.join("\n");
}
function buildPromptHints(framework, pageObjects, stepDefs, existingTests) {
    const hints = [];
    switch (framework.framework) {
        case "playwright_ts":
            hints.push("Use TypeScript with Playwright test library");
            hints.push("Import { test, expect } from '@playwright/test'");
            hints.push("Use page.goto(), page.locator(), page.click() patterns");
            hints.push("Place test files in the existing test directory");
            if (pageObjects.length > 0) {
                hints.push(`Reuse existing page objects: ${pageObjects.map((f) => f.path).join(", ")}`);
            }
            break;
        case "playwright_js":
            hints.push("Use JavaScript with Playwright test library");
            hints.push("Import { test, expect } from '@playwright/test'");
            hints.push("Use page.goto(), page.locator(), page.click() patterns");
            break;
        case "cypress":
            hints.push("Use Cypress test syntax with cy.* commands");
            hints.push("Use cy.get(), cy.contains(), cy.visit() patterns");
            hints.push("Place tests in cypress/e2e/ directory");
            break;
        case "cucumber_java":
            hints.push("Write Gherkin feature file with Given/When/Then syntax");
            hints.push("Write Java step definitions with @Given, @When, @Then annotations");
            hints.push("Import io.cucumber.java.en.Given/When/Then");
            hints.push(`Place feature file in: ${framework.testDir ?? "src/test/resources/features/"}`);
            hints.push("Place step definitions in: src/test/java/com/*/stepdefinitions/");
            if (pageObjects.length > 0) {
                hints.push(`Inject existing page objects via constructor: ${pageObjects.map((f) => f.path).join(", ")}`);
                hints.push("NEVER create new WebDriver instances — use existing page objects");
            }
            if (stepDefs.length > 0) {
                hints.push(`Follow existing step definition patterns from: ${stepDefs.map((f) => f.path).join(", ")}`);
            }
            break;
        case "selenium_java":
        case "junit":
            hints.push("Use JUnit 5 annotations: @Test, @BeforeEach, @AfterEach");
            hints.push("Use Selenium WebDriver for browser interactions");
            if (pageObjects.length > 0) {
                hints.push(`Reuse existing page objects: ${pageObjects.map((f) => f.path).join(", ")}`);
            }
            break;
        case "testng":
            hints.push("Use TestNG annotations: @Test, @BeforeMethod, @AfterMethod");
            hints.push("Use Selenium WebDriver for browser interactions");
            if (pageObjects.length > 0) {
                hints.push(`Reuse existing page objects: ${pageObjects.map((f) => f.path).join(", ")}`);
            }
            break;
        case "pytest":
        case "selenium_python":
            hints.push("Use pytest fixtures and test functions starting with test_");
            hints.push("Use selenium.webdriver for browser automation");
            if (pageObjects.length > 0) {
                hints.push(`Reuse existing page objects: ${pageObjects.map((f) => f.path).join(", ")}`);
            }
            break;
    }
    if (existingTests.length > 0) {
        hints.push(`Follow patterns from existing tests: ${existingTests.slice(0, 3).map((f) => f.path).join(", ")}`);
    }
    return hints;
}
function buildOutputPaths(framework, task) {
    const slug = task
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .slice(0, 40);
    const base = framework.testDir ?? "tests";
    switch (framework.framework) {
        case "playwright_ts":
            return { testFile: `${base}/${slug}.spec.ts` };
        case "playwright_js":
            return { testFile: `${base}/${slug}.spec.js` };
        case "cypress":
            return { testFile: `cypress/e2e/${slug}.cy.ts` };
        case "cucumber_java":
            return {
                testFile: `src/test/resources/features/${slug}.feature`,
                featureFile: `src/test/resources/features/${slug}.feature`,
                stepDefinition: `src/test/java/com/stepdefinitions/${toPascalCase(slug)}Steps.java`,
            };
        case "selenium_java":
        case "junit":
        case "testng":
            return {
                testFile: `src/test/java/${toPascalCase(slug)}Test.java`,
            };
        case "pytest":
        case "selenium_python":
            return { testFile: `tests/test_${slug}.py` };
        default:
            return { testFile: `tests/${slug}.test` };
    }
}
function toPascalCase(str) {
    return str
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join("");
}
function buildTestEngineerContext(task, framework, allFiles) {
    const existingTestFiles = findExistingTestFiles(allFiles, framework);
    const pageObjectFiles = findPageObjects(allFiles);
    const stepDefinitionFiles = findStepDefinitions(allFiles);
    const featureFiles = findFeatureFiles(allFiles);
    const configFiles = findConfigFiles(allFiles);
    return {
        framework,
        existingTestFiles,
        pageObjectFiles,
        stepDefinitionFiles,
        featureFiles,
        configFiles,
        frameworkSummary: buildFrameworkSummary(framework),
        promptHints: buildPromptHints(framework, pageObjectFiles, stepDefinitionFiles, existingTestFiles),
        outputPaths: buildOutputPaths(framework, task),
    };
}
//# sourceMappingURL=testEngineerContext.js.map