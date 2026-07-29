import { TELEMETRY_RE, appendMarkerRecord } from "../../utils/markerSink.js";

// TUI-bound content always arrives via onStructuredEvent — never raw stdout.
// Anything written directly to stdout starting with [tag] is by definition
// headless telemetry and safe to swallow (or route to stderr). The generic
// pattern auto-covers future telemetry channels without code changes.
// (TELEMETRY_RE itself lives in markerSink.ts — see the comment there for why.)

// dispatch.ts success/fail lines (✓ / ✗ / ⚠) written directly by
// runOneShotInner — these are headless-mode result formatting; in TUI mode the
// result state is shown via the StatusBar instead.
const RESULT_LINE_RE = /^\s*(\x1b\[[0-9;]*m)*[✓✗⚠]/;

export function applyStdoutInterception(): () => void {
  const original = process.stdout.write.bind(process.stdout);

  const intercepted = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    const s =
      typeof chunk === "string" ? chunk : (chunk as Buffer | null)?.toString?.() ?? "";
    const isMarker = TELEMETRY_RE.test(s.trimStart());
    const isResultLine = RESULT_LINE_RE.test(s);
    if (isMarker || isResultLine) {
      if (isMarker) appendMarkerRecord(s);
      if (process.env.ZONE_TUI_DEBUG === "1" || process.env.ZONE_VERBOSE_LOGS === "1") {
        return (process.stderr.write as (...args: unknown[]) => boolean)(s, enc, cb);
      }
      if (typeof cb === "function") (cb as () => void)();
      return true;
    }
    return original(chunk as string, enc as BufferEncoding, cb as () => void);
  }) as typeof process.stdout.write;

  process.stdout.write = intercepted;
  return (): void => {
    process.stdout.write = original;
  };
}

export function applyStderrInterception(): () => void {
  const original = process.stderr.write.bind(process.stderr);

  const intercepted = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    const s =
      typeof chunk === "string" ? chunk : (chunk as Buffer | null)?.toString?.() ?? "";
    const isMarker = TELEMETRY_RE.test(s.trimStart());
    const isResultLine = RESULT_LINE_RE.test(s);
    if (isMarker || isResultLine) {
      if (isMarker) appendMarkerRecord(s);
      if (process.env.ZONE_TUI_DEBUG === "1" || process.env.ZONE_VERBOSE_LOGS === "1") {
        return original(chunk as string, enc as BufferEncoding, cb as () => void);
      }
      if (typeof cb === "function") (cb as () => void)();
      return true;
    }
    return original(chunk as string, enc as BufferEncoding, cb as () => void);
  }) as typeof process.stderr.write;

  process.stderr.write = intercepted;
  return (): void => {
    process.stderr.write = original;
  };
}
