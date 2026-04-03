import { describe, expect, it } from "vitest";
import { formatGeneratedPatchPlanPreview } from "./formatGeneratedPatchPlanPreview.js";

describe("formatGeneratedPatchPlanPreview", () => {
  it("returns a stable structured preview result", () => {
    const result = formatGeneratedPatchPlanPreview({
      version: 1,
      intent: "safe_replace",
      summary: "Replace text in one file.",
      warnings: [],
      operations: [
        {
          type: "safe_replace",
          filePath: "src/index.ts",
          find: "oldValue",
          replaceWith: "newValue",
          matchMode: "exact"
        }
      ]
    });

    expect(result).toEqual({
      stage: "generated_patch_preview",
      status: "info",
      summary: "Generated patch preview contains 1 operation.",
      details: "1. safe_replace -> src/index.ts",
      operationCount: 1
    });
  });

  it("returns an empty preview summary when no operations exist", () => {
    const result = formatGeneratedPatchPlanPreview({
      version: 1,
      intent: "safe_replace",
      summary: "No changes.",
      warnings: [],
      operations: []
    });

    expect(result).toEqual({
      stage: "generated_patch_preview",
      status: "info",
      summary: "Generated patch preview contains 0 operations.",
      details: "No operations were generated.",
      operationCount: 0
    });
  });
});