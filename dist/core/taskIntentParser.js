"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTaskIntent = parseTaskIntent;
const UPDATE_WORDS = ["edit", "update", "modify", "change", "patch"];
const DELETE_WORDS = ["delete", "remove"];
const CREATE_WORDS = ["create", "add", "insert"];
const READ_WORDS = ["get", "fetch", "show", "read", "list"];
const COLLECTION_HINTS = ["all ", "list ", "many ", "multiple ", "bulk "];
const NESTED_ITEM_WORDS = [
    "item",
    "entry",
    "sub-item",
    "sub item",
    "nested",
    "timeline item",
    "timeline entry",
    "comment item",
    "line item",
    "note",
    "notes",
    "attachment",
    "attachments",
    "comment",
    "comments",
    "stage",
    "step"
];
const PARENT_RESOURCE_WORDS = [
    "record",
    "treatment",
    "patient",
    "appointment",
    "lead",
    "clinic",
    "analysis"
];
const KNOWN_PARENT_RESOURCES = [
    "treatment",
    "patient",
    "appointment",
    "lead",
    "clinic",
    "analysis"
];
const KNOWN_NESTED_MAP = [
    {
        match: /\btimeline\b/i,
        parent: "treatment",
        nested: "timeline",
        paramHints: ["treatmentId", "timelineId"],
        routeHints: ["/treatments/:treatmentId/timeline/:timelineId"]
    },
    {
        match: /\bnote(s)?\b/i,
        parent: "patient",
        nested: "notes",
        paramHints: ["patientId", "noteId"],
        routeHints: ["/patients/:patientId/notes/:noteId"]
    },
    {
        match: /\battachment(s)?\b/i,
        parent: "patient",
        nested: "attachments",
        paramHints: ["patientId", "attachmentId"],
        routeHints: ["/patients/:patientId/attachments/:attachmentId"]
    },
    {
        match: /\bcomment(s)?\b/i,
        parent: "patient",
        nested: "comments",
        paramHints: ["patientId", "commentId"],
        routeHints: ["/patients/:patientId/comments/:commentId"]
    }
];
function normalizeTask(task) {
    return task.trim().toLowerCase().replace(/\s+/g, " ");
}
function includesAny(text, words) {
    return words.some((word) => text.includes(word));
}
function detectAction(task) {
    if (includesAny(task, DELETE_WORDS))
        return "delete";
    if (includesAny(task, UPDATE_WORDS))
        return "update";
    if (includesAny(task, CREATE_WORDS))
        return "create";
    if (includesAny(task, READ_WORDS))
        return "read";
    return "unknown";
}
function detectParentResource(task) {
    return KNOWN_PARENT_RESOURCES.find((resource) => task.includes(resource));
}
function detectScope(input) {
    if (includesAny(input.normalizedTask, COLLECTION_HINTS)) {
        return "collection";
    }
    if (input.mentionsNestedItem) {
        return "single_item";
    }
    if (input.action === "read" && input.normalizedTask.includes("by id")) {
        return "single_item";
    }
    if (input.action === "unknown") {
        return "unknown";
    }
    return "parent_record";
}
function parseTaskIntent(rawTask) {
    const normalizedTask = normalizeTask(rawTask);
    const warnings = [];
    const action = detectAction(normalizedTask);
    const matchedNestedConfig = KNOWN_NESTED_MAP.find((item) => item.match.test(normalizedTask));
    const mentionsNestedItem = !!matchedNestedConfig || includesAny(normalizedTask, NESTED_ITEM_WORDS);
    const detectedParentResource = matchedNestedConfig?.parent ?? detectParentResource(normalizedTask);
    const detectedNestedResource = matchedNestedConfig?.nested;
    const resourceKind = mentionsNestedItem
        ? "nested_resource"
        : detectedParentResource
            ? "parent_resource"
            : includesAny(normalizedTask, PARENT_RESOURCE_WORDS)
                ? "parent_resource"
                : "unknown";
    const scope = detectScope({
        normalizedTask,
        action,
        mentionsNestedItem
    });
    const destructiveRisk = action === "delete" &&
        (resourceKind === "nested_resource" || resourceKind === "parent_resource");
    if (action === "unknown") {
        warnings.push("Could not confidently determine CRUD action from task wording.");
    }
    if (!detectedParentResource && resourceKind !== "unknown") {
        warnings.push("Resource kind was inferred, but parent resource could not be confidently identified.");
    }
    if (action === "delete") {
        warnings.push("Delete action detected. Verify target scope carefully.");
    }
    if (resourceKind === "nested_resource") {
        warnings.push("Nested resource detected. Parent resource should not be directly replaced.");
    }
    if (action === "update" && resourceKind === "nested_resource") {
        warnings.push("Update should target the nested item only, not the whole parent record.");
    }
    if (scope === "collection" && action === "delete") {
        warnings.push("Collection-level delete detected. Confirm that bulk deletion is intended.");
    }
    function detectCodePatchIntent(task) {
        const t = task.toLowerCase();
        if (/\b(typo|spacing|padding|margin|gap|alignment|label|placeholder|wording)\b/.test(t))
            return "micro_edit";
        if (/\b(style|css|color|font|theme|ui tweak|visual)\b/.test(t))
            return "style_change";
        if (/\b(fix|bug|error|broken|crash|issue|not working)\b/.test(t))
            return "bug_fix";
        if (/\b(add|create|implement|build|new feature|new component)\b/.test(t))
            return "feature_add";
        if (/\b(refactor|clean up|reorganize|restructure|rename)\b/.test(t))
            return "refactor";
        if (/\b(test|spec|coverage|unit test|integration test)\b/.test(t))
            return "test_add";
        if (/\b(config|env|setting|environment|\.env)\b/.test(t))
            return "config_change";
        return "unknown";
    }
    return {
        rawTask,
        normalizedTask,
        action,
        resourceKind,
        scope,
        parentResource: detectedParentResource,
        nestedResource: detectedNestedResource,
        mentionsNestedItem,
        destructiveRisk,
        routeHints: matchedNestedConfig?.routeHints ?? [],
        paramHints: matchedNestedConfig?.paramHints ?? [],
        warnings,
        codeIntent: detectCodePatchIntent(rawTask),
    };
}
//# sourceMappingURL=taskIntentParser.js.map