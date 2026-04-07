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

  describe("path-based dialect detection (hosted mode)", () => {
    it("detects postgresql from path containing 'postgres'", () => {
      const files = [
        file("config/postgres.config.js"),
        file("db/migrations/V1__init.sql"),
      ];
      const result = detectDataSchema(files);
      expect(result.dialect).toBe("postgresql");
    });

    it("detects postgresql from supabase path", () => {
      const files = [file("supabase/migrations/20240101_init.sql")];
      const result = detectDataSchema(files);
      expect(result.dialect).toBe("postgresql");
    });

    it("detects mysql from path containing 'mysql'", () => {
      const files = [file("config/mysql.config.js"), file("db/schema.sql")];
      const result = detectDataSchema(files);
      expect(result.dialect).toBe("mysql");
    });

    it("detects sqlite from .sqlite file extension", () => {
      const files = [file("data/app.sqlite"), file("db/schema.sql")];
      const result = detectDataSchema(files);
      expect(result.dialect).toBe("sqlite");
    });

    it("detects sqlite from .db file extension", () => {
      const files = [file("data/local.db")];
      const result = detectDataSchema(files);
      expect(result.dialect).toBe("sqlite");
    });
  });

  describe("prisma migration format", () => {
    it("detects prisma from prisma/migrations path", () => {
      const files = [
        file("prisma/migrations/20240101_init/migration.sql"),
        file("prisma/schema.prisma"),
      ];
      const result = detectDataSchema(files);
      expect(result.migrationFormat).toBe("prisma");
    });

    it("detects prisma migration dir correctly", () => {
      const files = [file("prisma/migrations/20240101_init/migration.sql")];
      const result = detectDataSchema(files);
      expect(result.migrationDir).toContain("prisma");
    });
  });

  describe("confidence levels", () => {
    it("returns high confidence when both dialect and format are detected", () => {
      const files = [
        file("supabase/migrations/V1__init.sql"),
        file("db/migration/V1__init.sql"),
      ];
      const result = detectDataSchema(files);
      expect(result.confidence).toBe("high");
    });

    it("returns medium confidence when only format is detected", () => {
      const files = [file("db/migration/V1__init.sql")];
      const result = detectDataSchema(files);
      expect(result.confidence).toBe("medium");
    });

    it("returns low confidence when nothing is detected", () => {
      const files = [file("src/index.ts"), file("package.json")];
      const result = detectDataSchema(files);
      expect(result.confidence).toBe("low");
    });
  });
});
