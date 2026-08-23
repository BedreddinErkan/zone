import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

/**
 * Durable, unconditional record of every tool call a run makes.
 *
 * Deliberately NOT the marker sink. `markers.jsonl` is fed exclusively from the
 * monkey-patched `process.stdout.write` (see `cli/tui/stdoutShield.ts`), so a
 * marker exists there only if something printed it — which is exactly the
 * dependency this file exists to break. Two further reasons keep the streams
 * apart rather than merging them:
 *
 *   1. Volume. A run emits one record here per tool call. The marker sink's
 *      closest per-call proxy averages ~9 records/run and peaks at 52, and this
 *      stream covers rejected-before-execution calls the proxy never sees. The
 *      marker sink's rotation trigger is SIZE, so a high-volume stream sharing
 *      it would shorten the retained window for every low-volume marker in it.
 *   2. Retention independence. Losing debug-marker history to eviction is
 *      cheap; losing the record of what a run touched is the thing this file
 *      exists to prevent.
 *
 * `homedir()` is resolved per call, never captured at module load — a
 * module-level const ignores the test-home redirect (see CLAUDE.md's two rules
 * for `~/.zone` writers), and `fs` is imported as a namespace for the same
 * reason: a named `{ appendFileSync }` import snapshots the binding and makes
 * the repo's home-write guard silently inert.
 */

/** The record's `name`. Exported so tests assert through one source rather than a second literal. */
export const TOOL_CALL_RECORD_NAME = "[zone-tool-call-record]";

/**
 * 8 MiB, not the marker sink's 2 MiB. Measured, not guessed: a record of this
 * shape is 260-273 bytes, and the observed run rate is ~5.3 runs/day. At 2 MiB
 * a 100-record-per-run workload retains ~14.7 days of live file; at 8 MiB it
 * retains ~59. The larger cap is chosen for headroom against the one figure
 * here that is projected rather than measured — records per run — not because
 * 2 MiB was measured to be worse than the marker sink's window.
 */
export const TOOL_CALL_SINK_MAX_BYTES = 8 * 1024 * 1024;

export interface ToolCallRecordPayload {
  runId: string | null;
  sessionId: string | null;
  seq: number;
  iteration: number;
  ts: string;
  tool: string;
  paths: string[];
  command: string | null;
  outcome: "ok" | "rejected" | "error";
  reason: string | null;
  /**
   * Writes that failed since the last record that succeeded. Normally 0.
   * Partial-failure signal only: if EVERY write fails there is no record to
   * carry it, which is why the run-level `toolCallsAttempted` counter travels
   * the cost-log writer instead. See `toolCallRecord.ts`.
   */
  droppedSinceLast: number;
}

let _override: string | null = null;
/** Test-only path override. Always reset with `_setToolCallSinkPathForTest(null)`. */
export function _setToolCallSinkPathForTest(p: string | null): void {
  _override = p;
}

function sinkPath(): string {
  return _override ?? path.join(homedir(), ".zone", "tool-calls.jsonl");
}

/**
 * Append one record. Returns whether it was durably written — the caller counts
 * failures, because a sink that reported its own health through itself would
 * share the failing step and be one instrument, not two.
 *
 * Never throws: this is a diagnostic side-channel and must be strictly less
 * reliable than the run it observes.
 */
export function appendToolCallRecord(payload: ToolCallRecordPayload): boolean {
  try {
    const record = { name: "[zone-tool-call-record]", ...payload };
    const filePath = sinkPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");

    let sizeAfterAppend: number;
    try {
      sizeAfterAppend = fs.statSync(filePath).size;
    } catch {
      return true; // the record above is durably appended either way.
    }
    if (sizeAfterAppend > TOOL_CALL_SINK_MAX_BYTES) trimSink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append-only rotation, one generation kept — `.1` is overwritten, matching the
 * marker sink. `rename` is atomic within a filesystem and `appendFileSync`
 * opens by path on every call, so there is no cached descriptor to strand on
 * the old inode.
 */
function trimSink(filePath: string): void {
  try {
    fs.renameSync(filePath, filePath + ".1");
  } catch {
    // Left over cap; the next append retries. Nothing written is lost.
  }
}
