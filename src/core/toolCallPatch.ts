/**
 * Builds a FIND/REPLACE patch string suitable for DiffView rendering in the TUI.
 * Covers apply_patch (uses the actual patch), write_file for new files (all-additions),
 * and multi_edit (single find→replace block).
 */

/** Number of lines shown in the DiffView preview for a new-file write. */
export const WRITE_FILE_PREVIEW_LINES = 7;

/** Lines included in the patch payload — enough for DiffView to show accurate "… N more lines". */
export const WRITE_FILE_PATCH_CAP = 30;

export function buildToolCallPatch(
  name: string,
  args: Record<string, unknown>,
  beforeContent: string | undefined,
): string | undefined {
  // apply_patch: use the actual patch string as-is
  if (name === "apply_patch") {
    return typeof args.patch === "string" ? args.patch : undefined;
  }

  // write_file new file: show content as all-additions (empty FIND → full REPLACE)
  // Only for new files (beforeContent is empty string); skip existing-file overwrites.
  if (
    name === "write_file" &&
    beforeContent === "" &&
    typeof args.content === "string"
  ) {
    const lines = String(args.content).replace(/\r\n/g, "\n").split("\n");
    const capped = lines.slice(0, WRITE_FILE_PATCH_CAP).join("\n");
    return `--- FIND ---\n\n--- REPLACE ---\n${capped}`;
  }

  // multi_edit: show the single find→replace transformation (applied across all files)
  if (
    name === "multi_edit" &&
    typeof args.find === "string" &&
    typeof args.replace === "string"
  ) {
    return `--- FIND ---\n${String(args.find)}\n--- REPLACE ---\n${String(args.replace)}`;
  }

  return undefined;
}
