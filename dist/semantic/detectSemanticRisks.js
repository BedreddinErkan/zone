"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectSemanticRisks = detectSemanticRisks;
const semanticRiskRules_js_1 = require("./semanticRiskRules.js");
function detectSemanticRisks(input) {
    return semanticRiskRules_js_1.semanticRiskRules.flatMap((rule) => rule(input));
}
//# sourceMappingURL=detectSemanticRisks.js.map