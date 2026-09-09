import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zoneTestHome } from "./src/test/testHome.js";

// Every ~/.zone writer resolves os.homedir() at call time, so redirecting HOME
// isolates all of them at once. This is set through test.env rather than a setup
// file because test.env lands in the worker before any user module is evaluated
// — earlier than a module-level `const` could capture the old value.
const TEST_HOME = zoneTestHome();

// Snapshot output lives outside the repo tree so the zone-repo-guard (homeGuard.ts)
// does not refuse vitest's mkdir on __snapshots__/. Per-test path mirrors vitest's
// default (sibling __snapshots__/<basename>.snap) under a temp-rooted mirror of
// the source tree, so parallel runs from different repo roots cannot collide.
const SNAPSHOT_ROOT = path.join(os.tmpdir(), `zone-vitest-snapshots-${process.pid}`);

export default defineConfig({
  plugins: [react()],
  test: {
    env: { ZONE_TRUST_ALL: "1", HOME: TEST_HOME, USERPROFILE: TEST_HOME },
    globalSetup: ["src/test/setup/globalHome.ts"],
    setupFiles: ["src/test/setup/homeGuard.ts"],
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    exclude: ["src/llm/taskClassifier.archetype.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    testTimeout: 15000,
    snapshotFormat: {
      // Keep snapshot content stable across test environments — no theme or
      // colour-specific formatting should leak into the stored output.
      escapeString: true,
      printBasicPrototype: false,
    },
    resolveSnapshotPath: (testPath: string) => {
      // Default: <test-dir>/__snapshots__/<test-basename>.snap.
      //
      // If a committed .snap file exists at vitest's default (in-repo) path,
      // use it — that is the authoritative snapshot the test compares against.
      // If not (first run / regeneration / missing fixture), route to a
      // per-PID temp mirror so vitest's write does not hit the zone-repo-guard
      // (homeGuard.ts refuses fs.mkdir inside the repo tree). After the run,
      // the runner copies the freshly-written temp snapshot back to the repo
      // to establish the new baseline.
      //
      // fs.existsSync is a read, not a write — the guard only intercepts the
      // SYNC_WRITES / PROMISE_WRITES lists in homeGuard.ts, none of which
      // include existsSync — so this branch is safe under the guard even
      // when it does run in a worker context.
      const repoRoot = path.resolve(__dirname);
      const rel = path.relative(repoRoot, testPath);
      const dir = path.dirname(rel);
      const base = path.basename(rel);
      const repoSnap = path.join(repoRoot, dir, "__snapshots__", `${base}.snap`);
      if (fs.existsSync(repoSnap)) return repoSnap;
      return path.join(SNAPSHOT_ROOT, dir, "__snapshots__", `${base}.snap`);
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "dist/**",
        "node_modules/**"
      ]
    }
  }
});