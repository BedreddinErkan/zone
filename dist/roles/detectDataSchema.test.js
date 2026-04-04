"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const detectDataSchema_js_1 = require("./detectDataSchema.js");
function file(p) {
    return {
        path: p,
        absolutePath: `C:/repo/${p}`,
        extension: p.split(".").pop() ?? "",
        category: "unknown",
    };
}
(0, vitest_1.describe)("detectDataSchema", () => {
    (0, vitest_1.it)("returns unknown for empty array", () => {
        const result = (0, detectDataSchema_js_1.detectDataSchema)([]);
        (0, vitest_1.expect)(result.dialect).toBe("unknown");
        (0, vitest_1.expect)(result.migrationFormat).toBe("unknown");
        (0, vitest_1.expect)(result.confidence).toBe("low");
    });
    (0, vitest_1.it)("returns unknown for non-array input", () => {
        // @ts-expect-error testing invalid input
        const result = (0, detectDataSchema_js_1.detectDataSchema)(null);
        (0, vitest_1.expect)(result.dialect).toBe("unknown");
        (0, vitest_1.expect)(result.migrationFormat).toBe("unknown");
    });
    (0, vitest_1.it)("detects flyway from V1__init.sql filename pattern", () => {
        const result = (0, detectDataSchema_js_1.detectDataSchema)([file("db/migration/V1__init.sql")]);
        (0, vitest_1.expect)(result.migrationFormat).toBe("flyway");
        (0, vitest_1.expect)(result.migrationDir).toBe("db/migration");
    });
    (0, vitest_1.it)("detects mysql from my.cnf file", () => {
        const result = (0, detectDataSchema_js_1.detectDataSchema)([file("config/my.cnf")]);
        (0, vitest_1.expect)(result.dialect).toBe("mysql");
    });
    (0, vitest_1.it)("detects sqlite from db file", () => {
        const result = (0, detectDataSchema_js_1.detectDataSchema)([file("data/app.db")]);
        (0, vitest_1.expect)(result.dialect).toBe("sqlite");
    });
    (0, vitest_1.it)("detects raw_sql from plain sql files", () => {
        const result = (0, detectDataSchema_js_1.detectDataSchema)([file("sql/create_users.sql")]);
        (0, vitest_1.expect)(result.migrationFormat).toBe("raw_sql");
    });
    (0, vitest_1.it)("detects alembic from alembic.ini", () => {
        const result = (0, detectDataSchema_js_1.detectDataSchema)([file("alembic.ini")]);
        (0, vitest_1.expect)(result.migrationFormat).toBe("alembic");
    });
    (0, vitest_1.it)("returns empty existingTables when no readable sql content exists", () => {
        const result = (0, detectDataSchema_js_1.detectDataSchema)([file("db/migration/V1__init.sql")]);
        (0, vitest_1.expect)(result.existingTables).toEqual([]);
    });
});
//# sourceMappingURL=detectDataSchema.test.js.map