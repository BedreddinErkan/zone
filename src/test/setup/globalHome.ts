import fs from "node:fs";
import { zoneTestHome } from "../testHome.js";

/**
 * Global setup: create the stand-in home before any worker starts.
 *
 * `test.env.HOME` in vitest.config.ts is what actually redirects the workers.
 * Assigning `process.env.HOME` here as well means forked workers inherit the
 * redirect from the parent environment even if `test.env` were ever dropped —
 * two independent routes to the same directory, because a silent revert to the
 * real home is the failure this exists to prevent.
 */
export function setup(): void {
  const home = zoneTestHome();
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
}

export function teardown(): void {
  fs.rmSync(zoneTestHome(), { recursive: true, force: true });
}
