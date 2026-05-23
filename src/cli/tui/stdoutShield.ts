// Any [some-prefix] at line start is structured telemetry from the agent
// runtime. TUI-bound content always arrives via onStructuredEvent — never raw
// stdout. Anything written directly to stdout starting with [tag] is by
// definition headless telemetry and safe to swallow (or route to stderr).
// The generic pattern auto-covers future telemetry channels without code changes.
const TELEMETRY_RE = /^\[[a-z_][a-z0-9_-]*\]\s/;

// dispatch.ts success/fail lines (✓ / ✗ / ⚠) written directly by
// runOneShotInner — these are headless-mode result formatting; in TUI mode the
// result state is shown via the StatusBar instead.
const RESULT_LINE_RE = /^\s*(\x1b\[[0-9;]*m)*[✓✗⚠]/;

export function applyStdoutInterception(): () => void {
  const original = process.stdout.write.bind(process.stdout);

  const intercepted = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    const s =
      typeof chunk === "string" ? chunk : (chunk as Buffer | null)?.toString?.() ?? "";
    if (TELEMETRY_RE.test(s.trimStart()) || RESULT_LINE_RE.test(s)) {
      // TEMP probe — Opus audit round 2, remove in TUI.5.4
      console.error("[probe-stdout-shield-filter]", JSON.stringify({
        reason: TELEMETRY_RE.test(s.trimStart()) ? "TELEMETRY" : "RESULT_LINE",
        preview: s.slice(0, 60),
      }));
      if (process.env.ZONE_TUI_DEBUG === "1") {
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
