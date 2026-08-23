import path from "node:path";
import { resolveAgentPath } from "../tools/toolExecutor.js";
import { appendToolCallRecord } from "../utils/toolCallSink.js";
import type { ToolCallLogEntry } from "./toolEventHandler/types.js";

/**
 * The single seam through which a tool call becomes both an in-memory log entry
 * and a durable record.
 *
 * Why this seam and not the executor: `toolCallLog` is already the complete
 * enumeration of tool calls. Calls that execute reach it through
 * `handleToolResult`; calls REJECTED BEFORE EXECUTION (a patch on an unread
 * file, a revert of an unstaged path, a malformed tool payload) reach it
 * directly from the agent loop and never touch the executor at all. Coaching,
 * compaction and verdict classification all read this array, so a tool call
 * that skipped it would already be broken in three visible ways — which is what
 * makes the array trustworthy as the enumeration and this function the one
 * place a record can be attached to it.
 *
 * Nothing here reads the environment. The debug markers that used to be the
 * only trace of a tool call still print exactly as gated as before; this
 * function's write is unconditional and independent of them.
 */

/**
 * Per-run state, keyed by runId: the monotonic sequence counter plus the two
 * health counters. `attempted` is incremented BEFORE the write is tried, which
 * is the whole point: if every write fails there is no record left to carry a
 * drop count, so the count has to survive outside the sink.
 * `readToolCallHealth` drains an entry, so this map is bounded by the number of
 * concurrently-open runs rather than by process lifetime.
 *
 * `seq` lives here rather than being threaded through the call sites because a
 * counter passed by value goes stale the moment two sites hold it; keying it by
 * runId also makes `(runId, seq)` unique by construction.
 */
const runState = new Map<string, { seq: number; attempted: number; dropped: number }>();

/** Failed writes since the last one that succeeded. Carried on the next successful record. */
let droppedSinceLastSuccess = 0;

export interface ToolCallHealth {
  attempted: number;
  dropped: number;
}

/**
 * Read and clear one run's counters. Called once, at run close, by whoever
 * writes the run's cost summary — a DIFFERENT writer to a DIFFERENT file, which
 * is what makes an empty `tool-calls.jsonl` falsifiable: attempted > 0 with an
 * empty sink is a writer failure, attempted === 0 is a genuine zero.
 */
export function readToolCallHealth(runId: string | null | undefined): ToolCallHealth {
  const key = runId ?? "anon";
  const st = runState.get(key) ?? { seq: 0, attempted: 0, dropped: 0 };
  runState.delete(key);
  return { attempted: st.attempted, dropped: st.dropped };
}

/** Test-only: drop all accumulated counters. */
export function _resetToolCallHealthForTest(): void {
  runState.clear();
  droppedSinceLastSuccess = 0;
}

export interface ToolCallRecordMeta {
  runId: string | null | undefined;
  sessionId: string | null | undefined;
  iter: number;
  repoPath: string;
  /**
   * Warm-resume replay. Entries rehydrated from a prior run's conversation were
   * already recorded durably under that run's OWN runId when they happened; a
   * resumed run gets a fresh runId (`randomUUID()` per dispatch), so writing
   * them again here would attribute one run's calls to another. They go into
   * the in-memory array (the read-before-patch gate needs them) and nowhere
   * else. Stated limit: a resumed run's records cover post-resume calls only.
   */
  replayed?: boolean;
  /** `ToolResult.error` when the caller has one — distinguishes "error" from "rejected". */
  errorText?: string;
}

/**
 * Absolute, resolved paths this call targets. Empty for tools whose target is
 * not a path: the shell tools (their target is a command, carried separately),
 * and `search_in_files`, whose arguments are a pattern and a glob rather than a
 * path. Empty array rather than null or an omitted field — an explicit "no
 * paths" observation must stay distinguishable from a writer that failed to
 * populate the field.
 */
export function toolCallPaths(
  name: string,
  args: Record<string, unknown>,
  repoPath: string,
): string[] {
  // A repoPath is required to make a path absolute, and "absolute" is the whole
  // point of this field — a repo-relative path cannot express an access outside
  // the repo root. Without one, report no paths rather than fabricating an
  // absolute path against whatever the process CWD happens to be.
  if (typeof repoPath !== "string" || repoPath.trim() === "") return [];
  const abs = (raw: unknown): string[] => {
    if (typeof raw !== "string" || raw.trim() === "") return [];
    const rel = resolveAgentPath(raw, repoPath, name);
    if (!rel) return [];
    return [path.resolve(repoPath, rel)];
  };
  switch (name) {
    case "read_file":
    case "apply_patch":
    case "write_file":
      return abs(args.filePath);
    case "revert_patch":
      return abs(args.path);
    case "list_files":
      return abs(args.dirPath);
    case "find_references":
      return abs(args.sourceFile);
    case "multi_edit": {
      const files = Array.isArray(args.files) ? args.files : [];
      return files.flatMap((f) => abs(f));
    }
    default:
      return [];
  }
}

/** The verbatim command for shell tools, null otherwise. Never folded into `paths`. */
export function toolCallCommand(name: string, args: Record<string, unknown>): string | null {
  switch (name) {
    case "run_command":
    case "run_command_background":
    case "run_command_readonly":
      return typeof args.command === "string" ? args.command : null;
    default:
      return null;
  }
}

function deriveOutcome(
  entry: ToolCallLogEntry,
  errorText: string | undefined,
): { outcome: "ok" | "rejected" | "error"; reason: string | null } {
  if (entry.success !== false) return { outcome: "ok", reason: null };
  if (entry.rejectionReason) return { outcome: "rejected", reason: entry.rejectionReason };
  if (errorText) return { outcome: "error", reason: errorText };
  const firstLine = String(entry.result ?? "").split("\n", 1)[0] ?? "";
  return { outcome: "error", reason: firstLine.slice(0, 200) || "unspecified" };
}

/**
 * Push one tool call onto the in-memory log AND durably record it. The two are
 * one call so that a future tool cannot acquire the first without the second.
 */
export function recordToolCall(
  log: ToolCallLogEntry[],
  entry: ToolCallLogEntry,
  meta: ToolCallRecordMeta,
): void {
  log.push(entry);
  if (meta.replayed) return;

  const key = meta.runId ?? "anon";
  const st = runState.get(key) ?? { seq: 0, attempted: 0, dropped: 0 };
  st.attempted += 1;
  runState.set(key, st);

  // Everything past the in-memory push is wrapped: this is a diagnostic
  // side-channel and must be strictly LESS reliable than the run it observes.
  // The sink's own write is already fail-soft, but building the payload is not
  // — resolving a path against a malformed repoPath threw here once, which
  // turned an observability feature into a way to kill a tool call.
  let ok = false;
  try {
    const { outcome, reason } = deriveOutcome(entry, meta.errorText);
    ok = appendToolCallRecord({
      runId: meta.runId ?? null,
      sessionId: meta.sessionId ?? null,
      seq: st.seq++,
      iteration: meta.iter,
      ts: new Date().toISOString(),
      tool: entry.tool,
      paths: toolCallPaths(entry.tool, entry.args, meta.repoPath),
      command: toolCallCommand(entry.tool, entry.args),
      outcome,
      reason,
      droppedSinceLast: droppedSinceLastSuccess,
    });
  } catch {
    ok = false; // counted as a drop below, never raised into the run
  }

  if (ok) {
    droppedSinceLastSuccess = 0;
  } else {
    droppedSinceLastSuccess += 1;
    st.dropped += 1;
  }
}
