import fs from "node:fs";
import path from "node:path";
import { zoneTestHome, realZoneDir } from "../testHome.js";

/**
 * Global setup: create the stand-in home before any worker starts, and prove at
 * teardown that the real ~/.zone was not touched.
 *
 * `test.env.HOME` in vitest.config.ts is what actually redirects the workers.
 * Assigning `process.env.HOME` here as well means forked workers inherit the
 * redirect from the parent environment even if `test.env` were ever dropped —
 * two independent routes to the same directory, each verified sufficient alone,
 * because a silent revert to the real home is the failure this exists to
 * prevent.
 *
 * The inventory below is the backstop to homeGuard.ts. That guard wraps named
 * fs APIs in modules it can reach; this catches everything else — a child
 * process, a native addon, an API nobody thought to wrap.
 */

type Inventory = Map<string, string>;

let baseline: Inventory | null = null;

function inventory(dir: string, into: Inventory = new Map()): Inventory {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return into; // absent or unreadable — nothing to protect
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      inventory(full, into);
    } else {
      try {
        const st = fs.statSync(full);
        into.set(full, `${st.size}:${st.mtimeMs}`);
      } catch {
        // raced away between readdir and stat; the diff below reports it
      }
    }
  }
  return into;
}

function diff(before: Inventory, after: Inventory): string[] {
  const changes: string[] = [];
  for (const [file, sig] of after) {
    const prior = before.get(file);
    if (prior === undefined) changes.push(`created  ${file}`);
    else if (prior !== sig) changes.push(`modified ${file}`);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changes.push(`deleted  ${file}`);
  }
  return changes;
}

export function setup(): void {
  const home = zoneTestHome();
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  baseline = inventory(realZoneDir());
}

export function teardown(): void {
  fs.rmSync(zoneTestHome(), { recursive: true, force: true });

  if (!baseline) return;
  const changes = diff(baseline, inventory(realZoneDir()));
  if (changes.length === 0) return;

  throw new Error(
    `[zone-home-guard] the test run changed ${changes.length} file(s) inside ` +
      `${realZoneDir()}:\n  ${changes.slice(0, 20).join("\n  ")}\n` +
      (changes.length > 20 ? `  … and ${changes.length - 20} more\n` : "") +
      `Tests must write only to the redirected home. ` +
      `(If you used the Zone CLI while the suite was running, this is a false ` +
      `positive — re-run without touching ~/.zone.)`
  );
}
