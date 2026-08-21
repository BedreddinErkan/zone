/**
 * The identifying argument for a tool call — the string shown after the tool
 * name in a transcript title ("[tool] name: arg") and in each per-call detail
 * line under a batched read-only group. Empty return means genuinely nothing
 * to show (an unrecognized tool, or list_background's argument-less schema);
 * callers render no line at all for those rather than an empty one.
 */
export function toolCallIdentifyingArg(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "run_command":
    case "run_command_background":
    case "run_command_readonly":
      return String(args.command ?? "");
    case "read_file":
    case "apply_patch":
    case "write_file":
      return String(args.filePath ?? "");
    case "list_files": {
      // Empty/omitted dirPath is a legitimate "list repo root" idiom
      // (resolveAgentPath, toolExecutor.ts) — "." makes that idiom visible
      // instead of rendering nothing.
      const dirPath = String(args.dirPath || "");
      return dirPath || ".";
    }
    case "search_in_files":
      // The only tool marked strict:false (toolDefinitions.ts) — the API
      // never enforces its required pattern field, so the model can and does
      // omit it. That legitimately produces "" here; the render layer, not
      // this function, is what hides the resulting line.
      return String(args.pattern ?? "");
    case "find_references":
      return String(args.symbolName ?? args.sourceFile ?? "");
    case "Task":
      return String(args.description ?? "").slice(0, 50);
    case "suggest_scope_change":
      return String(args.reason ?? "").slice(0, 50);
    case "kill_background":
    case "read_background_output":
      return String(args.handle ?? "");
    case "multi_edit": {
      const files = (args.files as string[]) ?? [];
      const find = String(args.find ?? "").slice(0, 40);
      const fileList = files.slice(0, 2).join(", ") + (files.length > 2 ? ` +${files.length - 2}` : "");
      return `${files.length} files · find="${find}"${fileList ? ` · ${fileList}` : ""}`;
    }
    case "list_background":
      // No properties in this tool's schema — genuinely nothing to identify.
      // Explicit case so the emptiness reads as confirmed, not an oversight.
      return "";
    case "update_memory":
      return String(args.entry ?? "").slice(0, 50);
    case "fetch_url":
      return String(args.url ?? "");
    default:
      return "";
  }
}

/**
 * The transcript title for a tool call inside a verification-autofix sub-loop.
 *
 * Extracted rather than left inline at its two call sites, for two reasons. The sites sit ~6,900
 * lines deep inside `runLlmPatchFlow`, where an inline arrow cannot be exercised without running the
 * whole flow — so what it renders was untestable, and stayed wrong. And both sites previously
 * hand-rolled `args.filePath || args.command`, covering **two** of the seventeen cases
 * `toolCallIdentifyingArg` knows: a `list_files` call rendered as `[fix] list_files: ` with an empty
 * tail, and so did `search_in_files` and thirteen others. The `[fix] ` prefix is what distinguishes
 * these lines from the main loop's, which is why this wraps the shared helper instead of callers
 * concatenating the prefix themselves.
 */
export function fixLoopToolCallTitle(name: string, args: Record<string, unknown>): string {
  return `[fix] ${name}: ${toolCallIdentifyingArg(name, args)}`;
}
