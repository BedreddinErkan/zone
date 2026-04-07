"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const validateLlmOutput_js_1 = require("./validateLlmOutput.js");
// ---------------------------------------------------------------------------
// Test Engineer
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("validateLlmOutput — test_engineer", () => {
    (0, vitest_1.it)("blocks when expect() is missing", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("test_engineer", [{
                filePath: "login.spec.ts",
                content: `it("should login", async () => { await page.goto("/login"); });`,
            }]);
        (0, vitest_1.expect)(result.verdict).toBe("block");
        (0, vitest_1.expect)(result.issues.some(i => i.code === "MISSING_EXPECT")).toBe(true);
    });
    (0, vitest_1.it)("blocks when async test has no await", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("test_engineer", [{
                filePath: "form.spec.ts",
                content: `it("test", async () => { expect(true).toBe(true); });`,
            }]);
        (0, vitest_1.expect)(result.verdict).toBe("block");
        (0, vitest_1.expect)(result.issues.some(i => i.code === "MISSING_AWAIT")).toBe(true);
    });
    (0, vitest_1.it)("blocks on placeholder selector", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("test_engineer", [{
                filePath: "nav.spec.ts",
                content: `it("t", async () => {
        await expect(page.getByText("TODO")).toBeVisible();
      });`,
            }]);
        (0, vitest_1.expect)(result.issues.some(i => i.code === "PLACEHOLDER_SELECTOR")).toBe(true);
    });
    (0, vitest_1.it)("warns on hardcoded URL", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("test_engineer", [{
                filePath: "auth.spec.ts",
                content: `it("t", async () => {
        await page.goto("http://localhost:3000/login");
        await expect(page.getByRole("button")).toBeVisible();
        await page.click("button");
      });`,
            }]);
        (0, vitest_1.expect)(result.issues.some(i => i.code === "HARDCODED_URL")).toBe(true);
        (0, vitest_1.expect)(result.issues.find(i => i.code === "HARDCODED_URL")?.severity).toBe("warning");
    });
    (0, vitest_1.it)("passes clean test file", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("test_engineer", [{
                filePath: "user.spec.ts",
                content: `
        import { test, expect } from "@playwright/test";
        test("can login", async ({ page }) => {
          await page.goto("/login");
          await page.fill('[data-testid="email"]', "user@example.com");
          await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
        });
      `,
            }]);
        (0, vitest_1.expect)(result.verdict).toBe("ok");
        (0, vitest_1.expect)(result.valid).toBe(true);
    });
    (0, vitest_1.it)("skips non-test files", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("test_engineer", [{
                filePath: "utils.ts",
                content: `export function add(a: number, b: number) { return a + b; }`,
            }]);
        (0, vitest_1.expect)(result.verdict).toBe("ok");
    });
});
// ---------------------------------------------------------------------------
// Developer
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("validateLlmOutput — developer", () => {
    (0, vitest_1.it)("warns on TODO marker", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", [{
                filePath: "service.ts",
                content: `export function getUser() { // TODO: implement this\n return null; }`,
            }]);
        (0, vitest_1.expect)(result.issues.some(i => i.code === "GENERIC_TEMPLATE")).toBe(true);
    });
    (0, vitest_1.it)("blocks shell TSX file (no imports, < 15 lines)", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", [{
                filePath: "Button.tsx",
                content: `export default function Button() {\n  return <button>Click</button>;\n}`,
            }]);
        (0, vitest_1.expect)(result.issues.some(i => i.code === "FULL_UI_OVERWRITE")).toBe(true);
    });
    (0, vitest_1.it)("blocks React hooks without import", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", [{
                filePath: "Counter.tsx",
                content: `
        export default function Counter() {
          const [count, setCount] = useState(0);
          return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
        }
      `,
            }]);
        (0, vitest_1.expect)(result.issues.some(i => i.code === "MISSING_REACT_IMPORT")).toBe(true);
    });
    (0, vitest_1.it)("warns when no export found", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", [{
                filePath: "helper.ts",
                content: `function doSomething() { return 42; }`,
            }]);
        (0, vitest_1.expect)(result.issues.some(i => i.code === "NO_EXPORT")).toBe(true);
    });
    (0, vitest_1.it)("passes clean TS module", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", [{
                filePath: "userService.ts",
                content: `
        import { db } from "./db.js";
        export async function getUser(id: string) {
          return db.users.findUnique({ where: { id } });
        }
      `,
            }]);
        (0, vitest_1.expect)(result.verdict).toBe("ok");
    });
});
// ---------------------------------------------------------------------------
// Data Analyst
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("validateLlmOutput — data_analyst", () => {
    (0, vitest_1.it)("blocks TRUNCATE", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("data_analyst", [{
                filePath: "cleanup.sql",
                content: `TRUNCATE TABLE users;`,
            }]);
        (0, vitest_1.expect)(result.verdict).toBe("block");
        (0, vitest_1.expect)(result.issues.some(i => i.code === "TRUNCATE_DETECTED")).toBe(true);
    });
    (0, vitest_1.it)("blocks unbounded DELETE", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("data_analyst", [{
                filePath: "reset.sql",
                content: `DELETE FROM sessions;`,
            }]);
        (0, vitest_1.expect)(result.issues.some(i => i.code === "UNBOUNDED_DELETE")).toBe(true);
    });
    (0, vitest_1.it)("blocks unbounded UPDATE", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("data_analyst", [{
                filePath: "fix.sql",
                content: `UPDATE users SET active = false;`,
            }]);
        (0, vitest_1.expect)(result.issues.some(i => i.code === "UNBOUNDED_UPDATE")).toBe(true);
    });
    (0, vitest_1.it)("blocks DROP TABLE without IF EXISTS", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("data_analyst", [{
                filePath: "drop.sql",
                content: `DROP TABLE old_logs;`,
            }]);
        (0, vitest_1.expect)(result.issues.some(i => i.code === "UNSAFE_DROP")).toBe(true);
    });
    (0, vitest_1.it)("passes DROP TABLE IF EXISTS", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("data_analyst", [{
                filePath: "drop.sql",
                content: `DROP TABLE IF EXISTS old_logs;`,
            }]);
        (0, vitest_1.expect)(result.issues.filter(i => i.code === "UNSAFE_DROP")).toHaveLength(0);
    });
    (0, vitest_1.it)("warns on migration without rollback", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("data_analyst", [{
                filePath: "20240101_migration.sql",
                content: `ALTER TABLE users ADD COLUMN bio TEXT;`,
            }]);
        (0, vitest_1.expect)(result.issues.some(i => i.code === "MISSING_ROLLBACK")).toBe(true);
        (0, vitest_1.expect)(result.verdict).toBe("warn");
    });
    (0, vitest_1.it)("passes safe bounded DELETE", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("data_analyst", [{
                filePath: "cleanup.sql",
                content: `DELETE FROM sessions WHERE created_at < NOW() - INTERVAL '30 days';`,
            }]);
        (0, vitest_1.expect)(result.issues.filter(i => i.code === "UNBOUNDED_DELETE")).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// Verdict logic
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("validateLlmOutput — verdict", () => {
    (0, vitest_1.it)("verdict is 'ok' when no issues", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", [{
                filePath: "math.ts",
                content: `export function add(a: number, b: number): number { return a + b; }`,
            }]);
        (0, vitest_1.expect)(result.verdict).toBe("ok");
        (0, vitest_1.expect)(result.valid).toBe(true);
    });
    (0, vitest_1.it)("verdict is 'block' when any error exists", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("data_analyst", [{
                filePath: "bad.sql",
                content: `TRUNCATE TABLE users;`,
            }]);
        (0, vitest_1.expect)(result.verdict).toBe("block");
        (0, vitest_1.expect)(result.valid).toBe(false);
    });
    (0, vitest_1.it)("verdict is 'warn' when only warnings exist", () => {
        const result = (0, validateLlmOutput_js_1.validateLlmOutput)("data_analyst", [{
                filePath: "20240101_migration.sql",
                content: `ALTER TABLE users ADD COLUMN bio TEXT;`,
            }]);
        (0, vitest_1.expect)(result.verdict).toBe("warn");
        (0, vitest_1.expect)(result.valid).toBe(true);
    });
});
//# sourceMappingURL=validateLlmOutput.test.js.map