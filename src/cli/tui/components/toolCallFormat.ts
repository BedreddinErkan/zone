const TOOL_NAME_MAP: Record<string, string> = {
  read_file: "Read",
  run_command: "Bash",
  run_command_background: "Bash",
  run_command_readonly: "Bash",
  apply_patch: "Edit",
  write_file: "Write",
  list_files: "LS",
  search_in_files: "Grep",
  find_references: "Grep",
  Task: "Task",
  update_memory: "Memory",
  TodoWrite: "Todo",
  suggest_scope_change: "Scope",
  kill_background: "Kill",
  list_background: "Jobs",
  read_background_output: "Read",
};

const BORING_ON_SUCCESS = new Set([
  "read_file",
  "list_files",
  "update_memory",
  "TodoWrite",
  "suggest_scope_change",
  "kill_background",
  "list_background",
]);

type ToolResult = { ok: boolean; detail: string; blocked?: true };

export function getToolDisplayName(rawName: string): string {
  return TOOL_NAME_MAP[rawName] ?? rawName;
}

export function formatToolArgs(_toolName: string, args: string): string {
  const max = 60;
  return args.length > max ? args.slice(0, max - 1) + "…" : args;
}

export function getStatusGlyph(
  lastResult: ToolResult | null
): { icon: string; color?: "red" | "yellow" } {
  if (!lastResult) return { icon: "○" };
  if (lastResult.blocked) return { icon: "⚠", color: "yellow" };
  if (!lastResult.ok) return { icon: "✗", color: "red" };
  return { icon: "●" };
}

export function shouldShowPreview(toolName: string, lastResult: ToolResult | null): boolean {
  if (!lastResult) return false;
  if (lastResult.blocked || !lastResult.ok) return true;
  return !BORING_ON_SUCCESS.has(toolName);
}

export function formatMetadata(toolName: string, lastResult: ToolResult | null): string | null {
  if (!lastResult?.ok || lastResult.blocked) return null;
  const lines = lastResult.detail.split("\n").filter((l) => l.trim().length > 0);
  if (toolName === "read_file") {
    return `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  }
  if (toolName === "list_files") {
    return `${lines.length} file${lines.length === 1 ? "" : "s"}`;
  }
  return null;
}

const META_LINE_REGEX = /^\[exit_code=|^\[zone-/;

export function formatPreview(lastResult: ToolResult, maxWidth = 80): string | null {
  const lines = lastResult.detail
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .filter((l) => !META_LINE_REGEX.test(l.trim()));
  if (lines.length === 0) return null;
  const first = lines[0]!.trim();
  return first.length > maxWidth ? first.slice(0, maxWidth - 1) + "…" : first;
}
