import { log } from "../../utils/logger.js";

interface ToolCallLogEntryLike {
  id?: string;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  success?: boolean;
  filesStaged?: string[];
}

/**
 * A multi_edit ToolCallLogEntry with success:true and filesStaged absent is a
 * state handleToolResult.ts's threading should make unreachable. Marks the
 * anomaly instead of silently treating it as either outcome, and reports
 * "did not change anything" — the conservative direction for a nudge whose
 * purpose is not to be suppressed by uncertainty.
 */
export function multiEditChangedSomething(entry: ToolCallLogEntryLike): boolean {
  if (entry.filesStaged === undefined) {
    log("[zone-multi-edit-log-missing-staged]", JSON.stringify({
      id: entry.id,
      tool: entry.tool,
    }));
    return false;
  }
  return entry.filesStaged.length > 0;
}

/**
 * Returns true if the tool call log shows at least one apply_patch or
 * write_file that succeeded, or a multi_edit that succeeded and staged at
 * least one file.
 */
export function didApplyPatch(toolCallLog: ToolCallLogEntryLike[]): boolean {
  return toolCallLog.some((e) => {
    if (e.tool === "apply_patch" || e.tool === "write_file") return e.success === true;
    if (e.tool === "multi_edit") return e.success === true && multiEditChangedSomething(e);
    return false;
  });
}
