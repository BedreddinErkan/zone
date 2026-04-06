import { describe, expect, it } from "vitest";

import {
  deduplicateTestBlocks,
  finalizeGeneratedTestContent,
} from "../runTestEngineerFlow.js";

describe("deduplicateTestBlocks", () => {
  it("returns a single copy when identical content is doubled", () => {
    const singleCopy = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('shows login form', async ({ page }) => {",
      "  await page.goto('/login');",
      "  await expect(page.getByRole('heading')).toBeVisible();",
      "});",
    ].join("\n");

    const doubled = `${singleCopy}\n${singleCopy}`;

    expect(deduplicateTestBlocks(doubled)).toBe(singleCopy);
  });

  it("keeps only one duplicated Playwright import", () => {
    const content = [
      "import { test, expect } from '@playwright/test';",
      "import { test, expect } from '@playwright/test';",
      "",
      "test('shows login form', async ({ page }) => {",
      "  await page.goto('/login');",
      "});",
    ].join("\n");

    const result = deduplicateTestBlocks(content);

    expect(
      result.match(/import \{ test, expect \} from '@playwright\/test';/g)
    ).toHaveLength(1);
  });

  it("does not change content when a new test is added correctly", () => {
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

    expect(deduplicateTestBlocks(content)).toBe(content);
  });
});

describe("finalizeGeneratedTestContent", () => {
  it("returns the original and warns when generated content is more than twice the original size", () => {
    const original = [
      "import { test, expect } from '@playwright/test';",
      "",
      "test('shows login form', async ({ page }) => {",
      "  await page.goto('/login');",
      "});",
    ].join("\n");
    const generated = `${original}\n${original}\n${original}`;

    const result = finalizeGeneratedTestContent({
      fullContent: generated,
      originalContent: original,
    });

    expect(result.fullContent).toBe(original);
    expect(result.warnings).toContain(
      "[TEST_DUPLICATE_CONTENT] Generated content appears to be duplicated. Returning original."
    );
  });
});
