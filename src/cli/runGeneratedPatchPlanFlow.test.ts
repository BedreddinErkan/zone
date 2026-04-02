import { describe, expect, it } from "vitest";
import { runGeneratedPatchPlanFlow } from "./runGeneratedPatchPlanFlow.js";
import type { GeneratedPatchPlan } from "../patch/generatedPlanConversion.js";

describe("runGeneratedPatchPlanFlow", () => {
  it("returns blocked result when generated plan cannot be converted", () => {
    const generatedPlan: GeneratedPatchPlan = {
      intent: "replace_exact_text",
      operations: [
        {
          filePath: "unknown",
          find: "oldText",
          replaceWith: "newText",
          matchMode: "exact",
        },
      ],
    };

    const result = runGeneratedPatchPlanFlow({
      generatedPlan,
      preview: "preview text",
    });

    expect(result).toEqual({
      ok: false,
      preview: "preview text",
      code: "PLACEHOLDER_FILE_PATH",
      reason:
        'Generated patch operation contains placeholder filePath "unknown".',
    });
  });

  it("returns converted patch plan when generated plan is valid", () => {
    const generatedPlan: GeneratedPatchPlan = {
      intent: "replace_exact_text",
      operations: [
        {
          filePath: "src/example.ts",
          find: "oldText",
          replaceWith: "newText",
          matchMode: "exact",
        },
      ],
    };

    const result = runGeneratedPatchPlanFlow({
      generatedPlan,
      preview: "preview text",
    });

    expect(result).toEqual({
      ok: true,
      preview: "preview text",
      patchPlan: {
        operations: [
          {
            type: "replace",
            filePath: "src/example.ts",
            find: "oldText",
            replaceWith: "newText",
            matchMode: "exact",
          },
        ],
      },
    });
  });
});