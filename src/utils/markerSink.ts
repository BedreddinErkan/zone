import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { getRequestContext } from "../llm/openaiContext.js";

/**
 * Any `[tag]` at line start is structured telemetry from the agent runtime.
 *
 * Owned here rather than in `stdoutShield.ts` because a `utils/` module must
 * not depend on a TUI-specific one, and this sink needs the exact classifier
 * the shield uses so the two can never silently disagree about what counts
 * as a marker line.
 *
 * NEVER add the `g` flag. This object is shared across every call site (both
 * shield functions, plus this module's own re-check) — a global regex
 * carries `lastIndex` state between `.test()` calls, which would make
 * alternating invocations fail intermittently in a way that's hard to trace
 * back to the flag.
 */
export const TELEMETRY_RE = /^\[[a-z_][a-z0-9_-]*\]\s/;

let _override: string | null = null;
/** Test-only path override. Always reset with `_setMarkerSinkPathForTest(null)`. */
export function _setMarkerSinkPathForTest(p: string | null): void {
  _override = p;
}
function markerSinkPath(): string {
  return _override ?? path.join(homedir(), ".zone", "markers.jsonl");
}

/** The stated bound IS the enforced bound: this is the only threshold checked. */
export const MARKER_SINK_MAX_BYTES = 512 * 1024;
/**
 * A trim packs the file down to here, not up to MAX_BYTES — guaranteeing
 * ~256KB of headroom (hence appends) between trims regardless of line size.
 * Packing all the way to MAX_BYTES would mean the very next append crosses
 * it again, so every subsequent write pays a full read+rewrite.
 */
export const MARKER_SINK_TRIM_TARGET_BYTES = MARKER_SINK_MAX_BYTES / 2;

function extractRunIdFromPayload(payload: unknown): string | undefined {
  if (
    payload &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>).runId === "string"
  ) {
    return (payload as Record<string, unknown>).runId as string;
  }
  return undefined;
}

/**
 * Append one marker record to the sink. Called from inside the monkey-patched
 * `process.stdout.write`/`process.stderr.write` (see `stdoutShield.ts`), so
 * this function and everything it calls must never write to either stream —
 * doing so would re-enter the patch and recurse without bound. No `log()`,
 * `debugLog()`, `errorLog()`, `console.*`, or `process.std*.write`, anywhere
 * in this module or its imports (checked: `node:fs`, `node:path`, `node:os`,
 * and `getRequestContext` from `llm/openaiContext.ts`, whose own closure is
 * `node:async_hooks` plus a type-only import — nothing that logs).
 *
 * Never throws, for the same reason: this is a diagnostic side-channel and
 * must be strictly less reliable than the run it observes.
 */
export function appendMarkerRecord(rawLine: string): void {
  try {
    const trimmed = rawLine.trimStart();
    if (!TELEMETRY_RE.test(trimmed)) return; // not a marker — nothing to record

    // Extraction, not re-classification: TELEMETRY_RE already guarantees a
    // `[`, a valid tag, and a `]` exist, so no second regex is needed (and no
    // second regex risks silently disagreeing with the first). The `: trimmed`
    // fallback is defensive only — closeIdx > 0 is guaranteed by the test above.
    const closeIdx = trimmed.indexOf("]");
    const name = closeIdx > 0 ? trimmed.slice(0, closeIdx + 1) : trimmed;
    const restRaw = closeIdx > 0 ? trimmed.slice(closeIdx + 1).trim() : "";
    let payload: unknown = restRaw;
    if (restRaw) {
      try {
        payload = JSON.parse(restRaw);
      } catch {
        // Not every marker emits JSON (e.g. plain-text trailers) — keep the
        // raw string rather than drop the record.
      }
    }

    const runId = getRequestContext()?.runId ?? extractRunIdFromPayload(payload);
    const record = {
      name,
      ts: new Date().toISOString(),
      ...(runId ? { runId } : {}),
      payload,
    };

    const filePath = markerSinkPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");

    if (fs.statSync(filePath).size > MARKER_SINK_MAX_BYTES) trimSink(filePath);
  } catch {
    // Never throws, never logs — see the module header.
  }
}

/**
 * Read-trim-rewrite. Not atomic across processes: appends are `O_APPEND` and
 * safe under concurrent `zone` processes, but this function is read-then-
 * write, so a concurrent process's append landing between this call's
 * `readFileSync` and `writeFileSync` is lost. Narrow window (only during a
 * trim, and trims are now rare thanks to the low-water mark), not fixed with
 * locking here — named as a known limitation, not silently accepted.
 */
function trimSink(filePath: string): void {
  try {
    const lines = fs
      .readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    if (lines.length === 0) return;

    // Always keep the newest line, whatever its size — a single oversized
    // record must not wipe every record before it just because it alone
    // cannot fit the target. Only lines older than it are budget-checked.
    let bytes = Buffer.byteLength(lines[lines.length - 1]!, "utf8") + 1;
    let keepFromBytes = lines.length - 1;
    for (let i = lines.length - 2; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(lines[i]!, "utf8") + 1;
      if (bytes + lineBytes > MARKER_SINK_TRIM_TARGET_BYTES) break;
      bytes += lineBytes;
      keepFromBytes = i;
    }
    if (keepFromBytes === 0) return; // nothing to drop

    fs.writeFileSync(filePath, lines.slice(keepFromBytes).join("\n") + "\n", "utf8");
  } catch {
    // Same rule.
  }
}
