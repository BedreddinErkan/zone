"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectDesignSystemSignals = detectDesignSystemSignals;
function detectDesignSystemSignals(input) {
    const inlineStyleCount = input.addedLines.filter((line) => line.includes("style={{")).length;
    const styleAttributeLines = input.addedLines.filter((line) => line.includes("style=")).length;
    const addedClassNameCount = input.addedLines.filter((line) => line.includes("className=")).length;
    return {
        inlineStyleCount,
        styleAttributeLines,
        addedClassNameCount,
        excessiveInlineStyles: inlineStyleCount >= 3 || styleAttributeLines >= 8,
        reusableClassPreferenceMissed: inlineStyleCount > 0 && addedClassNameCount === 0,
    };
}
//# sourceMappingURL=designSystemSignals.js.map