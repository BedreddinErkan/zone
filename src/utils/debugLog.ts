/**
 * Debug log gated behind ZONE_DEBUG=1 env var.
 *
 * Used for run lifecycle, agent iteration, abort signal traces — high-volume
 * diagnostics useful for debugging but noisy in production. Production runs
 * should run without ZONE_DEBUG to keep logs clean.
 *
 * Logs that should NOT use this gate (always emit):
 *   - billing audit logs ([zone-billing-debug])
 *   - perf monitoring ([zone-api-perf])
 *   - ranker diagnostics ([zone-rank-*])
 *   - state machine logs ([zone-staging-*])
 *   - error logs (always emit)
 */
export function debugLog(tag: string, payload: unknown): void {
  if (process.env.ZONE_DEBUG === "1") {
    console.log(tag, payload);
  }
}
