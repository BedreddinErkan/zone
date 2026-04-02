import { describe, expect, it } from "vitest";
import { buildPatchOperations } from "./buildPatchOperations.js";

describe("buildPatchOperations", () => {
  it("builds a rename operation for rename_symbol intent", () => {
    expect(buildPatchOperations("rename_symbol")).toEqual([
      {
        type: "rename",
        scope: "single_file"
      }
    ]);
  });

  it("builds an update_import operation for update_import intent", () => {
    expect(buildPatchOperations("update_import")).toEqual([
      {
        type: "update_import",
        scope: "single_file"
      }
    ]);
  });

  it("builds an insert_comment operation for add_comment intent", () => {
    expect(buildPatchOperations("add_comment")).toEqual([
      {
        type: "insert_comment",
        scope: "single_file",
        position: "line_above_target"
      }
    ]);
  });

  it("builds a replace_text operation for safe_replace intent", () => {
    expect(buildPatchOperations("safe_replace")).toEqual([
      {
        type: "replace_text",
        scope: "single_file",
        matchMode: "exact"
      }
    ]);
  });

  it("returns an empty array for unknown intent", () => {
    expect(buildPatchOperations("unknown")).toEqual([]);
  });

  it("returns deterministic results for repeated calls", () => {
    const first = buildPatchOperations("rename_symbol");
    const second = buildPatchOperations("rename_symbol");

    expect(first).toEqual(second);
  });
});