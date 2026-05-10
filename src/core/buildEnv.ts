/**
 * Sanitizes the parent process env for child build/test/verification subprocesses.
 *
 * Currently strips:
 *   - NODE_ENV: a Zone server running `npm run serve` may inherit NODE_ENV=development
 *     from various entry points; passing this to a Next.js build triggers a
 *     prerender failure that is unrelated to the user's code.
 *
 * Future candidates (not stripped today, see investigation open questions):
 *   - npm_lifecycle_*, npm_package_*, npm_config_local_prefix
 *   - PORT
 */
export function sanitizeVerificationEnv(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const { NODE_ENV: _drop, ...rest } = source;
  return rest;
}

/** Returns the env keys that were dropped vs the source. Useful for diagnostic logs. */
export function strippedEnvKeys(source: NodeJS.ProcessEnv = process.env): string[] {
  const dropped: string[] = [];
  if ("NODE_ENV" in source) dropped.push("NODE_ENV");
  return dropped;
}
