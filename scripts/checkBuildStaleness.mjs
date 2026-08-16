#!/usr/bin/env node
// Warns when dist/ predates a source change. Never fails, never rebuilds, never touches dist/ —
// a stale build is sometimes deliberate (see docs/deferred-work.md item 195 and its follow-ups),
// so this reports drift rather than gating on it.
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

/** relPath is relative to the walked source root (e.g. "llm/verification/classify.ts").
 *  Mirrors tsconfig.json's exclude list for the src/ tree exactly. */
export function isBuildRelevantSource(relPath) {
  if (!/\.(ts|tsx)$/.test(relPath)) return false;
  if (/\.test\.tsx?$/.test(relPath)) return false;
  if (/(^|\/)__tests__\//.test(relPath)) return false;
  if (relPath === "extension.ts") return false;
  return true;
}

/** Pure. buildTimeMs: number | null (null = no build found). sourceFiles already filtered by
 *  isBuildRelevantSource. Returns the one-line message to print, or null when there's nothing
 *  to report. */
export function describeBuildStaleness({ buildTimeMs, sourceFiles }) {
  if (buildTimeMs === null) {
    return "[build-staleness] no build found — run npm run build before using the zone binary.";
  }

  let count = 0;
  let newestPath = null;
  let newestMtime = -Infinity;
  for (const f of sourceFiles) {
    if (f.mtimeMs > buildTimeMs) {
      count++;
      if (f.mtimeMs > newestMtime) {
        newestMtime = f.mtimeMs;
        newestPath = f.relPath;
      }
    }
  }
  if (count === 0) return null;

  const plural = count === 1 ? "" : "s";
  return `[build-staleness] ${count} source file${plural} changed since dist/ was last built — newest: ${newestPath}. Run npm run build before using the zone binary.`;
}

function walkSourceFiles(srcRoot) {
  const out = [];
  function recurse(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        recurse(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relPath = path.relative(srcRoot, full).split(path.sep).join("/");
      if (!isBuildRelevantSource(relPath)) continue;
      out.push({ relPath, mtimeMs: statSync(full).mtimeMs });
    }
  }
  recurse(srcRoot);
  return out;
}

function main() {
  const srcDir = process.env.ZONE_BUILD_STALENESS_SRC_DIR
    ? path.resolve(process.env.ZONE_BUILD_STALENESS_SRC_DIR)
    : path.join(repoRoot, "src");

  let proxyPath;
  if (process.env.ZONE_BUILD_STALENESS_PROXY_PATH) {
    proxyPath = path.resolve(process.env.ZONE_BUILD_STALENESS_PROXY_PATH);
  } else {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const binRel = pkg.bin?.zone;
    if (!binRel) {
      process.exit(0);
      return;
    }
    proxyPath = path.join(repoRoot, binRel);
  }

  const buildTimeMs = existsSync(proxyPath) ? statSync(proxyPath).mtimeMs : null;
  const sourceFiles = existsSync(srcDir) ? walkSourceFiles(srcDir) : [];
  const message = describeBuildStaleness({ buildTimeMs, sourceFiles });
  if (message) console.log(message);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
