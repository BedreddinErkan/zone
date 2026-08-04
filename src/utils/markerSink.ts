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
export const MARKER_SINK_MAX_BYTES = 2 * 1024 * 1024;

let statFailureWarned = false;
let renameFailureWarned = false;

/** Test-only reset for the once-per-process failure warnings below. */
export function _resetMarkerSinkWarningsForTest(): void {
  statFailureWarned = false;
  renameFailureWarned = false;
}

/**
 * Writes one line directly to the real stderr, bypassing appendMarkerRecord/
 * log/console.* entirely. Deliberately must NOT start with `[tag]` or a
 * result glyph (✓/✗/⚠) — those are exactly what stdoutShield's
 * TELEMETRY_RE/RESULT_LINE_RE match on, and a match would swallow this line
 * and recurse straight back into appendMarkerRecord (confirmed empirically:
 * a `[`-less line passes through the patched stderr.write untouched and
 * calls appendMarkerRecord zero times).
 */
function warnRaw(message: string): void {
  try {
    process.stderr.write(message);
  } catch {
    // stderr itself is broken; nothing left to escalate to.
  }
}

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

    let sizeAfterAppend: number;
    try {
      sizeAfterAppend = fs.statSync(filePath).size;
    } catch (err) {
      // ENOENT can't happen in steady state (appendFileSync above just
      // created/touched this exact path with O_CREAT, synchronously, with no
      // other writer or deleter of this file anywhere in this codebase), but
      // if it ever does, there is genuinely no file to size — skip silently.
      // Any other code (EACCES, EIO, ...) means the cap can no longer be
      // enforced and that's worth knowing about, once, without recursing
      // back through the marker path itself (see warnRaw).
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && !statFailureWarned) {
        statFailureWarned = true;
        warnRaw(
          `zone marker-sink: statSync failed (${code ?? "unknown"}) — size cap not enforced until this clears\n`
        );
      }
      return; // the record above is already durably appended either way.
    }
    if (sizeAfterAppend > MARKER_SINK_MAX_BYTES) trimSink(filePath, sizeAfterAppend);
  } catch {
    // Never throws, never logs — see the module header.
  }
}

/**
 * Append-only rotation. Not read-modify-write: `rename` is atomic within a
 * filesystem, and `appendFileSync` opens by path fresh on every call — no
 * cached descriptor to strand on the old inode after a rename, confirmed
 * empirically, not assumed. A concurrent append landing during rotation
 * lands in either the pre-rotation file (now `.1`) or the fresh
 * post-rotation file; nothing is silently lost. Keeps exactly one rotated
 * generation — `.1` is overwritten, not accumulated — because nothing reads
 * this file programmatically (checked) and this repo's own ledger records
 * why keeping N generations wasn't built (docs/deferred-work.md item 10).
 */
function trimSink(filePath: string, priorSizeBytes: number): void {
  const rotatedPath = filePath + ".1";
  try {
    fs.renameSync(filePath, rotatedPath);
  } catch (err) {
    // Rotation didn't happen; the record appendMarkerRecord already wrote
    // above is unaffected either way — nothing to lose here, only nothing
    // gained. Left over cap, so the very next append will try again and
    // fail again identically until whatever's wrong clears; warn once so
    // that isn't silent.
    if (!renameFailureWarned) {
      renameFailureWarned = true;
      const code = (err as NodeJS.ErrnoException)?.code;
      warnRaw(
        `zone marker-sink: rotation failed (${code ?? "unknown"}) — sink will exceed its cap until this clears\n`
      );
    }
    return;
  }
  try {
    // Written directly, not through appendMarkerRecord/log/console.* — this
    // function is only ever called from inside the monkey-patched stdout/
    // stderr write (see the module header); routing through log() would
    // recurse back into that patch without bound.
    const record = {
      name: "[zone-marker-sink-rotated]",
      ts: new Date().toISOString(),
      payload: { priorSizeBytes, rotatedTo: rotatedPath },
    };
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Rotation itself already succeeded; losing just the marker record
    // isn't worth a second warning.
  }
}
