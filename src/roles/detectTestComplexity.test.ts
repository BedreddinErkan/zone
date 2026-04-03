import { describe, expect, it } from "vitest";
import { detectTestComplexity } from "./detectTestComplexity.js";

describe("detectTestComplexity", () => {
  it("returns simple for basic login task", () => {
    const result = detectTestComplexity("Write a login test");
    expect(result.complexity).toBe("simple");
  });

  it("detects data_driven from multiple users", () => {
    const result = detectTestComplexity("Write a login test for multiple users");
    expect(result.complexity).toBe("data_driven");
  });

  it("detects data_driven from parametrize", () => {
    const result = detectTestComplexity("Parametrize login test cases");
    expect(result.complexity).toBe("data_driven");
  });

  it("detects e2e from end to end", () => {
    const result = detectTestComplexity("Write an end to end checkout flow test");
    expect(result.complexity).toBe("e2e");
  });

  it("detects e2e from complete flow", () => {
    const result = detectTestComplexity("Verify the complete flow from login to purchase");
    expect(result.complexity).toBe("e2e");
  });

  it("detects negative from invalid credentials", () => {
    const result = detectTestComplexity("Test invalid credentials");
    expect(result.complexity).toBe("negative");
  });

  it("detects negative from locked out user", () => {
    const result = detectTestComplexity("Verify locked out user cannot log in");
    expect(result.complexity).toBe("negative");
  });

  it("detects multi_scenario from all scenarios", () => {
    const result = detectTestComplexity("Write all scenarios for checkout");
    expect(result.complexity).toBe("multi_scenario");
  });

  it("prioritizes multi_scenario over e2e", () => {
    const result = detectTestComplexity("Write all scenarios for an end to end booking flow");
    expect(result.complexity).toBe("multi_scenario");
  });

  it("prioritizes e2e over data_driven", () => {
    const result = detectTestComplexity("Create an end to end flow for multiple users");
    expect(result.complexity).toBe("e2e");
  });

  it("is case insensitive", () => {
    const result = detectTestComplexity("INVALID Credentials for MULTIPLE USERS");
    expect(result.complexity).toBe("data_driven");
  });

  it("returns empty arrays for non-string input", () => {
    // @ts-expect-error testing invalid input
    const result = detectTestComplexity(null);
    expect(result.complexity).toBe("simple");
    expect(result.hints).toEqual([]);
    expect(result.suggestedPatterns).toEqual([]);
  });
});
