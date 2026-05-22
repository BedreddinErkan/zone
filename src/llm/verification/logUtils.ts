/** Returns true if the tool call log shows at least one successful apply_patch or write_file. */
export function didApplyPatch(
  log: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>
): boolean {
  return log.some(
    (e) =>
      (e.tool === "apply_patch" || e.tool === "write_file") &&
      !String(e.result || "").toLowerCase().includes("error") &&
      !String(e.result || "").toLowerCase().includes("not found") &&
      !String(e.result || "").toLowerCase().includes("fail")
  );
}
