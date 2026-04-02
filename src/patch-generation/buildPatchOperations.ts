import type { PatchIntent } from "./classifyPatchIntent.js";

export type PatchOperation =
  | {
      type: "rename";
      scope: "single_file";
    }
  | {
      type: "update_import";
      scope: "single_file";
    }
  | {
      type: "insert_comment";
      scope: "single_file";
      position: "line_above_target";
    }
  | {
      type: "replace_text";
      scope: "single_file";
      matchMode: "exact";
    };

export function buildPatchOperations(intent: PatchIntent): PatchOperation[] {
  switch (intent) {
    case "rename_symbol":
      return [
        {
          type: "rename",
          scope: "single_file"
        }
      ];

    case "update_import":
      return [
        {
          type: "update_import",
          scope: "single_file"
        }
      ];

    case "add_comment":
      return [
        {
          type: "insert_comment",
          scope: "single_file",
          position: "line_above_target"
        }
      ];

    case "safe_replace":
      return [
        {
          type: "replace_text",
          scope: "single_file",
          matchMode: "exact"
        }
      ];

    case "unknown":
    default:
      return [];
  }
}