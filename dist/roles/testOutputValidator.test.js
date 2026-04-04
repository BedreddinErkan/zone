"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const testOutputValidator_js_1 = require("./testOutputValidator.js");
const VALID_FEATURE = `
Feature: Round Trip Flight Search
  Scenario Outline: Search for a round-trip flight
    Given I open the home page
    When I search for a round-trip flight from "<from>" to "<to>"
    Then I should see the flight results
    Examples:
      | from     | to     |
      | Istanbul | Ankara |
`.trim();
const VALID_STEP_DEF = `
package com.enuygun.stepdefinitions;
import com.enuygun.pages.HomePage;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.When;
import io.cucumber.java.en.Then;
public class RoundTripFlightSearchSteps {
  private HomePage homePage;
  public RoundTripFlightSearchSteps(HomePage homePage) {
    this.homePage = homePage;
  }
  @Given("I open the home page")
  public void i_open_the_home_page() {
    homePage.openHomePage();
  }
  @When("I search for a round-trip flight from {string} to {string}")
  public void i_search_for_a_round_trip_flight(String from, String to) {
    homePage.selectRoundTrip(from, to);
  }
  @Then("I should see the flight results")
  public void i_should_see_the_flight_results() {
    flightResultsPage.isResultsPageDisplayed();
  }
}
`.trim();
const PAGE_OBJECT = {
    path: "src/main/java/com/enuygun/pages/HomePage.java",
    content: `
package com.enuygun.pages;
public class HomePage {
  public void openHomePage() {}
  public void selectRoundTrip(String from, String to) {}
  public void setDepartureDate(String date) {}
  public void setReturnDate(String date) {}
  public void clickSearch() {}
}
`.trim(),
};
const VALID_PLAYWRIGHT_TEST = `
import { test, expect } from "@playwright/test";

test("logs in", async ({ page }) => {
  await page.goto("/");
  await page.locator("#user-name").fill("standard_user");
  await page.locator("[data-testid='password']").fill("secret_sauce");
  await page.locator("#login-button").click();
  await expect(page.locator(".inventory_list")).toBeVisible();
});
`.trim();
const VALID_PYTEST_TEST = `
import pytest

def test_login_redirects_to_inventory(login_page):
    login_page.login("standard_user", "secret_sauce")
    assert "/inventory" in login_page.driver.current_url
`.trim();
(0, vitest_1.describe)("validateTestOutput", () => {
    (0, vitest_1.describe)("feature validator", () => {
        (0, vitest_1.it)("passes a valid feature file", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                featureContent: VALID_FEATURE,
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.decision).toBe("pass");
            (0, vitest_1.expect)(result.issues).toHaveLength(0);
        });
        (0, vitest_1.it)("blocks a feature with no Given/When/Then", () => {
            const bad = `
Feature: Bad Feature
  Scenario: Missing steps
    And something happens
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                featureContent: bad,
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.decision).toBe("blocked");
            (0, vitest_1.expect)(result.issues.some(i => i.code === "FEATURE_MISSING_GWT")).toBe(true);
        });
        (0, vitest_1.it)("blocks a feature with no scenario", () => {
            const bad = `
Feature: No Scenario
  Given something
  When something
  Then something
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                featureContent: bad,
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.decision).toBe("blocked");
            (0, vitest_1.expect)(result.issues.some(i => i.code === "FEATURE_MISSING_SCENARIO")).toBe(true);
        });
        (0, vitest_1.it)("blocks a feature with empty examples table", () => {
            const bad = `
Feature: Empty Examples
  Scenario Outline: Search
    Given I open the page
    When I search
    Then I see results
    Examples:
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                featureContent: bad,
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.decision).toBe("blocked");
            (0, vitest_1.expect)(result.issues.some(i => i.code === "FEATURE_EMPTY_EXAMPLES")).toBe(true);
        });
        (0, vitest_1.it)("warns on placeholder URL", () => {
            const bad = `
Feature: Placeholder
  Scenario: Visit page
    Given I open the home page "https://example.com/"
    When I click login
    Then I see dashboard
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                featureContent: bad,
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.decision).toBe("preview_only");
            (0, vitest_1.expect)(result.issues.some(i => i.code === "FEATURE_PLACEHOLDER_URL")).toBe(true);
        });
        (0, vitest_1.it)("warns on missing Feature header", () => {
            const bad = `
Scenario: No header
  Given I open
  When I click
  Then I see
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                featureContent: bad,
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "FEATURE_MISSING_HEADER")).toBe(true);
        });
    });
    (0, vitest_1.describe)("step definition validator", () => {
        (0, vitest_1.it)("passes a valid step definition with matching page object", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                stepDefinitionContent: VALID_STEP_DEF,
                pageObjectContents: [PAGE_OBJECT],
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.decision).toBe("pass");
            (0, vitest_1.expect)(result.issues.filter(i => i.code === "STEP_DEF_MISSING_PAGE_METHOD")).toHaveLength(0);
        });
        (0, vitest_1.it)("warns when step def calls method not in page object", () => {
            const bad = VALID_STEP_DEF.replace("homePage.selectRoundTrip(from, to);", "homePage.searchRoundTripFlight(from, to);");
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                stepDefinitionContent: bad,
                pageObjectContents: [PAGE_OBJECT],
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "STEP_DEF_MISSING_PAGE_METHOD")).toBe(true);
        });
        (0, vitest_1.it)("warns on TODO stub", () => {
            const bad = VALID_STEP_DEF.replace("homePage.openHomePage();", "// TODO implement this");
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                stepDefinitionContent: bad,
                pageObjectContents: [PAGE_OBJECT],
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "STEP_DEF_STUB")).toBe(true);
        });
        (0, vitest_1.it)("blocks when package declaration is missing", () => {
            const bad = VALID_STEP_DEF.replace("package com.enuygun.stepdefinitions;", "");
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                stepDefinitionContent: bad,
                pageObjectContents: [PAGE_OBJECT],
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.decision).toBe("blocked");
            (0, vitest_1.expect)(result.issues.some(i => i.code === "STEP_DEF_MISSING_PACKAGE")).toBe(true);
        });
        (0, vitest_1.it)("warns when no imports found", () => {
            const bad = VALID_STEP_DEF.replace(/import .*;/g, "");
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                stepDefinitionContent: bad,
                pageObjectContents: [PAGE_OBJECT],
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "STEP_DEF_MISSING_IMPORTS")).toBe(true);
        });
    });
    (0, vitest_1.describe)("combined validation", () => {
        (0, vitest_1.it)("passes when both feature and step def are valid", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                featureContent: VALID_FEATURE,
                stepDefinitionContent: VALID_STEP_DEF,
                pageObjectContents: [PAGE_OBJECT],
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.decision).toBe("pass");
            (0, vitest_1.expect)(result.issues).toHaveLength(0);
        });
        (0, vitest_1.it)("blocks when feature has errors even if step def is valid", () => {
            const badFeature = `
Feature: Bad
  Scenario: Missing steps
    And something
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                featureContent: badFeature,
                stepDefinitionContent: VALID_STEP_DEF,
                pageObjectContents: [PAGE_OBJECT],
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.decision).toBe("blocked");
        });
        (0, vitest_1.it)("returns preview_only when only warnings exist", () => {
            const featureWithWarning = VALID_FEATURE.replace("I open the home page", 'I open "https://example.com/"');
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                featureContent: featureWithWarning,
                stepDefinitionContent: VALID_STEP_DEF,
                pageObjectContents: [PAGE_OBJECT],
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.decision).toBe("preview_only");
        });
        (0, vitest_1.it)("returns correct summary for blocked decision", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                featureContent: "no steps here",
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.summary).toContain("blocked");
        });
        (0, vitest_1.it)("returns correct summary for pass decision", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                featureContent: VALID_FEATURE,
                framework: "cucumber_java",
            });
            (0, vitest_1.expect)(result.summary).toContain("passed");
        });
    });
    (0, vitest_1.describe)("playwright validator", () => {
        (0, vitest_1.it)("warns on placeholder selector your-username", () => {
            const bad = VALID_PLAYWRIGHT_TEST.replace("#user-name", "your-username");
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                testFileContent: bad,
                framework: "playwright_ts",
            });
            (0, vitest_1.expect)(result.decision).toBe("preview_only");
            (0, vitest_1.expect)(result.issues.some(i => i.code === "PLAYWRIGHT_PLACEHOLDER_SELECTOR")).toBe(true);
        });
        (0, vitest_1.it)("warns on missing expect assertion", () => {
            const bad = VALID_PLAYWRIGHT_TEST.replace('  await expect(page.locator(".inventory_list")).toBeVisible();\n', "");
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                testFileContent: bad,
                framework: "playwright_js",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "PLAYWRIGHT_MISSING_ASSERTION")).toBe(true);
        });
        (0, vitest_1.it)("warns on hardcoded https url in goto", () => {
            const bad = VALID_PLAYWRIGHT_TEST.replace('await page.goto("/");', 'await page.goto("https://example.com/login");');
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                testFileContent: bad,
                framework: "playwright_ts",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "PLAYWRIGHT_HARDCODED_URL")).toBe(true);
        });
        (0, vitest_1.it)("passes a clean playwright test with relative url and real selectors", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                testFileContent: VALID_PLAYWRIGHT_TEST,
                framework: "playwright_ts",
            });
            (0, vitest_1.expect)(result.decision).toBe("pass");
            (0, vitest_1.expect)(result.issues).toHaveLength(0);
        });
        (0, vitest_1.it)("warns on missing await before click", () => {
            const bad = VALID_PLAYWRIGHT_TEST.replace('  await page.locator("#login-button").click();', '  page.locator("#login-button").click();');
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                testFileContent: bad,
                framework: "playwright_ts",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "PLAYWRIGHT_MISSING_AWAIT")).toBe(true);
        });
    });
    (0, vitest_1.describe)("pytest validator", () => {
        (0, vitest_1.it)("passes a clean pytest test with proper fixtures", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                testFileContent: VALID_PYTEST_TEST,
                framework: "pytest",
            });
            (0, vitest_1.expect)(result.decision).toBe("pass");
            (0, vitest_1.expect)(result.issues).toHaveLength(0);
        });
        (0, vitest_1.it)("warns on undefined fixture variable used in test body", () => {
            const bad = `
def test_login_redirects_to_inventory(login_page):
    login_page.login("standard_user", "secret_sauce")
    assert "/inventory" in driver.current_url
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                testFileContent: bad,
                framework: "selenium_python",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "PYTEST_UNDEFINED_FIXTURE")).toBe(true);
        });
        (0, vitest_1.it)("warns on missing assert statement", () => {
            const bad = `
def test_login_redirects_to_inventory(login_page):
    login_page.login("standard_user", "secret_sauce")
    login_page.open_inventory()
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                testFileContent: bad,
                framework: "pytest",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "PYTEST_MISSING_ASSERTION")).toBe(true);
        });
        (0, vitest_1.it)("warns on placeholder credentials", () => {
            const bad = VALID_PYTEST_TEST.replace("standard_user", "your_username");
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                testFileContent: bad,
                framework: "pytest",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "PYTEST_PLACEHOLDER_CREDENTIALS")).toBe(true);
        });
        (0, vitest_1.it)("warns when webdriver created directly in test function", () => {
            const bad = `
from selenium import webdriver

def test_login_redirects_to_inventory():
    driver = webdriver.Chrome()
    driver.get("/login")
    assert driver.current_url.endswith("/login")
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                testFileContent: bad,
                framework: "selenium_python",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "PYTEST_MISSING_FIXTURE_TEARDOWN")).toBe(true);
        });
    });
    (0, vitest_1.describe)("SQL validator", () => {
        (0, vitest_1.it)("blocks on DROP TABLE", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "unknown",
                sqlContent: "DROP TABLE users;",
                sqlDialect: "postgresql",
            });
            (0, vitest_1.expect)(result.decision).toBe("blocked");
            (0, vitest_1.expect)(result.issues.some(i => i.code === "SQL_DESTRUCTIVE_OPERATION")).toBe(true);
        });
        (0, vitest_1.it)("blocks on TRUNCATE TABLE", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "unknown",
                sqlContent: "TRUNCATE TABLE users;",
                sqlDialect: "mysql",
            });
            (0, vitest_1.expect)(result.decision).toBe("blocked");
            (0, vitest_1.expect)(result.issues.some(i => i.code === "SQL_DESTRUCTIVE_OPERATION")).toBe(true);
        });
        (0, vitest_1.it)("warns on placeholder table name", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "unknown",
                sqlContent: "CREATE TABLE IF NOT EXISTS your_table (id SERIAL PRIMARY KEY);",
                sqlDialect: "postgresql",
            });
            (0, vitest_1.expect)(result.decision).toBe("preview_only");
            (0, vitest_1.expect)(result.issues.some(i => i.code === "SQL_PLACEHOLDER")).toBe(true);
        });
        (0, vitest_1.it)("warns on missing IF NOT EXISTS", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "unknown",
                sqlContent: "CREATE TABLE users (id SERIAL PRIMARY KEY);",
                sqlDialect: "postgresql",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "SQL_MISSING_IF_NOT_EXISTS")).toBe(true);
        });
        (0, vitest_1.it)("warns on camelCase table name", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "unknown",
                sqlContent: "CREATE TABLE IF NOT EXISTS userProfiles (id SERIAL PRIMARY KEY);",
                sqlDialect: "postgresql",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "SQL_SNAKE_CASE_VIOLATION")).toBe(true);
        });
        (0, vitest_1.it)("warns on missing primary key", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "unknown",
                sqlContent: "CREATE TABLE IF NOT EXISTS users (email TEXT NOT NULL);",
                sqlDialect: "sqlite",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "SQL_MISSING_PRIMARY_KEY")).toBe(true);
        });
        (0, vitest_1.it)("passes a clean CREATE TABLE statement", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "unknown",
                sqlContent: `
CREATE TABLE IF NOT EXISTS user_profiles (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
`.trim(),
                sqlDialect: "postgresql",
            });
            (0, vitest_1.expect)(result.decision).toBe("pass");
            (0, vitest_1.expect)(result.issues).toHaveLength(0);
        });
    });
    (0, vitest_1.describe)("complexity validator", () => {
        (0, vitest_1.it)("warns when data_driven pytest test has no parametrize", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "pytest",
                testFileContent: VALID_PYTEST_TEST,
                complexityHint: "data_driven",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "COMPLEXITY_MISSING_PARAMETRIZE")).toBe(true);
        });
        (0, vitest_1.it)("warns when data_driven cucumber test has no Scenario Outline", () => {
            const simpleFeature = `
Feature: Login
  Scenario: Login with valid credentials
    Given I open the home page
    When I log in
    Then I should see the dashboard
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "cucumber_java",
                featureContent: simpleFeature,
                complexityHint: "data_driven",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "COMPLEXITY_MISSING_PARAMETRIZE")).toBe(true);
        });
        (0, vitest_1.it)("does not warn when data_driven pytest test has parametrize", () => {
            const parametrizedPytest = `
import pytest

@pytest.mark.parametrize("username,password", [
    ("standard_user", "secret_sauce"),
    ("problem_user", "secret_sauce"),
])
def test_login_redirects_to_inventory(login_page, username, password):
    login_page.login(username, password)
    assert "/inventory" in login_page.driver.current_url
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "pytest",
                testFileContent: parametrizedPytest,
                complexityHint: "data_driven",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "COMPLEXITY_MISSING_PARAMETRIZE")).toBe(false);
        });
        (0, vitest_1.it)("warns when negative test has no error or invalid in test names", () => {
            const neutralPytest = `
def test_login_redirects_to_inventory(login_page):
    login_page.login("standard_user", "secret_sauce")
    assert "/inventory" in login_page.driver.current_url
`.trim();
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "pytest",
                testFileContent: neutralPytest,
                complexityHint: "negative",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code === "COMPLEXITY_MISSING_NEGATIVE_CASE")).toBe(true);
        });
        (0, vitest_1.it)("does not warn for simple complexity", () => {
            const result = (0, testOutputValidator_js_1.validateTestOutput)({
                framework: "playwright_ts",
                testFileContent: VALID_PLAYWRIGHT_TEST,
                complexityHint: "simple",
            });
            (0, vitest_1.expect)(result.issues.some(i => i.code.startsWith("COMPLEXITY_"))).toBe(false);
        });
    });
});
//# sourceMappingURL=testOutputValidator.test.js.map