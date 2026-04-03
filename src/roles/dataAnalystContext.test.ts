import { describe, expect, it } from "vitest";
import { buildDataAnalystContext } from "./dataAnalystContext.js";
import type { RepoFile } from "../types/project.js";
import type { DetectedDataSchema } from "./detectDataSchema.js";

function buildSchema(
  overrides: Partial<DetectedDataSchema> = {}
): DetectedDataSchema {
  return {
    dialect: "postgresql",
    migrationFormat: "flyway",
    confidence: "high",
    evidence: ["test"],
    migrationDir: "db/migration",
    existingTables: [],
    ...overrides,
  };
}

function file(p: string): RepoFile {
  return {
    path: p,
    absolutePath: `C:/repo/${p}`,
    extension: p.split(".").pop() ?? "",
    category: "unknown",
  };
}

describe("buildDataAnalystContext", () => {
  it("builds correct flyway migration path with next version number", () => {
    const context = buildDataAnalystContext(
      "Create table for user sessions",
      buildSchema(),
      [file("db/migration/V1__init.sql"), file("db/migration/V2__users.sql")]
    );

    expect(context.outputPaths.migrationFile).toBe(
      "db/migration/V3__user_sessions.sql"
    );
  });

  it("builds correct raw_sql path", () => {
    const context = buildDataAnalystContext(
      "Create table for audit logs",
      buildSchema({
        migrationFormat: "raw_sql",
        migrationDir: "sql",
      }),
      []
    );

    expect(context.outputPaths.migrationFile).toBe("sql/audit_logs.sql");
  });

  it("generates correct slug from task", () => {
    const context = buildDataAnalystContext(
      "Create a new table for customer order history",
      buildSchema(),
      []
    );

    expect(context.outputPaths.migrationFile).toContain("customer_order_history");
  });

  it("includes Never use DROP TABLE in output rules", () => {
    const context = buildDataAnalystContext("Create table for users", buildSchema(), []);
    expect(context.outputRules).toContain(
      "Never use DROP TABLE or TRUNCATE — these are destructive"
    );
  });

  it("includes existing tables in output rules when tables exist", () => {
    const context = buildDataAnalystContext(
      "Create table for invoices",
      buildSchema({
        existingTables: ["users", "orders"],
      }),
      []
    );

    expect(
      context.outputRules.some((rule) => rule.includes("users, orders"))
    ).toBe(true);
  });
});
