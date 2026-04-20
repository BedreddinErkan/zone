import { z } from "zod";

export const plannedFileChangeSchema = z.object({
  path: z.string(),
  reason: z.string(),
  action: z.enum(["create", "modify", "inspect"])
});

export const llmFeaturePlanSchema = z.object({
  implementationSummary: z.string(),
  steps: z.array(z.string()),
  suggestedFiles: z.array(plannedFileChangeSchema),
  risks: z.array(z.string())
});

export const patchPreviewItemSchema = z.object({
  path: z.string(),
  operation: z.enum(["create", "modify"]),
  summary: z.string(),
  targetHint: z.string(),
  contentPreview: z.string()
});

export const llmPatchPlanSchema = z.object({
  summary: z.string(),
  patches: z.array(patchPreviewItemSchema),
  warnings: z.array(z.string()).optional().default([])
});

export type LlmFeaturePlanSchema = z.infer<typeof llmFeaturePlanSchema>;
export type LlmPatchPlanSchema = z.infer<typeof llmPatchPlanSchema>;
