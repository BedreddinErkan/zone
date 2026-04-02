import { describe, expect, it, vi } from "vitest";
import { runGeneratedPatchPlanFlow } from "./runGeneratedPatchPlanFlow.js";
import type { GeneratedPatchPlan } from "../patch/generatedPlanConversion.js";

describe("generated patch plan CLI integration", () => {
  it("blocks safely when conversion fails", () => {
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
      preview: "preview output",
    });

    expect(result.ok).toBe(false);

    if (result.ok) {
      throw new Error("Expected blocked result.");
    }

    expect(result.code).toBe("PLACEHOLDER_FILE_PATH");
    expect(result.reason).toBe(
      'Generated patch operation contains placeholder filePath "unknown".'
    );
  });

  it("returns a patch plan on successful conversion", () => {
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
      preview: "preview output",
    });

    expect(result).toEqual({
      ok: true,
      preview: "preview output",
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