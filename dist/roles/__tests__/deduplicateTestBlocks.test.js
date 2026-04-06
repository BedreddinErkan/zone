"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runTestEngineerFlow_js_1 = require("../runTestEngineerFlow.js");
(0, vitest_1.describe)("deduplicateTestBlocks", () => {
    (0, vitest_1.it)("returns a single copy when identical content is doubled", () => {
        const singleCopy = [
            "import { test, expect } from '@playwright/test';",
            "",
            "test('shows login form', async ({ page }) => {",
            "  await page.goto('/login');",
            "  await expect(page.getByRole('heading')).toBeVisible();",
            "});",
        ].join("\n");
        const doubled = `${singleCopy}\n${singleCopy}`;
        (0, vitest_1.expect)((0, runTestEngineerFlow_js_1.deduplicateTestBlocks)(doubled)).toBe(singleCopy);
    });
    (0, vitest_1.it)("keeps only one duplicated Playwright import", () => {
        const content = [
            "import { test, expect } from '@playwright/test';",
            "import { test, expect } from '@playwright/test';",
            "",
            "test('shows login form', async ({ page }) => {",
            "  await page.goto('/login');",
            "});",
        ].join("\n");
        const result = (0, runTestEngineerFlow_js_1.deduplicateTestBlocks)(content);
        (0, vitest_1.expect)(result.match(/import \{ test, expect \} from '@playwright\/test';/g)).toHaveLength(1);
    });
    (0, vitest_1.it)("does not change content when a new test is added correctly", () => {
        const content = [
            "import { test, expect } from '@playwright/test';",
            "",
            "test('shows login form', async ({ page }) => {",
            "  await page.goto('/login');",
            "});",
            "",
            "test('shows invalid credentials error', async ({ page }) => {",
            "  await page.goto('/login');",
            "  await expect(page.getByText('Invalid credentials')).toBeVisible();",
            "});",
        ].join("\n");
        (0, vitest_1.expect)((0, runTestEngineerFlow_js_1.deduplicateTestBlocks)(content)).toBe(content);
    });
});
(0, vitest_1.describe)("finalizeGeneratedTestContent", () => {
    (0, vitest_1.it)("returns the original and warns when generated content is more than twice the original size", () => {
        const original = [
            "import { test, expect } from '@playwright/test';",
            "",
            "test('shows login form', async ({ page }) => {",
            "  await page.goto('/login');",
            "});",
        ].join("\n");
        const generated = `${original}\n${original}\n${original}`;
        const result = (0, runTestEngineerFlow_js_1.finalizeGeneratedTestContent)({
            fullContent: generated,
            originalContent: original,
        });
        (0, vitest_1.expect)(result.fullContent).toBe(original);
        (0, vitest_1.expect)(result.warnings).toContain("[TEST_DUPLICATE_CONTENT] Generated content appears to be duplicated. Returning original.");
    });
});
//# sourceMappingURL=deduplicateTestBlocks.test.js.map