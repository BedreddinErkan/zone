export type GeneratedPatchIntent =
  | "safe_replace"
  | "rename_symbol"
  | "update_import"
  | "add_comment";

export type GeneratedPatchOperation =
  | {
      type: "safe_replace";
      filePath: string;
      find: string;
      replaceWith: string;
      matchMode: "exact";
    }
  | {
      type: "rename_symbol";
      filePath: string;
      from: string;
      to: string;
    }
  | {
      type: "update_import";
      filePath: string;
      from: string;
      to: string;
    }
  | {
      type: "add_comment";
      filePath: string;
      comment: string;
      target: string;
    };

export type GeneratedPatchPlan = {
  version: 1;
  intent: GeneratedPatchIntent;
  operations: GeneratedPatchOperation[];
  summary: string;
  warnings: string[];
};