import { describe, expect, it } from "vitest";
import { validateTestOutput } from "./testOutputValidator.js";

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

describe("validateTestOutput", () => {
  describe("feature validator", () => {
    it("passes a valid feature file", () => {
      const result = validateTestOutput({
        featureContent: VALID_FEATURE,
        framework: "cucumber_java",
      });
      expect(result.decision).toBe("pass");
      expect(result.issues).toHaveLength(0);
    });

    it("blocks a feature with no Given/When/Then", () => {
      const bad = `
Feature: Bad Feature
  Scenario: Missing steps
    And something happens
`.trim();
      const result = validateTestOutput({
        featureContent: bad,
        framework: "cucumber_java",
      });
      expect(result.decision).toBe("blocked");
      expect(result.issues.some(i => i.code === "FEATURE_MISSING_GWT")).toBe(true);
    });

    it("blocks a feature with no scenario", () => {
      const bad = `
Feature: No Scenario
  Given something
  When something
  Then something
`.trim();
      const result = validateTestOutput({
        featureContent: bad,
        framework: "cucumber_java",
      });
      expect(result.decision).toBe("blocked");
      expect(result.issues.some(i => i.code === "FEATURE_MISSING_SCENARIO")).toBe(true);
    });

    it("blocks a feature with empty examples table", () => {
      const bad = `
Feature: Empty Examples
  Scenario Outline: Search
    Given I open the page
    When I search
    Then I see results
    Examples:
`.trim();
      const result = validateTestOutput({
        featureContent: bad,
        framework: "cucumber_java",
      });
      expect(result.decision).toBe("blocked");
      expect(result.issues.some(i => i.code === "FEATURE_EMPTY_EXAMPLES")).toBe(true);
    });

    it("warns on placeholder URL", () => {
      const bad = `
Feature: Placeholder
  Scenario: Visit page
    Given I open the home page "https://example.com/"
    When I click login
    Then I see dashboard
`.trim();
      const result = validateTestOutput({
        featureContent: bad,
        framework: "cucumber_java",
      });
      expect(result.decision).toBe("preview_only");
      expect(result.issues.some(i => i.code === "FEATURE_PLACEHOLDER_URL")).toBe(true);
    });

    it("warns on missing Feature header", () => {
      const bad = `
Scenario: No header
  Given I open
  When I click
  Then I see
`.trim();
      const result = validateTestOutput({
        featureContent: bad,
        framework: "cucumber_java",
      });
      expect(result.issues.some(i => i.code === "FEATURE_MISSING_HEADER")).toBe(true);
    });
  });

  describe("step definition validator", () => {
    it("passes a valid step definition with matching page object", () => {
      const result = validateTestOutput({
        stepDefinitionContent: VALID_STEP_DEF,
        pageObjectContents: [PAGE_OBJECT],
        framework: "cucumber_java",
      });
      expect(result.decision).toBe("pass");
      expect(result.issues.filter(i => i.code === "STEP_DEF_MISSING_PAGE_METHOD")).toHaveLength(0);
    });

    it("warns when step def calls method not in page object", () => {
      const bad = VALID_STEP_DEF.replace(
        "homePage.selectRoundTrip(from, to);",
        "homePage.searchRoundTripFlight(from, to);"
      );
      const result = validateTestOutput({
        stepDefinitionContent: bad,
        pageObjectContents: [PAGE_OBJECT],
        framework: "cucumber_java",
      });
      expect(result.issues.some(i => i.code === "STEP_DEF_MISSING_PAGE_METHOD")).toBe(true);
    });

    it("warns on TODO stub", () => {
      const bad = VALID_STEP_DEF.replace(
        "homePage.openHomePage();",
        "// TODO implement this"
      );
      const result = validateTestOutput({
        stepDefinitionContent: bad,
        pageObjectContents: [PAGE_OBJECT],
        framework: "cucumber_java",
      });
      expect(result.issues.some(i => i.code === "STEP_DEF_STUB")).toBe(true);
    });

    it("blocks when package declaration is missing", () => {
      const bad = VALID_STEP_DEF.replace("package com.enuygun.stepdefinitions;", "");
      const result = validateTestOutput({
        stepDefinitionContent: bad,
        pageObjectContents: [PAGE_OBJECT],
        framework: "cucumber_java",
      });
      expect(result.decision).toBe("blocked");
      expect(result.issues.some(i => i.code === "STEP_DEF_MISSING_PACKAGE")).toBe(true);
    });

    it("warns when no imports found", () => {
      const bad = VALID_STEP_DEF.replace(/import .*;/g, "");
      const result = validateTestOutput({
        stepDefinitionContent: bad,
        pageObjectContents: [PAGE_OBJECT],
        framework: "cucumber_java",
      });
      expect(result.issues.some(i => i.code === "STEP_DEF_MISSING_IMPORTS")).toBe(true);
    });
  });

  describe("combined validation", () => {
    it("passes when both feature and step def are valid", () => {
      const result = validateTestOutput({
        featureContent: VALID_FEATURE,
        stepDefinitionContent: VALID_STEP_DEF,
        pageObjectContents: [PAGE_OBJECT],
        framework: "cucumber_java",
      });
      expect(result.decision).toBe("pass");
      expect(result.issues).toHaveLength(0);
    });

    it("blocks when feature has errors even if step def is valid", () => {
      const badFeature = `
Feature: Bad
  Scenario: Missing steps
    And something
`.trim();
      const result = validateTestOutput({
        featureContent: badFeature,
        stepDefinitionContent: VALID_STEP_DEF,
        pageObjectContents: [PAGE_OBJECT],
        framework: "cucumber_java",
      });
      expect(result.decision).toBe("blocked");
    });

    it("returns preview_only when only warnings exist", () => {
      const featureWithWarning = VALID_FEATURE.replace(
        "I open the home page",
        'I open "https://example.com/"'
      );
      const result = validateTestOutput({
        featureContent: featureWithWarning,
        stepDefinitionContent: VALID_STEP_DEF,
        pageObjectContents: [PAGE_OBJECT],
        framework: "cucumber_java",
      });
      expect(result.decision).toBe("preview_only");
    });

    it("returns correct summary for blocked decision", () => {
      const result = validateTestOutput({
        featureContent: "no steps here",
        framework: "cucumber_java",
      });
      expect(result.summary).toContain("blocked");
    });

    it("returns correct summary for pass decision", () => {
      const result = validateTestOutput({
        featureContent: VALID_FEATURE,
        framework: "cucumber_java",
      });
      expect(result.summary).toContain("passed");
    });
  });

  describe("playwright validator", () => {
    it("warns on placeholder selector your-username", () => {
      const bad = VALID_PLAYWRIGHT_TEST.replace("#user-name", "your-username");
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "playwright_ts",
      });
      expect(result.decision).toBe("preview_only");
      expect(
        result.issues.some(i => i.code === "PLAYWRIGHT_PLACEHOLDER_SELECTOR")
      ).toBe(true);
    });

    it("warns on missing expect assertion", () => {
      const bad = VALID_PLAYWRIGHT_TEST.replace(
        '  await expect(page.locator(".inventory_list")).toBeVisible();\n',
        ""
      );
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "playwright_js",
      });
      expect(
        result.issues.some(i => i.code === "PLAYWRIGHT_MISSING_ASSERTION")
      ).toBe(true);
    });

    it("warns on hardcoded https url in goto", () => {
      const bad = VALID_PLAYWRIGHT_TEST.replace('await page.goto("/");', 'await page.goto("https://example.com/login");');
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "playwright_ts",
      });
      expect(
        result.issues.some(i => i.code === "PLAYWRIGHT_HARDCODED_URL")
      ).toBe(true);
    });

    it("passes a clean playwright test with relative url and real selectors", () => {
      const result = validateTestOutput({
        testFileContent: VALID_PLAYWRIGHT_TEST,
        framework: "playwright_ts",
      });
      expect(result.decision).toBe("pass");
      expect(result.issues).toHaveLength(0);
    });

    it("warns on missing await before click", () => {
      const bad = VALID_PLAYWRIGHT_TEST.replace(
        '  await page.locator("#login-button").click();',
        '  page.locator("#login-button").click();'
      );
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "playwright_ts",
      });
      expect(
        result.issues.some(i => i.code === "PLAYWRIGHT_MISSING_AWAIT")
      ).toBe(true);
    });
  });

  describe("pytest validator", () => {
    it("passes a clean pytest test with proper fixtures", () => {
      const result = validateTestOutput({
        testFileContent: VALID_PYTEST_TEST,
        framework: "pytest",
      });
      expect(result.decision).toBe("pass");
      expect(result.issues).toHaveLength(0);
    });

    it("warns on undefined fixture variable used in test body", () => {
      const bad = `
def test_login_redirects_to_inventory(login_page):
    login_page.login("standard_user", "secret_sauce")
    assert "/inventory" in driver.current_url
`.trim();
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "selenium_python",
      });
      expect(
        result.issues.some(i => i.code === "PYTEST_UNDEFINED_FIXTURE")
      ).toBe(true);
    });

    it("warns on missing assert statement", () => {
      const bad = `
def test_login_redirects_to_inventory(login_page):
    login_page.login("standard_user", "secret_sauce")
    login_page.open_inventory()
`.trim();
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "pytest",
      });
      expect(
        result.issues.some(i => i.code === "PYTEST_MISSING_ASSERTION")
      ).toBe(true);
    });

    it("warns on placeholder credentials", () => {
      const bad = VALID_PYTEST_TEST.replace("standard_user", "your_username");
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "pytest",
      });
      expect(
        result.issues.some(i => i.code === "PYTEST_PLACEHOLDER_CREDENTIALS")
      ).toBe(true);
    });

    it("warns when webdriver created directly in test function", () => {
      const bad = `
from selenium import webdriver

def test_login_redirects_to_inventory():
    driver = webdriver.Chrome()
    driver.get("/login")
    assert driver.current_url.endswith("/login")
`.trim();
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "selenium_python",
      });
      expect(
        result.issues.some(i => i.code === "PYTEST_MISSING_FIXTURE_TEARDOWN")
      ).toBe(true);
    });
  });

  describe("SQL validator", () => {
    it("blocks on DROP TABLE", () => {
      const result = validateTestOutput({
        framework: "unknown",
        sqlContent: "DROP TABLE users;",
        sqlDialect: "postgresql",
      });
      expect(result.decision).toBe("blocked");
      expect(result.issues.some(i => i.code === "SQL_DESTRUCTIVE_OPERATION")).toBe(true);
    });

    it("blocks on TRUNCATE TABLE", () => {
      const result = validateTestOutput({
        framework: "unknown",
        sqlContent: "TRUNCATE TABLE users;",
        sqlDialect: "mysql",
      });
      expect(result.decision).toBe("blocked");
      expect(result.issues.some(i => i.code === "SQL_DESTRUCTIVE_OPERATION")).toBe(true);
    });

    it("warns on placeholder table name", () => {
      const result = validateTestOutput({
        framework: "unknown",
        sqlContent: "CREATE TABLE IF NOT EXISTS your_table (id SERIAL PRIMARY KEY);",
        sqlDialect: "postgresql",
      });
      expect(result.decision).toBe("preview_only");
      expect(result.issues.some(i => i.code === "SQL_PLACEHOLDER")).toBe(true);
    });

    it("warns on missing IF NOT EXISTS", () => {
      const result = validateTestOutput({
        framework: "unknown",
        sqlContent: "CREATE TABLE users (id SERIAL PRIMARY KEY);",
        sqlDialect: "postgresql",
      });
      expect(result.issues.some(i => i.code === "SQL_MISSING_IF_NOT_EXISTS")).toBe(true);
    });

    it("warns on camelCase table name", () => {
      const result = validateTestOutput({
        framework: "unknown",
        sqlContent: "CREATE TABLE IF NOT EXISTS userProfiles (id SERIAL PRIMARY KEY);",
        sqlDialect: "postgresql",
      });
      expect(result.issues.some(i => i.code === "SQL_SNAKE_CASE_VIOLATION")).toBe(true);
    });

    it("warns on missing primary key", () => {
      const result = validateTestOutput({
        framework: "unknown",
        sqlContent: "CREATE TABLE IF NOT EXISTS users (email TEXT NOT NULL);",
        sqlDialect: "sqlite",
      });
      expect(result.issues.some(i => i.code === "SQL_MISSING_PRIMARY_KEY")).toBe(true);
    });

    it("passes a clean CREATE TABLE statement", () => {
      const result = validateTestOutput({
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
      expect(result.decision).toBe("pass");
      expect(result.issues).toHaveLength(0);
    });
  });

  describe("complexity validator", () => {
    it("warns when data_driven pytest test has no parametrize", () => {
      const result = validateTestOutput({
        framework: "pytest",
        testFileContent: VALID_PYTEST_TEST,
        complexityHint: "data_driven",
      });
      expect(
        result.issues.some(i => i.code === "COMPLEXITY_MISSING_PARAMETRIZE")
      ).toBe(true);
    });

    it("warns when data_driven cucumber test has no Scenario Outline", () => {
      const simpleFeature = `
Feature: Login
  Scenario: Login with valid credentials
    Given I open the home page
    When I log in
    Then I should see the dashboard
`.trim();
      const result = validateTestOutput({
        framework: "cucumber_java",
        featureContent: simpleFeature,
        complexityHint: "data_driven",
      });
      expect(
        result.issues.some(i => i.code === "COMPLEXITY_MISSING_PARAMETRIZE")
      ).toBe(true);
    });

    it("does not warn when data_driven pytest test has parametrize", () => {
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
      const result = validateTestOutput({
        framework: "pytest",
        testFileContent: parametrizedPytest,
        complexityHint: "data_driven",
      });
      expect(
        result.issues.some(i => i.code === "COMPLEXITY_MISSING_PARAMETRIZE")
      ).toBe(false);
    });

    it("warns when negative test has no error or invalid in test names", () => {
      const neutralPytest = `
def test_login_redirects_to_inventory(login_page):
    login_page.login("standard_user", "secret_sauce")
    assert "/inventory" in login_page.driver.current_url
`.trim();
      const result = validateTestOutput({
        framework: "pytest",
        testFileContent: neutralPytest,
        complexityHint: "negative",
      });
      expect(
        result.issues.some(i => i.code === "COMPLEXITY_MISSING_NEGATIVE_CASE")
      ).toBe(true);
    });

    it("does not warn for simple complexity", () => {
      const result = validateTestOutput({
        framework: "playwright_ts",
        testFileContent: VALID_PLAYWRIGHT_TEST,
        complexityHint: "simple",
      });
      expect(
        result.issues.some(i => i.code.startsWith("COMPLEXITY_"))
      ).toBe(false);
    });
  });

  describe("Cypress validator", () => {
    const VALID_CYPRESS_TEST = `
describe("Login", () => {
  it("logs in successfully", () => {
    cy.visit("/");
    cy.get("#user-name").type("standard_user");
    cy.get("#password").type("secret_sauce");
    cy.get("#login-button").click();
    cy.get(".inventory_list").should("be.visible");
  });
});
`.trim();

    it("passes a clean cypress test", () => {
      const result = validateTestOutput({
        testFileContent: VALID_CYPRESS_TEST,
        framework: "cypress",
      });
      expect(result.decision).toBe("pass");
    });

    it("warns on missing cy.should or cy.contains assertion", () => {
      const bad = `
describe("Login", () => {
  it("logs in successfully", () => {
    cy.visit("/");
    cy.get("#user-name").type("standard_user");
    cy.get("#login-button").click();
  });
});
`.trim();
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "cypress",
      });
      expect(
        result.issues.some((i) => i.code === "CYPRESS_MISSING_ASSERTION")
      ).toBe(true);
    });

    it("warns on placeholder selector", () => {
      const bad = VALID_CYPRESS_TEST.replace("#user-name", "your-selector");
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "cypress",
      });
      expect(
        result.issues.some((i) => i.code === "CYPRESS_PLACEHOLDER_SELECTOR")
      ).toBe(true);
    });

    it("warns on hardcoded full URL in cy.visit", () => {
      const bad = VALID_CYPRESS_TEST.replace(
        'cy.visit("/")',
        'cy.visit("https://example.com/login")'
      );
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "cypress",
      });
      expect(
        result.issues.some((i) => i.code === "CYPRESS_HARDCODED_URL")
      ).toBe(true);
    });
  });

  describe("Selenium Java validator", () => {
    const VALID_SELENIUM_JAVA_TEST = `
package com.example.tests;
import org.testng.annotations.Test;
import com.example.pages.LoginPage;
public class LoginTest {
  @Test
  public void testLoginSuccess() {
    LoginPage loginPage = new LoginPage(driver);
    loginPage.enterUsername("standard_user");
    loginPage.enterPassword("secret_sauce");
    loginPage.clickLogin();
    assertTrue(inventoryPage.isDisplayed());
  }
}
`.trim();

    it("passes a clean selenium java test", () => {
      const result = validateTestOutput({
        testFileContent: VALID_SELENIUM_JAVA_TEST,
        framework: "selenium_java",
      });
      expect(result.decision).toBe("pass");
    });

    it("warns on direct driver instantiation", () => {
      const bad = VALID_SELENIUM_JAVA_TEST.replace(
        "LoginPage loginPage = new LoginPage(driver);",
        "WebDriver driver = new ChromeDriver();\nLoginPage loginPage = new LoginPage(driver);"
      );
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "selenium_java",
      });
      expect(
        result.issues.some((i) => i.code === "SELENIUM_JAVA_DIRECT_DRIVER")
      ).toBe(true);
    });

    it("warns on missing assertion", () => {
      const bad = `
package com.example.tests;
public class LoginTest {
  public void testLoginSuccess() {
    LoginPage loginPage = new LoginPage(driver);
    loginPage.clickLogin();
  }
}
`.trim();
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "selenium_java",
      });
      expect(
        result.issues.some((i) => i.code === "SELENIUM_JAVA_MISSING_ASSERTION")
      ).toBe(true);
    });

    it("warns on missing package declaration", () => {
      const bad = VALID_SELENIUM_JAVA_TEST.replace(
        "package com.example.tests;",
        ""
      );
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "selenium_java",
      });
      expect(
        result.issues.some((i) => i.code === "SELENIUM_JAVA_MISSING_PACKAGE")
      ).toBe(true);
    });
  });

  describe("TestNG validator", () => {
    const VALID_TESTNG_TEST = `
package com.example.tests;
import org.testng.Assert;
import org.testng.annotations.Test;
import com.example.pages.LoginPage;
public class LoginTest {
  @Test
  public void testLoginSuccess() {
    LoginPage loginPage = new LoginPage(driver);
    loginPage.login("standard_user", "secret_sauce");
    Assert.assertTrue(inventoryPage.isDisplayed());
  }
}
`.trim();

    it("passes a clean testng test", () => {
      const result = validateTestOutput({
        testFileContent: VALID_TESTNG_TEST,
        framework: "testng",
      });
      expect(result.decision).toBe("pass");
    });

    it("warns on missing @Test annotation", () => {
      const bad = VALID_TESTNG_TEST.replace("@Test\n  ", "");
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "testng",
      });
      expect(
        result.issues.some((i) => i.code === "TESTNG_MISSING_ANNOTATION")
      ).toBe(true);
    });

    it("warns on missing Assert call", () => {
      const bad = VALID_TESTNG_TEST.replace(
        "Assert.assertTrue(inventoryPage.isDisplayed());",
        "// no assertion"
      );
      const result = validateTestOutput({
        testFileContent: bad,
        framework: "testng",
      });
      expect(
        result.issues.some((i) => i.code === "TESTNG_MISSING_ASSERTION")
      ).toBe(true);
    });
  });
});
