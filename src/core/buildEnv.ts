/**
 * Sanitizes the parent process env for child build/test/verification subprocesses.
 *
 * Strips:
 *   - NODE_ENV: a Zone server running `npm run serve` may inherit NODE_ENV=development
 *     from various entry points; passing this to a Next.js build triggers a
 *     prerender failure that is unrelated to the user's code.
 *   - *_API_KEY, *_TOKEN, *_SECRET: BYOK keys and auth tokens must not leak into
 *     subprocesses where user test code could accidentally log process.env.
 *   - GH_TOKEN / GITHUB_TOKEN: common CI tokens worth stripping explicitly.
 */

const STRIP_NAMES = new Set(["NODE_ENV"]);
const STRIP_PATTERNS = [/_API_KEY$/i, /_TOKEN$/i, /_SECRET$/i, /^GH_TOKEN$/i, /^GITHUB_TOKEN$/i];

export function sanitizeVerificationEnv(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (STRIP_NAMES.has(k)) continue;
    if (STRIP_PATTERNS.some(p => p.test(k))) continue;
    out[k] = v;
  }
  return out;
}

/** Returns the env keys that were dropped vs the source. Useful for diagnostic logs. */
export function strippedEnvKeys(source: NodeJS.ProcessEnv = process.env): string[] {
  const dropped: string[] = [];
  for (const k of Object.keys(source)) {
    if (STRIP_NAMES.has(k) || STRIP_PATTERNS.some(p => p.test(k))) dropped.push(k);
  }
  return dropped;
}
