import { describe, expect, it } from "vitest";
import { detectDataSchema } from "./detectDataSchema.js";
import type { RepoFile } from "../types/project.js";

function file(p: string): RepoFile {
  return {
    path: p,
    absolutePath: `C:/repo/${p}`,
    extension: p.split(".").pop() ?? "",
    category: "unknown",
  };
}

describe("detectDataSchema", () => {
  it("returns unknown for empty array", () => {
    const result = detectDataSchema([]);
    expect(result.dialect).toBe("unknown");
    expect(result.migrationFormat).toBe("unknown");
    expect(result.confidence).toBe("low");
  });

  it("returns unknown for non-array input", () => {
    // @ts-expect-error testing invalid input
    const result = detectDataSchema(null);
    expect(result.dialect).toBe("unknown");
    expect(result.migrationFormat).toBe("unknown");
  });

  it("detects flyway from V1__init.sql filename pattern", () => {
    const result = detectDataSchema([file("db/migration/V1__init.sql")]);
    expect(result.migrationFormat).toBe("flyway");
    expect(result.migrationDir).toBe("db/migration");
  });

  it("detects mysql from my.cnf file", () => {
    const result = detectDataSchema([file("config/my.cnf")]);
    expect(result.dialect).toBe("mysql");
  });

  it("detects sqlite from db file", () => {
    const result = detectDataSchema([file("data/app.db")]);
    expect(result.dialect).toBe("sqlite");
  });

  it("detects raw_sql from plain sql files", () => {
    const result = detectDataSchema([file("sql/create_users.sql")]);
    expect(result.migrationFormat).toBe("raw_sql");
  });

  it("detects alembic from alembic.ini", () => {
    const result = detectDataSchema([file("alembic.ini")]);
    expect(result.migrationFormat).toBe("alembic");
  });

  it("returns empty existingTables when no readable sql content exists", () => {
    const result = detectDataSchema([file("db/migration/V1__init.sql")]);
    expect(result.existingTables).toEqual([]);
  });
});
