"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const detectTestComplexity_js_1 = require("./detectTestComplexity.js");
(0, vitest_1.describe)("detectTestComplexity", () => {
    (0, vitest_1.it)("returns simple for basic login task", () => {
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)("Write a login test");
        (0, vitest_1.expect)(result.complexity).toBe("simple");
    });
    (0, vitest_1.it)("detects data_driven from multiple users", () => {
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)("Write a login test for multiple users");
        (0, vitest_1.expect)(result.complexity).toBe("data_driven");
    });
    (0, vitest_1.it)("detects data_driven from parametrize", () => {
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)("Parametrize login test cases");
        (0, vitest_1.expect)(result.complexity).toBe("data_driven");
    });
    (0, vitest_1.it)("detects e2e from end to end", () => {
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)("Write an end to end checkout flow test");
        (0, vitest_1.expect)(result.complexity).toBe("e2e");
    });
    (0, vitest_1.it)("detects e2e from complete flow", () => {
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)("Verify the complete flow from login to purchase");
        (0, vitest_1.expect)(result.complexity).toBe("e2e");
    });
    (0, vitest_1.it)("detects negative from invalid credentials", () => {
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)("Test invalid credentials");
        (0, vitest_1.expect)(result.complexity).toBe("negative");
    });
    (0, vitest_1.it)("detects negative from locked out user", () => {
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)("Verify locked out user cannot log in");
        (0, vitest_1.expect)(result.complexity).toBe("negative");
    });
    (0, vitest_1.it)("detects multi_scenario from all scenarios", () => {
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)("Write all scenarios for checkout");
        (0, vitest_1.expect)(result.complexity).toBe("multi_scenario");
    });
    (0, vitest_1.it)("prioritizes multi_scenario over e2e", () => {
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)("Write all scenarios for an end to end booking flow");
        (0, vitest_1.expect)(result.complexity).toBe("multi_scenario");
    });
    (0, vitest_1.it)("prioritizes e2e over data_driven", () => {
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)("Create an end to end flow for multiple users");
        (0, vitest_1.expect)(result.complexity).toBe("e2e");
    });
    (0, vitest_1.it)("is case insensitive", () => {
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)("INVALID Credentials for MULTIPLE USERS");
        (0, vitest_1.expect)(result.complexity).toBe("data_driven");
    });
    (0, vitest_1.it)("returns empty arrays for non-string input", () => {
        // @ts-expect-error testing invalid input
        const result = (0, detectTestComplexity_js_1.detectTestComplexity)(null);
        (0, vitest_1.expect)(result.complexity).toBe("simple");
        (0, vitest_1.expect)(result.hints).toEqual([]);
        (0, vitest_1.expect)(result.suggestedPatterns).toEqual([]);
    });
});
//# sourceMappingURL=detectTestComplexity.test.js.map