export type PatchIntent =
  | "rename_symbol"
  | "update_import"
  | "add_comment"
  | "safe_replace"
  | "unknown";

function normalizeTask(task: string): string {
  return task.trim().toLowerCase();
}

function includesAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

export function classifyPatchIntent(task: string): PatchIntent {
  const normalizedTask = normalizeTask(task);

  if (!normalizedTask) {
    return "unknown";
  }

  if (
    includesAny(normalizedTask, [
      "update import",
      "fix import",
      "change import",
      "import path",
      "adjust import"
    ])
  ) {
    return "update_import";
  }

  if (
    includesAny(normalizedTask, [
      "rename function",
      "rename variable",
      "rename helper",
      "rename method",
      "rename class",
      "change name",
      "rename "
    ])
  ) {
    return "rename_symbol";
  }

  if (
    includesAny(normalizedTask, [
      "add comment",
      "insert comment",
      "append comment",
      "document with comment",
      "add explanation comment"
    ])
  ) {
    return "add_comment";
  }

  if (
    includesAny(normalizedTask, [
      "safe replace",
      "replace exact text",
      "replace string",
      "update text",
      "replace "
    ])
  ) {
    return "safe_replace";
  }

  return "unknown";
}