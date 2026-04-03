import { readFileSync } from "node:fs";
import path from "node:path";
import type { RepoFile } from "../types/project.js";

export type SqlDialect = "postgresql" | "mysql" | "sqlite" | "unknown";
export type MigrationFormat =
  | "flyway"
  | "liquibase"
  | "alembic"
  | "raw_sql"
  | "unknown";

export interface DetectedDataSchema {
  dialect: SqlDialect;
  migrationFormat: MigrationFormat;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  migrationDir: string | null;
  existingTables: string[];
}

function readRepoFileContent(file: RepoFile): string {
  try {
    return readFileSync(file.absolutePath, "utf8");
  } catch {
    return "";
  }
}

function findMigrationDir(files: RepoFile[], format: MigrationFormat): string | null {
  if (!Array.isArray(files)) return null;

  if (format === "flyway") {
    const match = files.find((file) =>
      /(^|\/)V\d+__.+\.sql$/i.test(file.path)
    );
    return match ? path.posix.dirname(match.path) : "db/migration";
  }

  if (format === "alembic") {
    const versionsFile = files.find((file) => file.path.includes("alembic/versions/"));
    if (versionsFile) return path.posix.dirname(versionsFile.path);
    const alembicFile = files.find((file) => file.path.includes("alembic/"));
    return alembicFile ? path.posix.dirname(alembicFile.path) : "alembic/versions";
  }

  if (format === "liquibase") {
    const match = files.find((file) =>
      file.path.toLowerCase().includes("liquibase") ||
      file.path.toLowerCase().includes("changelog")
    );
    return match ? path.posix.dirname(match.path) : null;
  }

  if (format === "raw_sql") {
    const match = files.find((file) => file.path.endsWith(".sql"));
    return match ? path.posix.dirname(match.path) : "sql";
  }

  return null;
}

function detectMigrationFormat(files: RepoFile[], evidence: string[]): MigrationFormat {
  if (files.some((file) => /(^|\/)V\d+__.+\.sql$/i.test(file.path))) {
    evidence.push("Flyway migration filename detected");
    return "flyway";
  }

  if (
    files.some(
      (file) =>
        file.path.toLowerCase().includes("liquibase") ||
        file.path.toLowerCase().includes("databasechangelog")
    )
  ) {
    evidence.push("Liquibase files detected");
    return "liquibase";
  }

  if (
    files.some(
      (file) =>
        file.path === "alembic.ini" ||
        file.path.includes("alembic/")
    )
  ) {
    evidence.push("Alembic files detected");
    return "alembic";
  }

  if (files.some((file) => file.path.endsWith(".sql"))) {
    evidence.push("Raw SQL files detected");
    return "raw_sql";
  }

  return "unknown";
}

function detectDialect(files: RepoFile[], evidence: string[]): SqlDialect {
  let hasPostgres = false;
  let hasMysql = false;
  let hasSqlite = false;

  for (const file of files) {
    const lowerPath = file.path.toLowerCase();
    const content = readRepoFileContent(file);
    const lowerContent = content.toLowerCase();

    if (
      lowerPath.endsWith("postgresql.conf") ||
      lowerContent.includes("postgresql://") ||
      content.includes("SERIAL") ||
      content.includes("BIGSERIAL") ||
      content.includes("TEXT[]") ||
      content.includes("JSONB")
    ) {
      hasPostgres = true;
    }

    if (
      lowerPath.endsWith("my.cnf") ||
      content.includes("AUTO_INCREMENT") ||
      content.includes("ENGINE=InnoDB")
    ) {
      hasMysql = true;
    }

    if (
      lowerPath.endsWith(".db") ||
      lowerContent.includes("sqlite3")
    ) {
      hasSqlite = true;
    }
  }

  if (hasPostgres) {
    evidence.push("PostgreSQL evidence detected");
    return "postgresql";
  }

  if (hasMysql) {
    evidence.push("MySQL evidence detected");
    return "mysql";
  }

  if (hasSqlite) {
    evidence.push("SQLite evidence detected");
    return "sqlite";
  }

  return "unknown";
}

function extractExistingTables(files: RepoFile[]): string[] {
  const tables = new Set<string>();
  const createTableRegex =
    /CREATE TABLE (?:IF NOT EXISTS )?["`]?(\w+)["`]?/gi;

  for (const file of files) {
    if (!file.path.endsWith(".sql")) continue;
    const content = readRepoFileContent(file);
    let match: RegExpExecArray | null;

    while ((match = createTableRegex.exec(content)) !== null) {
      tables.add(match[1]);
    }
  }

  return [...tables].sort((a, b) => a.localeCompare(b));
}

export function detectDataSchema(files: RepoFile[]): DetectedDataSchema {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      dialect: "unknown",
      migrationFormat: "unknown",
      confidence: "low",
      evidence: ["No repository files available"],
      migrationDir: null,
      existingTables: [],
    };
  }

  const evidence: string[] = [];
  const dialect = detectDialect(files, evidence);
  const migrationFormat = detectMigrationFormat(files, evidence);
  const migrationDir = findMigrationDir(files, migrationFormat);
  const existingTables = extractExistingTables(files);

  let confidence: "high" | "medium" | "low" = "low";
  if (dialect !== "unknown" && migrationFormat !== "unknown") {
    confidence = "high";
  } else if (dialect !== "unknown" || migrationFormat !== "unknown") {
    confidence = "medium";
  }

  if (evidence.length === 0) {
    evidence.push("No recognizable SQL dialect or migration format detected");
  }

  return {
    dialect,
    migrationFormat,
    confidence,
    evidence,
    migrationDir,
    existingTables,
  };
}
