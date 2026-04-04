"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runAgent_js_1 = require("./runAgent.js");
(0, vitest_1.describe)("runAgent", () => {
    (0, vitest_1.it)("returns safe_to_apply for a low-risk rename task", async () => {
        const result = await (0, runAgent_js_1.runAgent)({
            task: "rename helper function"
        });
        (0, vitest_1.expect)(result.task).toBe("rename helper function");
        (0, vitest_1.expect)(result.decision.mode).toBe("safe_to_apply");
        (0, vitest_1.expect)(result.explanation).toContain("SAFE TO APPLY");
        (0, vitest_1.expect)(result.recommendation).toBe("Patch can be applied automatically under current safeguards.");
        (0, vitest_1.expect)(result.trace).toBeDefined();
        (0, vitest_1.expect)(result.trace.signals).toEqual(["low_risk"]);
        (0, vitest_1.expect)(result.trace.riskScore).toBe(result.risk.score);
        (0, vitest_1.expect)(result.trace.confidenceScore).toBe(result.confidence.score);
        (0, vitest_1.expect)(result.trace.appliedPenalties).toEqual([]);
    });
    (0, vitest_1.it)("returns safe_to_apply for a general low-signal endpoint task", async () => {
        const result = await (0, runAgent_js_1.runAgent)({
            task: "add update endpoint for treatment timeline"
        });
        (0, vitest_1.expect)(result.decision.mode).toBe("safe_to_apply");
        (0, vitest_1.expect)(result.trace).toBeDefined();
        (0, vitest_1.expect)(result.trace.riskScore).toBe(result.risk.score);
        (0, vitest_1.expect)(result.trace.confidenceScore).toBe(result.confidence.score);
    });
    (0, vitest_1.it)("returns preview_only for schema-related tasks", async () => {
        const result = await (0, runAgent_js_1.runAgent)({
            task: "add schema migration for treatment timeline"
        });
        (0, vitest_1.expect)(result.decision.mode).toBe("preview_only");
        (0, vitest_1.expect)(result.explanation).toContain("PREVIEW ONLY");
        (0, vitest_1.expect)(result.recommendation).toBe("Preview the patch and verify the affected scope before any apply step.");
        (0, vitest_1.expect)(result.trace).toBeDefined();
        (0, vitest_1.expect)(result.trace.signals).toContain("schema");
        (0, vitest_1.expect)(result.trace.riskScore).toBe(result.risk.score);
        (0, vitest_1.expect)(result.trace.confidenceScore).toBe(result.confidence.score);
        (0, vitest_1.expect)(result.trace.appliedPenalties).toContainEqual({
            type: "schema",
            impact: -25
        });
    });
    (0, vitest_1.it)("returns preview_only for critical domain updates", async () => {
        const result = await (0, runAgent_js_1.runAgent)({
            task: "update payment service logic"
        });
        (0, vitest_1.expect)(result.decision.mode).toBe("preview_only");
        (0, vitest_1.expect)(result.trace).toBeDefined();
        (0, vitest_1.expect)(result.trace.signals).toContain("critical_domain");
    });
    (0, vitest_1.it)("returns blocked for destructive database tasks", async () => {
        const result = await (0, runAgent_js_1.runAgent)({
            task: "delete user table from database"
        });
        (0, vitest_1.expect)(result.task).toBe("delete user table from database");
        (0, vitest_1.expect)(result.decision.mode).toBe("blocked");
        (0, vitest_1.expect)(result.explanation).toContain("BLOCKED");
        (0, vitest_1.expect)(result.recommendation).toBe("Do not auto-apply. Manual review is required before making changes.");
        (0, vitest_1.expect)(result.topRisks.length).toBeGreaterThan(0);
        (0, vitest_1.expect)(result.trace).toBeDefined();
        (0, vitest_1.expect)(result.trace.signals).toContain("destructive");
        (0, vitest_1.expect)(result.trace.riskScore).toBe(result.risk.score);
        (0, vitest_1.expect)(result.trace.confidenceScore).toBe(result.confidence.score);
        (0, vitest_1.expect)(result.trace.appliedPenalties).toContainEqual({
            type: "destructive",
            impact: -50
        });
    });
    (0, vitest_1.it)("returns safe_to_apply for unknown low-signal tasks", async () => {
        const result = await (0, runAgent_js_1.runAgent)({
            task: "do something"
        });
        (0, vitest_1.expect)(result.decision.mode).toBe("safe_to_apply");
        (0, vitest_1.expect)(result.trace).toBeDefined();
        (0, vitest_1.expect)(result.trace.riskScore).toBe(result.risk.score);
        (0, vitest_1.expect)(result.trace.confidenceScore).toBe(result.confidence.score);
    });
    // ---------------------------------------------------------------------------
    // mass_scope signal — integration
    // ---------------------------------------------------------------------------
    (0, vitest_1.it)("'delete all user sessions' → blocked (destructive + mass_scope = 75)", async () => {
        const result = await (0, runAgent_js_1.runAgent)({ task: "delete all user sessions" });
        (0, vitest_1.expect)(result.decision.mode).toBe("blocked");
        (0, vitest_1.expect)(result.risk.breakdown.destructive).toBe(50);
        (0, vitest_1.expect)(result.risk.breakdown.massScope).toBe(25);
        (0, vitest_1.expect)(result.risk.score).toBe(75);
        (0, vitest_1.expect)(result.topRisks.some((r) => r.title === "Mass-scope operation")).toBe(true);
        (0, vitest_1.expect)(result.trace.signals).toContain("destructive");
        (0, vitest_1.expect)(result.trace.signals).toContain("mass_scope");
        (0, vitest_1.expect)(result.trace.riskScore).toBe(75);
        (0, vitest_1.expect)(result.trace.appliedPenalties).toContainEqual({
            type: "destructive",
            impact: -50
        });
        (0, vitest_1.expect)(result.trace.appliedPenalties).toContainEqual({
            type: "mass_scope",
            impact: -25
        });
    });
    (0, vitest_1.it)("'purge all cache' → preview_only (mass_scope only = 25)", async () => {
        const result = await (0, runAgent_js_1.runAgent)({ task: "purge all cache" });
        (0, vitest_1.expect)(result.decision.mode).toBe("preview_only");
        (0, vitest_1.expect)(result.risk.breakdown.massScope).toBe(25);
        (0, vitest_1.expect)(result.risk.breakdown.destructive).toBe(0);
        (0, vitest_1.expect)(result.trace.signals).toContain("mass_scope");
        (0, vitest_1.expect)(result.trace.appliedPenalties).toContainEqual({
            type: "mass_scope",
            impact: -25
        });
    });
    (0, vitest_1.it)("'delete user session' (tekil) → preview_only, mass_scope yok", async () => {
        const result = await (0, runAgent_js_1.runAgent)({ task: "delete user session" });
        (0, vitest_1.expect)(result.decision.mode).toBe("preview_only");
        (0, vitest_1.expect)(result.risk.breakdown.massScope).toBe(0);
        (0, vitest_1.expect)(result.topRisks.every((r) => r.title !== "Mass-scope operation")).toBe(true);
        (0, vitest_1.expect)(result.trace.signals).not.toContain("mass_scope");
    });
    (0, vitest_1.it)("mass_scope topRisk reason içeriği doğru", async () => {
        const result = await (0, runAgent_js_1.runAgent)({ task: "wipe all data" });
        const massRisk = result.topRisks.find((r) => r.title === "Mass-scope operation");
        (0, vitest_1.expect)(massRisk).toBeDefined();
        (0, vitest_1.expect)(massRisk?.severity).toBe("high");
        (0, vitest_1.expect)(massRisk?.reason).toContain("irreversible");
        (0, vitest_1.expect)(result.trace.signals).toContain("mass_scope");
    });
    (0, vitest_1.it)("explanation mass-scope reason semantiğini koruyor", async () => {
        const result = await (0, runAgent_js_1.runAgent)({ task: "purge all records" });
        (0, vitest_1.expect)(result.trace.signals).toContain("mass_scope");
        (0, vitest_1.expect)(result.reasonCodes).toContain("PREVIEW_MASS_SCOPE_CHANGE");
        (0, vitest_1.expect)(result.explanation).toContain("Why:");
        (0, vitest_1.expect)(result.explanation.toLowerCase()).toMatch(/many records|broad surface area/);
    });
    (0, vitest_1.describe)("runAgent explanation consistency", () => {
        (0, vitest_1.it)('adds a "Why:" line for blocked results', async () => {
            const result = await (0, runAgent_js_1.runAgent)({
                task: "drop database schema and delete all user records"
            });
            (0, vitest_1.expect)(result.decision.mode).toBe("blocked");
            (0, vitest_1.expect)(result.reasonCodes.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(result.explanation).toContain("Why:");
        });
        (0, vitest_1.it)('adds a "Why:" line for preview_only results', async () => {
            const result = await (0, runAgent_js_1.runAgent)({
                task: "update auth schema for all accounts"
            });
            (0, vitest_1.expect)(result.decision.mode).toBe("preview_only");
            (0, vitest_1.expect)(result.reasonCodes.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(result.explanation).toContain("Why:");
        });
        (0, vitest_1.it)('adds a "Why:" line for safe_to_apply results', async () => {
            const result = await (0, runAgent_js_1.runAgent)({
                task: "rename local helper function in one file"
            });
            (0, vitest_1.expect)(result.decision.mode).toBe("safe_to_apply");
            (0, vitest_1.expect)(result.reasonCodes.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(result.explanation).toContain("Why:");
        });
        (0, vitest_1.it)("keeps explanation semantically aligned with reason codes", async () => {
            const result = await (0, runAgent_js_1.runAgent)({
                task: "drop billing table"
            });
            (0, vitest_1.expect)(result.reasonCodes.length).toBeGreaterThan(0);
            (0, vitest_1.expect)(result.explanation).toContain("Why:");
            if (result.reasonCodes.includes("BLOCKED_DESTRUCTIVE_OPERATION")) {
                (0, vitest_1.expect)(result.explanation.toLowerCase()).toMatch(/destructive|delete|drop/);
            }
            if (result.reasonCodes.includes("BLOCKED_SCHEMA_RISK")) {
                (0, vitest_1.expect)(result.explanation.toLowerCase()).toMatch(/schema/);
            }
        });
        (0, vitest_1.describe)("runAgent explanation consistency", () => {
            (0, vitest_1.it)('adds a "Why:" line for blocked results', async () => {
                const result = await (0, runAgent_js_1.runAgent)({
                    task: "drop database schema and delete all user records"
                });
                (0, vitest_1.expect)(result.decision.mode).toBe("blocked");
                (0, vitest_1.expect)(result.reasonCodes.length).toBeGreaterThan(0);
                (0, vitest_1.expect)(result.explanation).toContain("Why:");
            });
            (0, vitest_1.it)('adds a "Why:" line for preview_only results', async () => {
                const result = await (0, runAgent_js_1.runAgent)({
                    task: "update auth schema for all accounts"
                });
                (0, vitest_1.expect)(result.decision.mode).toBe("preview_only");
                (0, vitest_1.expect)(result.reasonCodes.length).toBeGreaterThan(0);
                (0, vitest_1.expect)(result.explanation).toContain("Why:");
            });
            (0, vitest_1.it)('adds a "Why:" line for safe_to_apply results', async () => {
                const result = await (0, runAgent_js_1.runAgent)({
                    task: "rename local helper function in one file"
                });
                (0, vitest_1.expect)(result.decision.mode).toBe("safe_to_apply");
                (0, vitest_1.expect)(result.reasonCodes.length).toBeGreaterThan(0);
                (0, vitest_1.expect)(result.explanation).toContain("Why:");
            });
            (0, vitest_1.it)("keeps explanation semantically aligned with reason codes", async () => {
                const result = await (0, runAgent_js_1.runAgent)({
                    task: "drop billing schema"
                });
                (0, vitest_1.expect)(result.reasonCodes.length).toBeGreaterThan(0);
                (0, vitest_1.expect)(result.explanation).toContain("Why:");
                if (result.reasonCodes.includes("BLOCKED_DESTRUCTIVE_OPERATION")) {
                    (0, vitest_1.expect)(result.explanation.toLowerCase()).toMatch(/destructive|delete|drop/);
                }
                if (result.reasonCodes.includes("BLOCKED_SCHEMA_RISK")) {
                    (0, vitest_1.expect)(result.explanation.toLowerCase()).toMatch(/schema/);
                }
            });
            (0, vitest_1.it)("keeps trace reason mapping codes aligned with reasonCodes", async () => {
                const result = await (0, runAgent_js_1.runAgent)({
                    task: "delete all user sessions"
                });
                (0, vitest_1.expect)(result.reasonCodes.length).toBeGreaterThan(0);
                (0, vitest_1.expect)(result.trace.reasonMapping.length).toBe(result.reasonCodes.length);
                (0, vitest_1.expect)(result.trace.reasonMapping.map((item) => item.code)).toEqual(result.reasonCodes);
            });
        });
    });
    (0, vitest_1.it)("keeps blocked explanation semantically aligned for destructive mass-scope tasks", async () => {
        const result = await (0, runAgent_js_1.runAgent)({
            task: "delete all user sessions"
        });
        (0, vitest_1.expect)(result.decision.mode).toBe("blocked");
        (0, vitest_1.expect)(result.reasonCodes).toContain("BLOCKED_DESTRUCTIVE_OPERATION");
        (0, vitest_1.expect)(result.explanation).toContain("BLOCKED");
        (0, vitest_1.expect)(result.explanation.toLowerCase()).toMatch(/destructive|irreversible|high risk|manual review/);
    });
    // ---------------------------------------------------------------------------
    // buildExplanation v2 — multi-line integration
    // ---------------------------------------------------------------------------
});
//# sourceMappingURL=runAgent.test.js.map