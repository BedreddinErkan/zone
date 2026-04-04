"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runAgent_js_1 = require("./runAgent.js");
// ---------------------------------------------------------------------------
// buildTopRisks — signal-specific, actionable reasons
// ---------------------------------------------------------------------------
(0, vitest_1.describe)("buildTopRisks — destructive signal", () => {
    (0, vitest_1.it)("returns a high-severity risk with actionable reason", () => {
        const risks = (0, runAgent_js_1.buildTopRisks)(75, ["destructive"]);
        (0, vitest_1.expect)(risks).toHaveLength(1);
        (0, vitest_1.expect)(risks[0]).toMatchObject({
            title: "Potentially destructive change",
            severity: "high",
            reason: "Task contains destructive keywords that may cause irreversible data loss.",
        });
    });
    (0, vitest_1.it)("reason does NOT contain the score", () => {
        const risks = (0, runAgent_js_1.buildTopRisks)(99, ["destructive"]);
        (0, vitest_1.expect)(risks[0]?.reason).not.toContain("99");
        (0, vitest_1.expect)(risks[0]?.reason).not.toMatch(/Risk score/i);
    });
});
(0, vitest_1.describe)("buildTopRisks — schema signal", () => {
    (0, vitest_1.it)("returns a medium-severity risk with actionable reason", () => {
        const risks = (0, runAgent_js_1.buildTopRisks)(25, ["schema"]);
        (0, vitest_1.expect)(risks).toHaveLength(1);
        (0, vitest_1.expect)(risks[0]).toMatchObject({
            title: "Schema-sensitive change",
            severity: "medium",
            reason: "Schema modifications can break existing data contracts or migrations.",
        });
    });
});
(0, vitest_1.describe)("buildTopRisks — critical_domain signal", () => {
    (0, vitest_1.it)("returns a medium-severity risk with actionable reason", () => {
        const risks = (0, runAgent_js_1.buildTopRisks)(40, ["critical_domain"]);
        (0, vitest_1.expect)(risks).toHaveLength(1);
        (0, vitest_1.expect)(risks[0]).toMatchObject({
            title: "Critical domain surface",
            severity: "medium",
            reason: "Touches auth, billing, or production — elevated impact if change is incorrect.",
        });
    });
});
(0, vitest_1.describe)("buildTopRisks — mass_scope signal", () => {
    (0, vitest_1.it)("returns a high-severity risk with actionable reason", () => {
        const risks = (0, runAgent_js_1.buildTopRisks)(60, ["mass_scope"]);
        (0, vitest_1.expect)(risks).toHaveLength(1);
        (0, vitest_1.expect)(risks[0]).toMatchObject({
            title: "Mass-scope operation",
            severity: "high",
            reason: "Task targets all records or the entire dataset — bulk operations are irreversible.",
        });
    });
    (0, vitest_1.it)("reason does NOT contain the score", () => {
        const risks = (0, runAgent_js_1.buildTopRisks)(88, ["mass_scope"]);
        (0, vitest_1.expect)(risks[0]?.reason).not.toContain("88");
        (0, vitest_1.expect)(risks[0]?.reason).not.toMatch(/Risk score/i);
    });
});
(0, vitest_1.describe)("buildTopRisks — multiple signals", () => {
    (0, vitest_1.it)("returns one risk per active signal, in signal priority order", () => {
        const risks = (0, runAgent_js_1.buildTopRisks)(75, ["destructive", "schema"]);
        (0, vitest_1.expect)(risks).toHaveLength(2);
        (0, vitest_1.expect)(risks[0]?.title).toBe("Potentially destructive change");
        (0, vitest_1.expect)(risks[1]?.title).toBe("Schema-sensitive change");
    });
    (0, vitest_1.it)("returns all three risks when all non-low signals are present", () => {
        const risks = (0, runAgent_js_1.buildTopRisks)(80, ["destructive", "schema", "critical_domain"]);
        (0, vitest_1.expect)(risks).toHaveLength(3);
        (0, vitest_1.expect)(risks.map((r) => r.severity)).toEqual(["high", "medium", "medium"]);
    });
    (0, vitest_1.it)("includes mass_scope in signal priority order", () => {
        const risks = (0, runAgent_js_1.buildTopRisks)(90, [
            "destructive",
            "schema",
            "critical_domain",
            "mass_scope",
        ]);
        (0, vitest_1.expect)(risks).toHaveLength(4);
        (0, vitest_1.expect)(risks.map((r) => r.title)).toEqual([
            "Potentially destructive change",
            "Schema-sensitive change",
            "Critical domain surface",
            "Mass-scope operation",
        ]);
        (0, vitest_1.expect)(risks.map((r) => r.severity)).toEqual([
            "high",
            "medium",
            "medium",
            "high",
        ]);
    });
});
(0, vitest_1.describe)("buildTopRisks — low_risk signal", () => {
    (0, vitest_1.it)("returns no risks for low_risk-only signal", () => {
        const risks = (0, runAgent_js_1.buildTopRisks)(5, ["low_risk"]);
        (0, vitest_1.expect)(risks).toHaveLength(0);
    });
    (0, vitest_1.it)("returns no risks for empty signals", () => {
        const risks = (0, runAgent_js_1.buildTopRisks)(0, []);
        (0, vitest_1.expect)(risks).toHaveLength(0);
    });
});
//# sourceMappingURL=buildTopRisks.test.js.map