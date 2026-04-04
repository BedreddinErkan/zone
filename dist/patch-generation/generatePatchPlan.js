"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatePatchPlan = generatePatchPlan;
const buildPatchOperations_js_1 = require("./buildPatchOperations.js");
const classifyPatchIntent_js_1 = require("./classifyPatchIntent.js");
const isIntentAllowed_js_1 = require("./isIntentAllowed.js");
function mapDecisionModeToStrategy(mode) {
    switch (mode) {
        case "blocked":
            return "blocked";
        case "preview_only":
            return "restricted";
        case "safe_to_apply":
            return "safe";
        default:
            return "blocked";
    }
}
function generatePatchPlan(input) {
    const strategy = mapDecisionModeToStrategy(input.decision.mode);
    const intent = (0, classifyPatchIntent_js_1.classifyPatchIntent)(input.task);
    const derivedFrom = input.reasonCodes ?? [];
    if (strategy === "blocked") {
        return {
            allowed: false,
            strategy,
            intent,
            operations: [],
            metadata: {
                reason: "Patch generation blocked by decision mode.",
                derivedFrom,
                confidenceScore: input.decision.confidenceScore
            }
        };
    }
    if (intent === "unknown") {
        return {
            allowed: false,
            strategy,
            intent,
            operations: [],
            metadata: {
                reason: "Patch generation blocked because task intent is unknown.",
                derivedFrom,
                confidenceScore: input.decision.confidenceScore
            }
        };
    }
    if (!(0, isIntentAllowed_js_1.isIntentAllowed)(intent, strategy)) {
        return {
            allowed: false,
            strategy,
            intent,
            operations: [],
            metadata: {
                reason: `Patch intent is not allowed for strategy: ${strategy}.`,
                derivedFrom,
                confidenceScore: input.decision.confidenceScore
            }
        };
    }
    return {
        allowed: true,
        strategy,
        intent,
        operations: (0, buildPatchOperations_js_1.buildPatchOperations)(intent),
        metadata: {
            reason: "Patch plan generated successfully from deterministic intent classification.",
            derivedFrom,
            confidenceScore: input.decision.confidenceScore
        }
    };
}
//# sourceMappingURL=generatePatchPlan.js.map