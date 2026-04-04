"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyPatchIntent = classifyPatchIntent;
function normalizeTask(task) {
    return task.trim().toLowerCase();
}
function includesAny(text, keywords) {
    return keywords.some((keyword) => text.includes(keyword));
}
function classifyPatchIntent(task) {
    const normalizedTask = normalizeTask(task);
    if (!normalizedTask) {
        return "unknown";
    }
    if (includesAny(normalizedTask, [
        "update import",
        "fix import",
        "change import",
        "import path",
        "adjust import"
    ])) {
        // If it's a test file context, let LLM handle it
        const isTestContext = includesAny(normalizedTask, [
            "spec", "test", "cypress", "playwright", "selenium",
            "cucumber", "jest", "pytest", "feature", "step"
        ]);
        if (isTestContext)
            return "unknown";
        return "update_import";
    }
    if (includesAny(normalizedTask, [
        "rename function",
        "rename variable",
        "rename helper",
        "rename method",
        "rename class",
        "change name",
        "rename "
    ])) {
        return "rename_symbol";
    }
    if (includesAny(normalizedTask, [
        "add comment",
        "insert comment",
        "append comment",
        "document with comment",
        "add explanation comment"
    ])) {
        return "add_comment";
    }
    if (includesAny(normalizedTask, [
        "safe replace",
        "replace exact text",
        "replace string",
        "update text",
        "replace "
    ])) {
        return "safe_replace";
    }
    return "unknown";
}
//# sourceMappingURL=classifyPatchIntent.js.map