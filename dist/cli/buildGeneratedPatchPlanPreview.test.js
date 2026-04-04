"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const buildGeneratedPatchPlanPreview_js_1 = require("./buildGeneratedPatchPlanPreview.js");
(0, vitest_1.describe)("buildGeneratedPatchPlanPreview", () => {
    (0, vitest_1.it)("builds a rendered generated patch plan preview for safe_to_apply", () => {
        const output = (0, buildGeneratedPatchPlanPreview_js_1.buildGeneratedPatchPlanPreview)({
            task: "update import path in api client",
            decision: {
                mode: "safe_to_apply",
                confidenceScore: 91
            },
            reasonCodes: ["SAFE_LOW_RISK", "SAFE_HIGH_CONFIDENCE"]
        });
        (0, vitest_1.expect)(output).toContain("=== GENERATED PATCH PLAN ===");
        (0, vitest_1.expect)(output).toContain("Intent:");
        (0, vitest_1.expect)(output).toContain("Allowed: yes");
        (0, vitest_1.expect)(output).toContain("Strategy: safe");
        (0, vitest_1.expect)(output).toContain("Intent: update_import");
        (0, vitest_1.expect)(output).toContain("Confidence: 91");
        (0, vitest_1.expect)(output).toContain("- update_import (scope: single_file)");
        (0, vitest_1.expect)(output).toContain("- SAFE_LOW_RISK");
        (0, vitest_1.expect)(output).toContain("- SAFE_HIGH_CONFIDENCE");
    });
    (0, vitest_1.it)("builds a blocked preview when generation is not allowed", () => {
        const output = (0, buildGeneratedPatchPlanPreview_js_1.buildGeneratedPatchPlanPreview)({
            task: "rewrite authentication flow",
            decision: {
                mode: "safe_to_apply",
                confidenceScore: 88
            },
            reasonCodes: ["SAFE_LOW_RISK"]
        });
        (0, vitest_1.expect)(output).toContain("Allowed: no");
        (0, vitest_1.expect)(output).toContain("Strategy: safe");
        (0, vitest_1.expect)(output).toContain("Intent: unknown");
        (0, vitest_1.expect)(output).toContain("Patch generation blocked because task intent is unknown.");
    });
    (0, vitest_1.it)("defaults reason codes to an empty array", () => {
        const output = (0, buildGeneratedPatchPlanPreview_js_1.buildGeneratedPatchPlanPreview)({
            task: "add comment above helper",
            decision: {
                mode: "preview_only",
                confidenceScore: 80
            },
            reasonCodes: []
        });
        (0, vitest_1.expect)(output).toContain("Derived From:");
        (0, vitest_1.expect)(output).toContain("- none");
    });
});
//# sourceMappingURL=buildGeneratedPatchPlanPreview.test.js.map