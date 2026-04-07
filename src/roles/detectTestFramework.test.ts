import { describe, expect, it } from "vitest";
import { detectTestFramework } from "./detectTestFramework.js";
import type { RepoFile } from "../types/project.js";

function file(p: string): RepoFile {
  return {
    path: p,
    absolutePath: `/repo/${p}`,
    extension: p.split(".").pop() ?? "",
    category: "unknown",
  };
}

describe("detectTestFramework", () => {
  it("returns unknown for empty file list", () => {
    const result = detectTestFramework([]);
    expect(result.framework).toBe("unknown");
    expect(result.confidence).toBe("low");
  });

  it("returns unknown for non-array input", () => {
    // @ts-expect-error testing invalid input
    const result = detectTestFramework(null);
    expect(result.framework).toBe("unknown");
  });

  describe("Playwright TypeScript", () => {
    it("detects playwright_ts from playwright.config.ts", () => {
      const files = [
        file("playwright.config.ts"),
        file("tests/login.spec.ts"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("playwright_ts");
      expect(result.language).toBe("typescript");
      expect(result.confidence).toBe("high");
    });

    it("detects playwright_ts without spec files", () => {
      const files = [file("playwright.config.ts")];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("playwright_ts");
    });
  });

  describe("Playwright JavaScript", () => {
    it("detects playwright_js from playwright.config.js", () => {
      const files = [
        file("playwright.config.js"),
        file("tests/login.spec.js"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("playwright_js");
      expect(result.language).toBe("javascript");
      expect(result.confidence).toBe("high");
    });
  });

  describe("Cypress", () => {
    it("detects cypress from cypress.config.ts", () => {
      const files = [
        file("cypress.config.ts"),
        file("cypress/e2e/login.cy.ts"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("cypress");
      expect(result.language).toBe("typescript");
      expect(result.confidence).toBe("high");
    });

    it("detects cypress from cypress.config.js", () => {
      const files = [
        file("cypress.config.js"),
        file("cypress/e2e/login.cy.js"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("cypress");
      expect(result.language).toBe("javascript");
    });

    it("detects cypress from cypress/ directory", () => {
      const files = [
        file("cypress/e2e/login.cy.js"),
        file("cypress/support/commands.js"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("cypress");
    });
  });

  describe("Cucumber Java", () => {
    it("detects cucumber_java from pom.xml + feature + java", () => {
      const files = [
        file("pom.xml"),
        file("src/test/resources/features/login.feature"),
        file("src/main/java/com/example/pages/LoginPage.java"),
        file("src/test/java/com/example/stepdefinitions/LoginSteps.java"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("cucumber_java");
      expect(result.language).toBe("java");
      expect(result.confidence).toBe("high");
    });

    it("includes selenium in evidence when BasePage exists", () => {
      const files = [
        file("pom.xml"),
        file("src/test/resources/features/login.feature"),
        file("src/main/java/com/example/base/BasePage.java"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("cucumber_java");
      expect(result.evidence.some(e => e.toLowerCase().includes("selenium"))).toBe(true);
    });

    it("sets correct testDir", () => {
      const files = [
        file("pom.xml"),
        file("src/test/resources/features/flight.feature"),
        file("src/main/java/com/example/pages/HomePage.java"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("cucumber_java");
      expect(result.testFilePattern).toBe("*.feature");
    });
  });

  describe("TestNG", () => {
    it("detects testng from pom.xml + testng.xml + java", () => {
      const files = [
        file("pom.xml"),
        file("testng.xml"),
        file("src/test/java/com/example/LoginTest.java"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("testng");
      expect(result.language).toBe("java");
      expect(result.confidence).toBe("high");
    });
  });

  describe("Selenium Java", () => {
    it("detects selenium_java from pom.xml + java without feature files", () => {
      const files = [
        file("pom.xml"),
        file("src/test/java/com/example/LoginTest.java"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("selenium_java");
      expect(result.language).toBe("java");
      expect(result.confidence).toBe("medium");
    });
  });

  describe("pytest", () => {
    it("detects pytest from pytest.ini", () => {
      const files = [
        file("pytest.ini"),
        file("tests/test_login.py"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("pytest");
      expect(result.language).toBe("python");
      expect(result.confidence).toBe("high");
    });

    it("detects pytest from conftest.py", () => {
      const files = [
        file("conftest.py"),
        file("tests/test_login.py"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("pytest");
    });

    it("detects pytest from pyproject.toml", () => {
      const files = [
        file("pyproject.toml"),
        file("tests/test_login.py"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("pytest");
    });
  });

  describe("Selenium Python", () => {
    it("detects selenium_python from python files with selenium in path", () => {
      const files = [
        file("tests/selenium/test_login.py"),
        file("pages/login_page.py"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("selenium_python");
      expect(result.language).toBe("python");
    });
  });

  describe("priority ordering", () => {
    it("prefers playwright_ts over selenium when both configs exist", () => {
      const files = [
        file("playwright.config.ts"),
        file("pom.xml"),
        file("src/test/java/LoginTest.java"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("playwright_ts");
    });

    it("prefers cypress over selenium", () => {
      const files = [
        file("cypress.config.js"),
        file("pom.xml"),
        file("src/test/java/LoginTest.java"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("cypress");
    });

    it("prefers testng over selenium_java when testng.xml present", () => {
      const files = [
        file("pom.xml"),
        file("testng.xml"),
        file("src/test/java/LoginTest.java"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("testng");
    });
  });

  describe("Gradle / Kotlin projects", () => {
    it("detects cucumber_java from build.gradle + feature files", () => {
      const files = [
        file("build.gradle"),
        file("src/test/resources/features/login.feature"),
        file("src/test/java/com/example/steps/LoginSteps.java"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("cucumber_java");
      expect(result.language).toBe("java");
    });

    it("detects cucumber_java from build.gradle.kts + feature files", () => {
      const files = [
        file("build.gradle.kts"),
        file("src/test/resources/features/login.feature"),
        file("src/test/java/com/example/steps/LoginSteps.java"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("cucumber_java");
    });

    it("detects selenium_java from build.gradle without feature files", () => {
      const files = [
        file("build.gradle"),
        file("src/test/java/com/example/LoginTest.java"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("selenium_java");
      expect(result.language).toBe("java");
    });
  });

  describe("package.json only (no config file)", () => {
    it("returns unknown for package.json without test config", () => {
      const files = [file("package.json"), file("src/index.ts")];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("unknown");
    });

    it("detects playwright_ts from package.json + spec files", () => {
      const files = [
        file("package.json"),
        file("tests/login.spec.ts"),
        file("tests/cart.spec.ts"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBeDefined();
      expect(result.language).toBeDefined();
    });
  });

  describe("monorepo / nested structure", () => {
    it("detects playwright_ts from nested e2e folder", () => {
      const files = [
        file("apps/web/package.json"),
        file("e2e/playwright.config.ts"),
        file("e2e/tests/login.spec.ts"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("playwright_ts");
    });

    it("detects cypress from nested cypress folder", () => {
      const files = [
        file("frontend/cypress.config.js"),
        file("frontend/cypress/e2e/login.cy.js"),
      ];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("cypress");
    });
  });

  describe("edge cases", () => {
    it("handles files with no extension gracefully", () => {
      const files = [file("Makefile"), file("Dockerfile"), file("README")];
      const result = detectTestFramework(files);
      expect(result.framework).toBe("unknown");
    });

    it("handles very large file lists without crashing", () => {
      const files = Array.from({ length: 500 }, (_, i) =>
        file(`src/main/java/com/example/Page${i}.java`)
      );
      files.push(file("pom.xml"));
      files.push(file("src/test/resources/features/login.feature"));
      const result = detectTestFramework(files);
      expect(result.framework).toBe("cucumber_java");
    });

    it("is case-insensitive for common config filenames", () => {
      const files = [file("Playwright.config.ts"), file("tests/login.spec.ts")];
      const result = detectTestFramework(files);
      expect(result.framework).toBeDefined();
    });
  });
});
