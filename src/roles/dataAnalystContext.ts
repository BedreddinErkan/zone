import path from "node:path";
import type { RepoFile } from "../types/project.js";
import type {
  DetectedDataSchema,
  MigrationFormat,
  SqlDialect,
} from "./detectDataSchema.js";

export interface DataAnalystContext {
  schema: DetectedDataSchema;
  existingSqlFiles: RepoFile[];
  migrationFiles: RepoFile[];
  outputPaths: {
    migrationFile: string;
  };
  dialect: SqlDialect;
  migrationFormat: MigrationFormat;
  outputRules: string[];
  schemaSummary: string;
}

const TASK_FILLER_WORDS = new Set([
  "create",
  "table",
  "add",
  "column",
  "make",
  "a",
  "an",
  "the",
  "for",
  "with",
  "new",
]);

function buildIntentTokens(task: string): string[] {
  const sanitizedTask = task
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/https?:\/\/[^\s]+/g, " ")
    .replace(/www\.[^\s]+/g, " ")
    .replace(/[a-z0-9-]+\.(com|org|net|io|dev|app|co)[^\s]*/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .trim();

  const rawTokens = sanitizedTask.split(/\s+/).filter(Boolean);
  const meaningfulTokens = rawTokens.filter(
    (token) => !TASK_FILLER_WORDS.has(token)
  );
  const sourceTokens = meaningfulTokens.length > 0 ? meaningfulTokens : rawTokens;
  const limitedTokens: string[] = [];
  let totalLength = 0;

  for (const token of sourceTokens) {
    const nextLength =
      totalLength === 0 ? token.length : totalLength + 1 + token.length;
    if (limitedTokens.length >= 5 || nextLength > 40) {
      break;
    }
    limitedTokens.push(token);
    totalLength = nextLength;
  }

  return limitedTokens.length > 0 ? limitedTokens : ["generated", "migration"];
}

function buildSlug(task: string): string {
  return buildIntentTokens(task).join("_");
}

function detectSqlFiles(files: RepoFile[]): RepoFile[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter(
      (file) =>
        file.path.endsWith(".sql") ||
        file.path.endsWith(".db") ||
        file.path.endsWith(".sqlite") ||
        file.path.endsWith(".sqlite3")
    )
    .sort((a, b) => a.path.localeCompare(b.path));
}

function detectMigrationFiles(
  files: RepoFile[],
  migrationFormat: MigrationFormat
): RepoFile[] {
  if (!Array.isArray(files)) return [];

  if (migrationFormat === "flyway") {
    return files
      .filter((file) => /(^|\/)V\d+__.+\.sql$/i.test(file.path))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  if (migrationFormat === "alembic") {
    return files
      .filter(
        (file) =>
          file.path.includes("alembic/versions/") || file.path === "alembic.ini"
      )
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  if (migrationFormat === "liquibase") {
    return files
      .filter(
        (file) =>
          file.path.toLowerCase().includes("liquibase") ||
          file.path.toLowerCase().includes("databasechangelog")
      )
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  return detectSqlFiles(files);
}

function buildSchemaSummary(schema: DetectedDataSchema): string {
  const lines = [
    `SQL dialect: ${schema.dialect}`,
    `Migration format: ${schema.migrationFormat}`,
    `Confidence: ${schema.confidence}`,
    `Evidence: ${schema.evidence.join(", ")}`,
    `Migration directory: ${schema.migrationDir ?? "unknown"}`,
    `Existing tables: ${schema.existingTables.join(", ") || "none detected"}`,
  ];

  return lines.join("\n");
}

function buildOutputRules(
  dialect: SqlDialect,
  existingTables: string[]
): string[] {
  const common = [
    "Never use DROP TABLE or TRUNCATE — these are destructive",
    "Always use IF NOT EXISTS for CREATE TABLE",
    "Use snake_case for all table and column names",
    "Add created_at and updated_at columns unless explicitly told not to",
    `Never invent table names that conflict with existing tables: ${
      existingTables.length > 0 ? existingTables.join(", ") : "none"
    }`,
  ];

  if (dialect === "postgresql") {
    return [
      ...common,
      "Use SERIAL or BIGSERIAL for auto-increment",
      "Use TEXT for strings",
      "Use TIMESTAMPTZ for timestamps",
    ];
  }

  if (dialect === "mysql") {
    return [
      ...common,
      "Use AUTO_INCREMENT for auto-increment",
      "Use VARCHAR for strings",
      "Use DATETIME for timestamps",
    ];
  }

  if (dialect === "sqlite") {
    return [
      ...common,
      "Use INTEGER PRIMARY KEY AUTOINCREMENT for auto-increment",
      "Use TEXT for strings",
      "Use DATETIME for timestamps",
    ];
  }

  return common;
}

function getNextFlywayVersion(migrationFiles: RepoFile[]): number {
  let maxVersion = 0;

  for (const file of migrationFiles) {
    const match = file.path.match(/(^|\/)V(\d+)__/i);
    if (!match) continue;
    const version = Number.parseInt(match[2], 10);
    if (!Number.isNaN(version)) {
      maxVersion = Math.max(maxVersion, version);
    }
  }

  return maxVersion + 1;
}

function buildOutputPath(
  task: string,
  schema: DetectedDataSchema,
  migrationFiles: RepoFile[]
): string {
  const slug = buildSlug(task);

  if (schema.migrationFormat === "flyway") {
    const nextVersion = getNextFlywayVersion(migrationFiles);
    const baseDir = schema.migrationDir ?? "db/migration";
    return `${baseDir}/V${nextVersion}__${slug}.sql`;
  }

  if (schema.migrationFormat === "alembic") {
    return `alembic/versions/${slug}.py`;
  }

  return `sql/${slug}.sql`;
}

export function buildDataAnalystContext(
  task: string,
  schema: DetectedDataSchema,
  files: RepoFile[]
): DataAnalystContext {
  const safeFiles = Array.isArray(files) ? files : [];
  const existingSqlFiles = detectSqlFiles(safeFiles);
  const migrationFiles = detectMigrationFiles(safeFiles, schema.migrationFormat);

  return {
    schema,
    existingSqlFiles,
    migrationFiles,
    outputPaths: {
      migrationFile: buildOutputPath(task, schema, migrationFiles),
    },
    dialect: schema.dialect,
    migrationFormat: schema.migrationFormat,
    outputRules: buildOutputRules(schema.dialect, schema.existingTables),
    schemaSummary: buildSchemaSummary(schema),
  };
}
