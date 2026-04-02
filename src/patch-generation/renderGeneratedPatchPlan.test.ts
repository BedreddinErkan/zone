import { describe, expect, it } from "vitest";
import { renderGeneratedPatchPlan } from "./renderGeneratedPatchPlan.js";
import type { GeneratedPatchPlan } from "./generatedPatchPlanTypes.js";

describe("renderGeneratedPatchPlan", () => {
  it("renders add_comment plan", () => {
    const plan: GeneratedPatchPlan = {
      version: 1,
      intent: "add_comment",
      summary: "Adds a comment in a deterministic location.",
      warnings: [],
      operations: [
        {
          type: "add_comment",
          filePath: "src/helpers.ts",
          comment: "TODO: revisit helper behavior",
          target: "function helper"
        }
      ]
    };

    const output = renderGeneratedPatchPlan(plan);

    expect(output).toContain("=== GENERATED PATCH PLAN ===");
    expect(output).toContain("Intent: add_comment");
    expect(output).toContain("Summary: Adds a comment in a deterministic location.");
    expect(output).toContain("Operations:");
    expect(output).toContain("type: add_comment");
    expect(output).toContain("filePath: src/helpers.ts");
    expect(output).toContain("comment: TODO: revisit helper behavior");
    expect(output).toContain("target: function helper");
  });

  it("renders safe_replace plan", () => {
    const plan: GeneratedPatchPlan = {
      version: 1,
      intent: "safe_replace",
      summary: "Performs a safe deterministic replacement.",
      warnings: [],
      operations: [
        {
          type: "safe_replace",
          filePath: "src/config.ts",
          find: "OLD_VALUE",
          replaceWith: "NEW_VALUE",
          matchMode: "exact"
        }
      ]
    };

    const output = renderGeneratedPatchPlan(plan);

    expect(output).toContain("Intent: safe_replace");
    expect(output).toContain("Summary: Performs a safe deterministic replacement.");
    expect(output).toContain("type: safe_replace");
    expect(output).toContain("filePath: src/config.ts");
    expect(output).toContain("find: OLD_VALUE");
    expect(output).toContain("replaceWith: NEW_VALUE");
    expect(output).toContain("matchMode: exact");
  });

  it("renders update_import plan", () => {
    const plan: GeneratedPatchPlan = {
      version: 1,
      intent: "update_import",
      summary: "Updates an import path in a deterministic way.",
      warnings: [],
      operations: [
        {
          type: "update_import",
          filePath: "src/index.ts",
          from: "./old/module",
          to: "./new/module"
        }
      ]
    };

    const output = renderGeneratedPatchPlan(plan);

    expect(output).toContain("Intent: update_import");
    expect(output).toContain("type: update_import");
    expect(output).toContain("filePath: src/index.ts");
    expect(output).toContain("from: ./old/module");
    expect(output).toContain("to: ./new/module");
  });

  it("renders rename_symbol plan", () => {
    const plan: GeneratedPatchPlan = {
      version: 1,
      intent: "rename_symbol",
      summary: "Renames a symbol intent in preview form.",
      warnings: [],
      operations: [
        {
          type: "rename_symbol",
          filePath: "src/userService.ts",
          from: "getUser",
          to: "fetchUser"
        }
      ]
    };

    const output = renderGeneratedPatchPlan(plan);

    expect(output).toContain("Intent: rename_symbol");
    expect(output).toContain("type: rename_symbol");
    expect(output).toContain("filePath: src/userService.ts");
    expect(output).toContain("from: getUser");
    expect(output).toContain("to: fetchUser");
  });

  it("renders warnings section when warnings exist", () => {
    const plan: GeneratedPatchPlan = {
      version: 1,
      intent: "rename_symbol",
      summary: "Renames a symbol intent in preview form.",
      warnings: [
        "Decision mode is 'preview_only', so generated operations are preview-oriented.",
        "Intent 'rename_symbol' is not convertible to a real PatchPlan in v1 unless explicitly supported."
      ],
      operations: [
        {
          type: "rename_symbol",
          filePath: "src/userService.ts",
          from: "getUser",
          to: "fetchUser"
        }
      ]
    };

    const output = renderGeneratedPatchPlan(plan);

    expect(output).toContain("Warnings:");
    expect(output).toContain(
      "Decision mode is 'preview_only', so generated operations are preview-oriented."
    );
    expect(output).toContain(
      "Intent 'rename_symbol' is not convertible to a real PatchPlan in v1 unless explicitly supported."
    );
  });

  it("renders empty operations as none", () => {
    const plan: GeneratedPatchPlan = {
      version: 1,
      intent: "add_comment",
      summary: "Adds a comment in a deterministic location.",
      warnings: [],
      operations: []
    };

    const output = renderGeneratedPatchPlan(plan);

    expect(output).toContain("Operations:");
    expect(output).toContain("(none)");
  });

  it("is deterministic for the same plan", () => {
    const plan: GeneratedPatchPlan = {
      version: 1,
      intent: "safe_replace",
      summary: "Performs a safe deterministic replacement.",
      warnings: ["Reason codes: SAFE_LOW_RISK"],
      operations: [
        {
          type: "safe_replace",
          filePath: "src/config.ts",
          find: "OLD_VALUE",
          replaceWith: "NEW_VALUE",
          matchMode: "exact"
        }
      ]
    };

    const first = renderGeneratedPatchPlan(plan);
    const second = renderGeneratedPatchPlan(plan);

    expect(first).toBe(second);
  });
});