"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const dataAnalystContext_js_1 = require("./dataAnalystContext.js");
function buildSchema(overrides = {}) {
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
function file(p) {
    return {
        path: p,
        absolutePath: `C:/repo/${p}`,
        extension: p.split(".").pop() ?? "",
        category: "unknown",
    };
}
(0, vitest_1.describe)("buildDataAnalystContext", () => {
    (0, vitest_1.it)("builds correct flyway migration path with next version number", () => {
        const context = (0, dataAnalystContext_js_1.buildDataAnalystContext)("Create table for user sessions", buildSchema(), [file("db/migration/V1__init.sql"), file("db/migration/V2__users.sql")]);
        (0, vitest_1.expect)(context.outputPaths.migrationFile).toBe("db/migration/V3__user_sessions.sql");
    });
    (0, vitest_1.it)("builds correct raw_sql path", () => {
        const context = (0, dataAnalystContext_js_1.buildDataAnalystContext)("Create table for audit logs", buildSchema({
            migrationFormat: "raw_sql",
            migrationDir: "sql",
        }), []);
        (0, vitest_1.expect)(context.outputPaths.migrationFile).toBe("sql/audit_logs.sql");
    });
    (0, vitest_1.it)("generates correct slug from task", () => {
        const context = (0, dataAnalystContext_js_1.buildDataAnalystContext)("Create a new table for customer order history", buildSchema(), []);
        (0, vitest_1.expect)(context.outputPaths.migrationFile).toContain("customer_order_history");
    });
    (0, vitest_1.it)("includes Never use DROP TABLE in output rules", () => {
        const context = (0, dataAnalystContext_js_1.buildDataAnalystContext)("Create table for users", buildSchema(), []);
        (0, vitest_1.expect)(context.outputRules).toContain("Never use DROP TABLE or TRUNCATE — these are destructive");
    });
    (0, vitest_1.it)("includes existing tables in output rules when tables exist", () => {
        const context = (0, dataAnalystContext_js_1.buildDataAnalystContext)("Create table for invoices", buildSchema({
            existingTables: ["users", "orders"],
        }), []);
        (0, vitest_1.expect)(context.outputRules.some((rule) => rule.includes("users, orders"))).toBe(true);
    });
});
//# sourceMappingURL=dataAnalystContext.test.js.map