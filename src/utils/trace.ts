export function generateTraceId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);

  const rand = Math.random().toString(36).slice(2, 8);

  return `trace_${ts}_${rand}`;
}