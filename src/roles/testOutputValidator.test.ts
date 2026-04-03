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
});
