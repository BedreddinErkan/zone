import fs from "node:fs";
import path from "node:path";
import { realUserHome, realZoneDir } from "../testHome.js";

/**
 * Fails the test that writes to the real ~/.zone, at the moment it writes.
 *
 * Without this, a writer that escapes the HOME redirect leaves disk artefacts
 * that get discovered months later — which is exactly how the usage log ended
 * up 79% vitest output.
 *
 * Two things to know about the mechanism:
 *
 *  1. The anchor is os.userInfo().homedir, which reads the passwd database and
 *     so still reports the real home after $HOME is redirected. os.homedir()
 *     would return the temp home and the guard would permit everything.
 *
 *  2. The wrappers are assigned, never installed with vi.spyOn. The suite runs
 *     with restoreMocks: true, which would un-patch a spy after the first test
 *     and leave the guard looking installed while doing nothing.
 *
 * Reach is limited by import style: assigning over fs.writeFileSync is seen by
 * `import fs from "node:fs"` and by `import { promises as fsp }`, but NOT by
 * `import { writeFileSync } from "node:fs"` — a named function import snapshots
 * the binding at evaluation and never sees the assignment. That is why every
 * ~/.zone writer imports the namespace, and why homeWriterImportStyle.test.ts
 * fails the suite when a new one does not.
 */

const REAL_ZONE = realZoneDir();

function isInRealZone(target: unknown): boolean {
  if (typeof target !== "string" && !Buffer.isBuffer(target) && !(target instanceof URL)) {
    return false;
  }
  let resolved: string;
  try {
    resolved = target instanceof URL
      ? path.resolve(target.pathname)
      : path.resolve(target.toString());
  } catch {
    return false;
  }
  return resolved === REAL_ZONE || resolved.startsWith(REAL_ZONE + path.sep);
}

function refuse(fnName: string, target: unknown): never {
  throw new Error(
    `[zone-home-guard] ${fnName} tried to write inside the real home: ` +
      `${String(target)}\n` +
      `Tests must never touch ${REAL_ZONE}. HOME is redirected suite-wide ` +
      `(vitest.config.ts test.env.HOME) — a write that reaches here means the ` +
      `module resolved its path at load time, or bypassed os.homedir().`
  );
}

type AnyFn = (...args: never[]) => unknown;

function wrap<T extends AnyFn>(original: T, fnName: string): T {
  return function guarded(this: unknown, ...args: unknown[]): unknown {
    if (isInRealZone(args[0])) refuse(fnName, args[0]);
    return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
  } as unknown as T;
}

// The promises API must reject rather than throw synchronously: a caller that
// holds the promise before awaiting it would otherwise see the error at a
// different point than the real fs would produce it.
function wrapAsync<T extends AnyFn>(original: T, fnName: string): T {
  return function guarded(this: unknown, ...args: unknown[]): unknown {
    if (isInRealZone(args[0])) {
      try {
        refuse(fnName, args[0]);
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
  } as unknown as T;
}

// Sync surface. Every ~/.zone writer's first argument is the path it targets.
const SYNC_WRITES = [
  "writeFileSync",
  "appendFileSync",
  "mkdirSync",
  "renameSync",
  "unlinkSync",
  "rmSync",
  "rmdirSync",
  "copyFileSync",
  "createWriteStream",
] as const;

for (const name of SYNC_WRITES) {
  const original = (fs as unknown as Record<string, AnyFn>)[name];
  if (typeof original === "function") {
    (fs as unknown as Record<string, AnyFn>)[name] = wrap(original, name);
  }
}

// Promises surface. snapshotStore imports this object by name, so mutating its
// properties is seen at its call sites.
const PROMISE_WRITES = [
  "writeFile",
  "appendFile",
  "mkdir",
  "rename",
  "unlink",
  "rm",
  "rmdir",
  "copyFile",
] as const;

for (const name of PROMISE_WRITES) {
  const original = (fs.promises as unknown as Record<string, AnyFn>)[name];
  if (typeof original === "function") {
    (fs.promises as unknown as Record<string, AnyFn>)[name] = wrapAsync(original, `promises.${name}`);
  }
}

// The redirect itself. If this ever stops being applied, every worker says so
// on the first test rather than the suite passing while writing to the real
// home — the failure mode this whole file exists to make impossible.
if (path.resolve(process.env["HOME"] ?? "") === path.resolve(realUserHome())) {
  throw new Error(
    "[zone-home-guard] HOME is not redirected — tests would write to the real " +
      `${REAL_ZONE}. Check test.env.HOME in vitest.config.ts.`
  );
}
