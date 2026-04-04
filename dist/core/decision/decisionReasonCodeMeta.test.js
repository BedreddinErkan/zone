"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const decisionReasonCodeMeta_js_1 = require("./decisionReasonCodeMeta.js");
(0, vitest_1.describe)("decisionReasonCodeMeta", () => {
    (0, vitest_1.it)("returns metadata for a known reason code", () => {
        const meta = (0, decisionReasonCodeMeta_js_1.getDecisionReasonCodeMeta)("BLOCKED_DESTRUCTIVE_OPERATION");
        (0, vitest_1.expect)(meta.code).toBe("BLOCKED_DESTRUCTIVE_OPERATION");
        (0, vitest_1.expect)(meta.label).toBe("Destructive operation detected");
        (0, vitest_1.expect)(meta.severity).toBe("high");
        (0, vitest_1.expect)(meta.category).toBe("safety");
    });
    (0, vitest_1.it)("builds reason details in input order", () => {
        const result = (0, decisionReasonCodeMeta_js_1.buildDecisionReasonDetails)([
            "BLOCKED_SCHEMA_RISK",
            "BLOCKED_HIGH_RISK_SCORE"
        ]);
        (0, vitest_1.expect)(result).toHaveLength(2);
        (0, vitest_1.expect)(result[0].code).toBe("BLOCKED_SCHEMA_RISK");
        (0, vitest_1.expect)(result[1].code).toBe("BLOCKED_HIGH_RISK_SCORE");
    });
    (0, vitest_1.it)("exposes metadata for all supported reason codes", () => {
        (0, vitest_1.expect)(decisionReasonCodeMeta_js_1.DECISION_REASON_CODE_META.BLOCKED_SCHEMA_RISK.label).toBe("Schema risk detected");
        (0, vitest_1.expect)(decisionReasonCodeMeta_js_1.DECISION_REASON_CODE_META.PREVIEW_LOW_CONFIDENCE.severity).toBe("medium");
        (0, vitest_1.expect)(decisionReasonCodeMeta_js_1.DECISION_REASON_CODE_META.SAFE_HIGH_CONFIDENCE.category).toBe("confidence");
    });
});
//# sourceMappingURL=decisionReasonCodeMeta.test.js.map