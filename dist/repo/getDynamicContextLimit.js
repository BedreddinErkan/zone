"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDynamicContextLimit = getDynamicContextLimit;
function getDynamicContextLimit(task, framework) {
    const t = String(task || "");
    const hasMultipleFiles = /\b(and|also|both|all|every)\b/i.test(t);
    const isComplex = /\b(refactor|migrate|update all|restructure)\b/i.test(t);
    const isSimple = /\b(remove|delete|rename|add comment)\b/i.test(t);
    if (isSimple)
        return 3;
    if (isComplex || hasMultipleFiles)
        return 10;
    if (framework.subProjects?.length > 0)
        return 8;
    return 5;
}
//# sourceMappingURL=getDynamicContextLimit.js.map