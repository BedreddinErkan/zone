"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.llmPatchPlanSchema = exports.patchPreviewItemSchema = exports.llmFeaturePlanSchema = exports.plannedFileChangeSchema = void 0;
const zod_1 = require("zod");
exports.plannedFileChangeSchema = zod_1.z.object({
    path: zod_1.z.string(),
    reason: zod_1.z.string(),
    action: zod_1.z.enum(["create", "modify", "inspect"])
});
exports.llmFeaturePlanSchema = zod_1.z.object({
    implementationSummary: zod_1.z.string(),
    steps: zod_1.z.array(zod_1.z.string()),
    suggestedFiles: zod_1.z.array(exports.plannedFileChangeSchema),
    risks: zod_1.z.array(zod_1.z.string())
});
exports.patchPreviewItemSchema = zod_1.z.object({
    path: zod_1.z.string(),
    operation: zod_1.z.enum(["create", "modify"]),
    summary: zod_1.z.string(),
    targetHint: zod_1.z.string(),
    contentPreview: zod_1.z.string()
});
exports.llmPatchPlanSchema = zod_1.z.object({
    summary: zod_1.z.string(),
    patches: zod_1.z.array(exports.patchPreviewItemSchema),
    warnings: zod_1.z.array(zod_1.z.string()).optional().default([])
});
//# sourceMappingURL=schemas.js.map