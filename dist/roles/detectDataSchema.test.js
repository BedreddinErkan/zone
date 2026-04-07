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
    (0, vitest_1.describe)("path-based dialect detection (hosted mode)", () => {
        (0, vitest_1.it)("detects postgresql from path containing 'postgres'", () => {
            const files = [
                file("config/postgres.config.js"),
                file("db/migrations/V1__init.sql"),
            ];
            const result = (0, detectDataSchema_js_1.detectDataSchema)(files);
            (0, vitest_1.expect)(result.dialect).toBe("postgresql");
        });
        (0, vitest_1.it)("detects postgresql from supabase path", () => {
            const files = [file("supabase/migrations/20240101_init.sql")];
            const result = (0, detectDataSchema_js_1.detectDataSchema)(files);
            (0, vitest_1.expect)(result.dialect).toBe("postgresql");
        });
        (0, vitest_1.it)("detects mysql from path containing 'mysql'", () => {
            const files = [file("config/mysql.config.js"), file("db/schema.sql")];
            const result = (0, detectDataSchema_js_1.detectDataSchema)(files);
            (0, vitest_1.expect)(result.dialect).toBe("mysql");
        });
        (0, vitest_1.it)("detects sqlite from .sqlite file extension", () => {
            const files = [file("data/app.sqlite"), file("db/schema.sql")];
            const result = (0, detectDataSchema_js_1.detectDataSchema)(files);
            (0, vitest_1.expect)(result.dialect).toBe("sqlite");
        });
        (0, vitest_1.it)("detects sqlite from .db file extension", () => {
            const files = [file("data/local.db")];
            const result = (0, detectDataSchema_js_1.detectDataSchema)(files);
            (0, vitest_1.expect)(result.dialect).toBe("sqlite");
        });
    });
    (0, vitest_1.describe)("prisma migration format", () => {
        (0, vitest_1.it)("detects prisma from prisma/migrations path", () => {
            const files = [
                file("prisma/migrations/20240101_init/migration.sql"),
                file("prisma/schema.prisma"),
            ];
            const result = (0, detectDataSchema_js_1.detectDataSchema)(files);
            (0, vitest_1.expect)(result.migrationFormat).toBe("prisma");
        });
        (0, vitest_1.it)("detects prisma migration dir correctly", () => {
            const files = [file("prisma/migrations/20240101_init/migration.sql")];
            const result = (0, detectDataSchema_js_1.detectDataSchema)(files);
            (0, vitest_1.expect)(result.migrationDir).toContain("prisma");
        });
    });
    (0, vitest_1.describe)("confidence levels", () => {
        (0, vitest_1.it)("returns high confidence when both dialect and format are detected", () => {
            const files = [
                file("supabase/migrations/V1__init.sql"),
                file("db/migration/V1__init.sql"),
            ];
            const result = (0, detectDataSchema_js_1.detectDataSchema)(files);
            (0, vitest_1.expect)(result.confidence).toBe("high");
        });
        (0, vitest_1.it)("returns medium confidence when only format is detected", () => {
            const files = [file("db/migration/V1__init.sql")];
            const result = (0, detectDataSchema_js_1.detectDataSchema)(files);
            (0, vitest_1.expect)(result.confidence).toBe("medium");
        });
        (0, vitest_1.it)("returns low confidence when nothing is detected", () => {
            const files = [file("src/index.ts"), file("package.json")];
            const result = (0, detectDataSchema_js_1.detectDataSchema)(files);
            (0, vitest_1.expect)(result.confidence).toBe("low");
        });
    });
});
//# sourceMappingURL=detectDataSchema.test.js.map