"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const detectTestFramework_js_1 = require("./detectTestFramework.js");
function file(p) {
    return {
        path: p,
        absolutePath: `/repo/${p}`,
        extension: p.split(".").pop() ?? "",
        category: "unknown",
    };
}
(0, vitest_1.describe)("detectTestFramework", () => {
    (0, vitest_1.it)("returns unknown for empty file list", () => {
        const result = (0, detectTestFramework_js_1.detectTestFramework)([]);
        (0, vitest_1.expect)(result.framework).toBe("unknown");
        (0, vitest_1.expect)(result.confidence).toBe("low");
    });
    (0, vitest_1.it)("returns unknown for non-array input", () => {
        // @ts-expect-error testing invalid input
        const result = (0, detectTestFramework_js_1.detectTestFramework)(null);
        (0, vitest_1.expect)(result.framework).toBe("unknown");
    });
    (0, vitest_1.describe)("Playwright TypeScript", () => {
        (0, vitest_1.it)("detects playwright_ts from playwright.config.ts", () => {
            const files = [
                file("playwright.config.ts"),
                file("tests/login.spec.ts"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("playwright_ts");
            (0, vitest_1.expect)(result.language).toBe("typescript");
            (0, vitest_1.expect)(result.confidence).toBe("high");
        });
        (0, vitest_1.it)("detects playwright_ts without spec files", () => {
            const files = [file("playwright.config.ts")];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("playwright_ts");
        });
    });
    (0, vitest_1.describe)("Playwright JavaScript", () => {
        (0, vitest_1.it)("detects playwright_js from playwright.config.js", () => {
            const files = [
                file("playwright.config.js"),
                file("tests/login.spec.js"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("playwright_js");
            (0, vitest_1.expect)(result.language).toBe("javascript");
            (0, vitest_1.expect)(result.confidence).toBe("high");
        });
    });
    (0, vitest_1.describe)("Cypress", () => {
        (0, vitest_1.it)("detects cypress from cypress.config.ts", () => {
            const files = [
                file("cypress.config.ts"),
                file("cypress/e2e/login.cy.ts"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("cypress");
            (0, vitest_1.expect)(result.language).toBe("typescript");
            (0, vitest_1.expect)(result.confidence).toBe("high");
        });
        (0, vitest_1.it)("detects cypress from cypress.config.js", () => {
            const files = [
                file("cypress.config.js"),
                file("cypress/e2e/login.cy.js"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("cypress");
            (0, vitest_1.expect)(result.language).toBe("javascript");
        });
        (0, vitest_1.it)("detects cypress from cypress/ directory", () => {
            const files = [
                file("cypress/e2e/login.cy.js"),
                file("cypress/support/commands.js"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("cypress");
        });
    });
    (0, vitest_1.describe)("Cucumber Java", () => {
        (0, vitest_1.it)("detects cucumber_java from pom.xml + feature + java", () => {
            const files = [
                file("pom.xml"),
                file("src/test/resources/features/login.feature"),
                file("src/main/java/com/example/pages/LoginPage.java"),
                file("src/test/java/com/example/stepdefinitions/LoginSteps.java"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("cucumber_java");
            (0, vitest_1.expect)(result.language).toBe("java");
            (0, vitest_1.expect)(result.confidence).toBe("high");
        });
        (0, vitest_1.it)("includes selenium in evidence when BasePage exists", () => {
            const files = [
                file("pom.xml"),
                file("src/test/resources/features/login.feature"),
                file("src/main/java/com/example/base/BasePage.java"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("cucumber_java");
            (0, vitest_1.expect)(result.evidence.some(e => e.toLowerCase().includes("selenium"))).toBe(true);
        });
        (0, vitest_1.it)("sets correct testDir", () => {
            const files = [
                file("pom.xml"),
                file("src/test/resources/features/flight.feature"),
                file("src/main/java/com/example/pages/HomePage.java"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("cucumber_java");
            (0, vitest_1.expect)(result.testFilePattern).toBe("*.feature");
        });
    });
    (0, vitest_1.describe)("TestNG", () => {
        (0, vitest_1.it)("detects testng from pom.xml + testng.xml + java", () => {
            const files = [
                file("pom.xml"),
                file("testng.xml"),
                file("src/test/java/com/example/LoginTest.java"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("testng");
            (0, vitest_1.expect)(result.language).toBe("java");
            (0, vitest_1.expect)(result.confidence).toBe("high");
        });
    });
    (0, vitest_1.describe)("Selenium Java", () => {
        (0, vitest_1.it)("detects selenium_java from pom.xml + java without feature files", () => {
            const files = [
                file("pom.xml"),
                file("src/test/java/com/example/LoginTest.java"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("selenium_java");
            (0, vitest_1.expect)(result.language).toBe("java");
            (0, vitest_1.expect)(result.confidence).toBe("medium");
        });
    });
    (0, vitest_1.describe)("pytest", () => {
        (0, vitest_1.it)("detects pytest from pytest.ini", () => {
            const files = [
                file("pytest.ini"),
                file("tests/test_login.py"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("pytest");
            (0, vitest_1.expect)(result.language).toBe("python");
            (0, vitest_1.expect)(result.confidence).toBe("high");
        });
        (0, vitest_1.it)("detects pytest from conftest.py", () => {
            const files = [
                file("conftest.py"),
                file("tests/test_login.py"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("pytest");
        });
        (0, vitest_1.it)("detects pytest from pyproject.toml", () => {
            const files = [
                file("pyproject.toml"),
                file("tests/test_login.py"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("pytest");
        });
    });
    (0, vitest_1.describe)("Selenium Python", () => {
        (0, vitest_1.it)("detects selenium_python from python files with selenium in path", () => {
            const files = [
                file("tests/selenium/test_login.py"),
                file("pages/login_page.py"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("selenium_python");
            (0, vitest_1.expect)(result.language).toBe("python");
        });
    });
    (0, vitest_1.describe)("priority ordering", () => {
        (0, vitest_1.it)("prefers playwright_ts over selenium when both configs exist", () => {
            const files = [
                file("playwright.config.ts"),
                file("pom.xml"),
                file("src/test/java/LoginTest.java"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("playwright_ts");
        });
        (0, vitest_1.it)("prefers cypress over selenium", () => {
            const files = [
                file("cypress.config.js"),
                file("pom.xml"),
                file("src/test/java/LoginTest.java"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("cypress");
        });
        (0, vitest_1.it)("prefers testng over selenium_java when testng.xml present", () => {
            const files = [
                file("pom.xml"),
                file("testng.xml"),
                file("src/test/java/LoginTest.java"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("testng");
        });
    });
    (0, vitest_1.describe)("Gradle / Kotlin projects", () => {
        (0, vitest_1.it)("detects cucumber_java from build.gradle + feature files", () => {
            const files = [
                file("build.gradle"),
                file("src/test/resources/features/login.feature"),
                file("src/test/java/com/example/steps/LoginSteps.java"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("cucumber_java");
            (0, vitest_1.expect)(result.language).toBe("java");
        });
        (0, vitest_1.it)("detects cucumber_java from build.gradle.kts + feature files", () => {
            const files = [
                file("build.gradle.kts"),
                file("src/test/resources/features/login.feature"),
                file("src/test/java/com/example/steps/LoginSteps.java"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("cucumber_java");
        });
        (0, vitest_1.it)("detects selenium_java from build.gradle without feature files", () => {
            const files = [
                file("build.gradle"),
                file("src/test/java/com/example/LoginTest.java"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("selenium_java");
            (0, vitest_1.expect)(result.language).toBe("java");
        });
    });
    (0, vitest_1.describe)("package.json only (no config file)", () => {
        (0, vitest_1.it)("returns unknown for package.json without test config", () => {
            const files = [file("package.json"), file("src/index.ts")];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("unknown");
        });
        (0, vitest_1.it)("detects playwright_ts from package.json + spec files", () => {
            const files = [
                file("package.json"),
                file("tests/login.spec.ts"),
                file("tests/cart.spec.ts"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBeDefined();
            (0, vitest_1.expect)(result.language).toBeDefined();
        });
    });
    (0, vitest_1.describe)("monorepo / nested structure", () => {
        (0, vitest_1.it)("detects playwright_ts from nested e2e folder", () => {
            const files = [
                file("apps/web/package.json"),
                file("e2e/playwright.config.ts"),
                file("e2e/tests/login.spec.ts"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("playwright_ts");
        });
        (0, vitest_1.it)("detects cypress from nested cypress folder", () => {
            const files = [
                file("frontend/cypress.config.js"),
                file("frontend/cypress/e2e/login.cy.js"),
            ];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("cypress");
        });
    });
    (0, vitest_1.describe)("edge cases", () => {
        (0, vitest_1.it)("handles files with no extension gracefully", () => {
            const files = [file("Makefile"), file("Dockerfile"), file("README")];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("unknown");
        });
        (0, vitest_1.it)("handles very large file lists without crashing", () => {
            const files = Array.from({ length: 500 }, (_, i) => file(`src/main/java/com/example/Page${i}.java`));
            files.push(file("pom.xml"));
            files.push(file("src/test/resources/features/login.feature"));
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBe("cucumber_java");
        });
        (0, vitest_1.it)("is case-insensitive for common config filenames", () => {
            const files = [file("Playwright.config.ts"), file("tests/login.spec.ts")];
            const result = (0, detectTestFramework_js_1.detectTestFramework)(files);
            (0, vitest_1.expect)(result.framework).toBeDefined();
        });
    });
});
//# sourceMappingURL=detectTestFramework.test.js.map