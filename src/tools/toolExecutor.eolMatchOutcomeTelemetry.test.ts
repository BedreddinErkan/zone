/**
 * Ledger item 21 — Site 1 (the CR-only `debugLog`) was retired in the same pass that reduced
 * Site 2 (`[zone-apply-patch-eol]`) to its match-outcome fields. `matchedAfterNormalize` and
 * `occurrencesAfterNormalize` are now the only place either is reported. debugLog's verbosity
 * gate is a module-level const evaluated once at import, so setting ZONE_VERBOSE_LOGS inside a
 * test wouldn't retroactively enable it — mocking the module (as the rest of this suite already
 * does, e.g. agentLoop.cacheUsage.test.ts) is the non-contorted way to observe it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDebugLog = vi.hoisted(() => vi.fn());
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, debugLog: mockDebugLog };
});

import { executeTool } from "./toolExecutor.js";

let repoPath: string;

function writeRepoFile(filePath: string, content: string): void {
  const abs = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

async function applyPatch(filePath: string, patch: string) {
  return executeTool(
    "apply_patch",
    { filePath, patch, intent: "modify", scope: null },
    repoPath,
    undefined,
    {}
  );
}

function findEolCall() {
  return mockDebugLog.mock.calls.find((c) => c[0] === "[zone-apply-patch-eol]");
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-eol-match-"));
  mockDebugLog.mockClear();
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("apply_patch reduced eol match-outcome telemetry (ledger item 21)", () => {
  it("fires with exactly the reduced field set and the correct match values", async () => {
    const filePath = "src/a.js";
    writeRepoFile(filePath, "const x = 1;\n");
    const patch = "--- FIND ---\nconst x = 1;\n--- REPLACE ---\nconst x = 2;";

    await applyPatch(filePath, patch);

    const call = findEolCall();
    expect(call).toBeDefined();
    const payload = JSON.parse(call![1] as string) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(
      [
        "block",
        "filePath",
        "matchedAfterNormalize",
        "occurrencesAfterNormalize",
        "originalEol",
        "scopeActive",
      ].sort()
    );
    expect(payload.block).toBe(1);
    expect(payload.matchedAfterNormalize).toBe(true);
    expect(payload.occurrencesAfterNormalize).toBe(1);
  });
});
