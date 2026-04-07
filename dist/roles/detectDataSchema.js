"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectDataSchema = detectDataSchema;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
function readRepoFileContent(file) {
    try {
        return (0, node_fs_1.readFileSync)(file.absolutePath, "utf8");
    }
    catch {
        return "";
    }
}
function findMigrationDir(files, format) {
    if (!Array.isArray(files))
        return null;
    if (format === "flyway") {
        const match = files.find((file) => /(^|\/)V\d+__.+\.sql$/i.test(file.path));
        return match ? node_path_1.default.posix.dirname(match.path) : "db/migration";
    }
    if (format === "alembic") {
        const versionsFile = files.find((file) => file.path.includes("alembic/versions/"));
        if (versionsFile)
            return node_path_1.default.posix.dirname(versionsFile.path);
        const alembicFile = files.find((file) => file.path.includes("alembic/"));
        return alembicFile ? node_path_1.default.posix.dirname(alembicFile.path) : "alembic/versions";
    }
    if (format === "liquibase") {
        const match = files.find((file) => file.path.toLowerCase().includes("liquibase") ||
            file.path.toLowerCase().includes("changelog"));
        return match ? node_path_1.default.posix.dirname(match.path) : null;
    }
    if (format === "prisma") {
        const match = files.find((file) => file.path.toLowerCase().includes("prisma/migrations"));
        return match ? node_path_1.default.posix.dirname(match.path) : "prisma/migrations";
    }
    if (format === "raw_sql") {
        const match = files.find((file) => file.path.endsWith(".sql") ||
            (/migrations\//i.test(file.path) && /\.[jt]s$/i.test(file.path)));
        return match ? node_path_1.default.posix.dirname(match.path) : "sql";
    }
    return null;
}
function detectMigrationFormat(files, evidence) {
    if (files.some((file) => /(^|\/)V\d+__.+\.sql$/i.test(file.path))) {
        evidence.push("Flyway migration filename detected");
        return "flyway";
    }
    if (files.some((file) => file.path.toLowerCase().includes("liquibase") ||
        file.path.toLowerCase().includes("databasechangelog"))) {
        evidence.push("Liquibase files detected");
        return "liquibase";
    }
    if (files.some((file) => file.path === "alembic.ini" ||
        file.path.includes("alembic/"))) {
        evidence.push("Alembic files detected");
        return "alembic";
    }
    if (files.some((file) => file.path.toLowerCase().includes("prisma/migrations"))) {
        evidence.push("Prisma migrations detected");
        return "prisma";
    }
    if (files.some((file) => file.path.toLowerCase().includes("knex/migrations") ||
        (/migrations\//i.test(file.path) && /\.[jt]s$/i.test(file.path)))) {
        evidence.push("JavaScript/TypeScript migration files detected");
        return "raw_sql";
    }
    if (files.some((file) => file.path.endsWith(".sql"))) {
        evidence.push("Raw SQL files detected");
        return "raw_sql";
    }
    return "unknown";
}
function detectDialect(files, evidence) {
    let hasPostgres = false;
    let hasMysql = false;
    let hasSqlite = false;
    for (const file of files) {
        const lowerPath = file.path.toLowerCase();
        if (lowerPath.includes("postgres") ||
            lowerPath.includes("postgresql") ||
            lowerPath.endsWith("pg.config.js") ||
            lowerPath.endsWith("pg.config.ts") ||
            ((lowerPath.endsWith("database.yml") || lowerPath.endsWith("database.yaml")) &&
                lowerPath.includes("postgres")) ||
            lowerPath.includes("supabase")) {
            hasPostgres = true;
        }
        if (lowerPath.includes("mysql") || lowerPath.endsWith("my.cnf")) {
            hasMysql = true;
        }
        if (lowerPath.endsWith(".db") ||
            lowerPath.endsWith(".sqlite") ||
            lowerPath.endsWith(".sqlite3") ||
            lowerPath.includes("sqlite")) {
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
    for (const file of files) {
        const lowerPath = file.path.toLowerCase();
        const content = readRepoFileContent(file);
        const lowerContent = content.toLowerCase();
        if (lowerPath.endsWith("postgresql.conf") ||
            lowerContent.includes("postgresql://") ||
            lowerContent.includes("pg_") ||
            lowerContent.includes("pgcrypto") ||
            lowerContent.includes("uuid_generate") ||
            lowerContent.includes("::text") ||
            lowerContent.includes("::integer") ||
            (lowerContent.includes("database_url") && lowerContent.includes("postgres")) ||
            content.includes("SERIAL") ||
            content.includes("BIGSERIAL") ||
            content.includes("TEXT[]") ||
            content.includes("JSONB")) {
            hasPostgres = true;
        }
        if (lowerPath.endsWith("my.cnf") ||
            lowerContent.includes("mysql2") ||
            lowerContent.includes("mysql://") ||
            (lowerContent.includes("sequelize") && lowerContent.includes("mysql")) ||
            content.includes("AUTO_INCREMENT") ||
            content.includes("ENGINE=InnoDB")) {
            hasMysql = true;
        }
        if (lowerPath.endsWith(".db") ||
            lowerContent.includes("sqlite3") ||
            lowerContent.includes("better-sqlite3") ||
            lowerContent.includes("sqlite://") ||
            (lowerContent.includes("knex") && lowerContent.includes("sqlite"))) {
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
function extractExistingTables(files) {
    const tables = new Set();
    const createTableRegex = /CREATE TABLE (?:IF NOT EXISTS )?["`]?(\w+)["`]?/gi;
    for (const file of files) {
        if (!file.path.endsWith(".sql"))
            continue;
        const content = readRepoFileContent(file);
        let match;
        while ((match = createTableRegex.exec(content)) !== null) {
            tables.add(match[1]);
        }
    }
    return [...tables].sort((a, b) => a.localeCompare(b));
}
function detectDataSchema(files) {
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
    const evidence = [];
    const dialect = detectDialect(files, evidence);
    const migrationFormat = detectMigrationFormat(files, evidence);
    const migrationDir = findMigrationDir(files, migrationFormat);
    const existingTables = extractExistingTables(files);
    let confidence = "low";
    if (dialect !== "unknown" && migrationFormat !== "unknown") {
        confidence = "high";
    }
    else if (dialect !== "unknown" || migrationFormat !== "unknown") {
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
//# sourceMappingURL=detectDataSchema.js.map