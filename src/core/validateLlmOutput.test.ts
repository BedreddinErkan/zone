import { describe, expect, it } from "vitest";
import { validateLlmOutput } from "./validateLlmOutput.js";

// ---------------------------------------------------------------------------
// Test Engineer
// ---------------------------------------------------------------------------

describe("validateLlmOutput — test_engineer", () => {
  it("blocks when expect() is missing", () => {
    const result = validateLlmOutput("test_engineer", [{
      filePath: "login.spec.ts",
      content: `it("should login", async () => { await page.goto("/login"); });`,
    }]);
    expect(result.verdict).toBe("block");
    expect(result.issues.some(i => i.code === "MISSING_EXPECT")).toBe(true);
  });

  it("blocks when async test has no await", () => {
    const result = validateLlmOutput("test_engineer", [{
      filePath: "form.spec.ts",
      content: `it("test", async () => { expect(true).toBe(true); });`,
    }]);
    expect(result.verdict).toBe("block");
    expect(result.issues.some(i => i.code === "MISSING_AWAIT")).toBe(true);
  });

  it("blocks on placeholder selector", () => {
    const result = validateLlmOutput("test_engineer", [{
      filePath: "nav.spec.ts",
      content: `it("t", async () => {
        await expect(page.getByText("TODO")).toBeVisible();
      });`,
    }]);
    expect(result.issues.some(i => i.code === "PLACEHOLDER_SELECTOR")).toBe(true);
  });

  it("warns on hardcoded URL", () => {
    const result = validateLlmOutput("test_engineer", [{
      filePath: "auth.spec.ts",
      content: `it("t", async () => {
        await page.goto("http://localhost:3000/login");
        await expect(page.getByRole("button")).toBeVisible();
        await page.click("button");
      });`,
    }]);
    expect(result.issues.some(i => i.code === "HARDCODED_URL")).toBe(true);
    expect(result.issues.find(i => i.code === "HARDCODED_URL")?.severity).toBe("warning");
  });

  it("passes clean test file", () => {
    const result = validateLlmOutput("test_engineer", [{
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
    expect(result.verdict).toBe("ok");
    expect(result.valid).toBe(true);
  });

  it("skips non-test files", () => {
    const result = validateLlmOutput("test_engineer", [{
      filePath: "utils.ts",
      content: `export function add(a: number, b: number) { return a + b; }`,
    }]);
    expect(result.verdict).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Developer
// ---------------------------------------------------------------------------

describe("validateLlmOutput — developer", () => {
  it("warns on TODO marker", () => {
    const result = validateLlmOutput("developer", [{
      filePath: "service.ts",
      content: `export function getUser() { // TODO: implement this\n return null; }`,
    }]);
    expect(result.issues.some(i => i.code === "GENERIC_TEMPLATE")).toBe(true);
  });

  it("blocks shell TSX file (no imports, < 15 lines)", () => {
    const result = validateLlmOutput("developer", [{
      filePath: "Button.tsx",
      content: `export default function Button() {\n  return <button>Click</button>;\n}`,
    }]);
    expect(result.issues.some(i => i.code === "FULL_UI_OVERWRITE")).toBe(true);
  });

  it("blocks React hooks without import", () => {
    const result = validateLlmOutput("developer", [{
      filePath: "Counter.tsx",
      content: `
        export default function Counter() {
          const [count, setCount] = useState(0);
          return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
        }
      `,
    }]);
    expect(result.issues.some(i => i.code === "MISSING_REACT_IMPORT")).toBe(true);
  });

  it("warns when no export found", () => {
    const result = validateLlmOutput("developer", [{
      filePath: "helper.ts",
      content: `function doSomething() { return 42; }`,
    }]);
    expect(result.issues.some(i => i.code === "NO_EXPORT")).toBe(true);
  });

  it("passes clean TS module", () => {
    const result = validateLlmOutput("developer", [{
      filePath: "userService.ts",
      content: `
        import { db } from "./db.js";
        export async function getUser(id: string) {
          return db.users.findUnique({ where: { id } });
        }
      `,
    }]);
    expect(result.verdict).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Data Analyst
// ---------------------------------------------------------------------------

describe("validateLlmOutput — data_analyst", () => {
  it("blocks TRUNCATE", () => {
    const result = validateLlmOutput("data_analyst", [{
      filePath: "cleanup.sql",
      content: `TRUNCATE TABLE users;`,
    }]);
    expect(result.verdict).toBe("block");
    expect(result.issues.some(i => i.code === "TRUNCATE_DETECTED")).toBe(true);
  });

  it("blocks unbounded DELETE", () => {
    const result = validateLlmOutput("data_analyst", [{
      filePath: "reset.sql",
      content: `DELETE FROM sessions;`,
    }]);
    expect(result.issues.some(i => i.code === "UNBOUNDED_DELETE")).toBe(true);
  });

  it("blocks unbounded UPDATE", () => {
    const result = validateLlmOutput("data_analyst", [{
      filePath: "fix.sql",
      content: `UPDATE users SET active = false;`,
    }]);
    expect(result.issues.some(i => i.code === "UNBOUNDED_UPDATE")).toBe(true);
  });

  it("blocks DROP TABLE without IF EXISTS", () => {
    const result = validateLlmOutput("data_analyst", [{
      filePath: "drop.sql",
      content: `DROP TABLE old_logs;`,
    }]);
    expect(result.issues.some(i => i.code === "UNSAFE_DROP")).toBe(true);
  });

  it("passes DROP TABLE IF EXISTS", () => {
    const result = validateLlmOutput("data_analyst", [{
      filePath: "drop.sql",
      content: `DROP TABLE IF EXISTS old_logs;`,
    }]);
    expect(result.issues.filter(i => i.code === "UNSAFE_DROP")).toHaveLength(0);
  });

  it("warns on migration without rollback", () => {
    const result = validateLlmOutput("data_analyst", [{
      filePath: "20240101_migration.sql",
      content: `ALTER TABLE users ADD COLUMN bio TEXT;`,
    }]);
    expect(result.issues.some(i => i.code === "MISSING_ROLLBACK")).toBe(true);
    expect(result.verdict).toBe("warn");
  });

  it("passes safe bounded DELETE", () => {
    const result = validateLlmOutput("data_analyst", [{
      filePath: "cleanup.sql",
      content: `DELETE FROM sessions WHERE created_at < NOW() - INTERVAL '30 days';`,
    }]);
    expect(result.issues.filter(i => i.code === "UNBOUNDED_DELETE")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Verdict logic
// ---------------------------------------------------------------------------

describe("validateLlmOutput — verdict", () => {
  it("verdict is 'ok' when no issues", () => {
    const result = validateLlmOutput("developer", [{
      filePath: "math.ts",
      content: `export function add(a: number, b: number): number { return a + b; }`,
    }]);
    expect(result.verdict).toBe("ok");
    expect(result.valid).toBe(true);
  });

  it("verdict is 'block' when any error exists", () => {
    const result = validateLlmOutput("data_analyst", [{
      filePath: "bad.sql",
      content: `TRUNCATE TABLE users;`,
    }]);
    expect(result.verdict).toBe("block");
    expect(result.valid).toBe(false);
  });

  it("verdict is 'warn' when only warnings exist", () => {
    const result = validateLlmOutput("data_analyst", [{
      filePath: "20240101_migration.sql",
      content: `ALTER TABLE users ADD COLUMN bio TEXT;`,
    }]);
    expect(result.verdict).toBe("warn");
    expect(result.valid).toBe(true);
  });
});