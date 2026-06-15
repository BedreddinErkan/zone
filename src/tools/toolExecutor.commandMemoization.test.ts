/**
 * Phase 2: command memoization integration tests.
 *
 * Tests use real shell commands (npm run build / npm test) via executeTool so
 * there is no need to mock util.promisify(exec). A minimal package.json +
 * empty node_modules/ is created per-test to satisfy validateRunEnvironment.
 * Execution count is verified via file-append side effects.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  executeTool,
  clearCommandCacheForTest,
  isMemoizableCommand,
  computeCommandFingerprint,
} from "./toolExecutor.js";
import { flushCommandCacheLogForTest, clearCommandCacheLogForTest } from "../utils/commandCacheLog.js";

let repoPath: string;

function setupNpmEnv(scripts: Record<string, string>): void {
  fs.writeFileSync(
    path.join(repoPath, "package.json"),
    JSON.stringify({ name: "test", version: "1.0.0", scripts }),
  );
  fs.mkdirSync(path.join(repoPath, "node_modules"), { recursive: true });
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-cmd-memo-"));
  clearCommandCacheForTest();
  clearCommandCacheLogForTest();
});

afterEach(async () => {
  await flushCommandCacheLogForTest();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("command memoization (Phase 2)", () => {
  it("T.1: same command + same staging → exec called once (cache hit on second call)", async () => {
    setupNpmEnv({ build: `printf "x" >> hits.log` });
    const cmd = "npm run build";

    await executeTool("run_command", { command: cmd }, repoPath, undefined, { runId: "r1" });
    await executeTool("run_command", { command: cmd }, repoPath, undefined, { runId: "r1" });

    const hits = fs.readFileSync(path.join(repoPath, "hits.log"), "utf8");
    expect(hits).toBe("x");
  });

  it("T.2: same command + modified staging → cache miss, exec called twice", async () => {
    setupNpmEnv({ build: `printf "x" >> hits.log` });
    const cmd = "npm run build";

    const staging1 = new Map([["src/a.ts", "const a = 1;"]]);
    const staging2 = new Map([["src/a.ts", "const a = 2;"]]);

    await executeTool("run_command", { command: cmd }, repoPath, undefined, { runId: "r2", stagingFiles: staging1 });
    await executeTool("run_command", { command: cmd }, repoPath, undefined, { runId: "r2", stagingFiles: staging2 });

    const hits = fs.readFileSync(path.join(repoPath, "hits.log"), "utf8");
    expect(hits).toBe("xx");
  });

  it("T.3: different memoizable commands → each is a separate miss", async () => {
    setupNpmEnv({ build: `printf "b" >> hits.log`, test: `printf "t" >> hits.log` });

    await executeTool("run_command", { command: "npm run build" }, repoPath, undefined, { runId: "r3" });
    await executeTool("run_command", { command: "npm test" }, repoPath, undefined, { runId: "r3" });

    const hits = fs.readFileSync(path.join(repoPath, "hits.log"), "utf8");
    expect(hits).toBe("bt");
  });

  it("T.4: non-whitelisted command bypasses cache, always executes", async () => {
    const hitsLog = path.join(repoPath, "hits.log");
    const cmd = `printf "x" >> ${hitsLog}`;

    await executeTool("run_command", { command: cmd }, repoPath, undefined, { runId: "r4" });
    await executeTool("run_command", { command: cmd }, repoPath, undefined, { runId: "r4" });

    const hits = fs.readFileSync(hitsLog, "utf8");
    expect(hits).toBe("xx");
  });

  it("T.5: fingerprint stable across Map insertion order", () => {
    const m1 = new Map([["a.ts", "x"], ["b.ts", "y"]]);
    const m2 = new Map([["b.ts", "y"], ["a.ts", "x"]]);
    expect(computeCommandFingerprint("npm test", m1)).toBe(
      computeCommandFingerprint("npm test", m2),
    );
  });

  it("T.6: cached result preserves exitCode=1 (Q.5 invariant)", async () => {
    setupNpmEnv({ test: "exit 1" });
    const cmd = "npm test";

    const result1 = await executeTool("run_command", { command: cmd }, repoPath, undefined, { runId: "r6" });
    const result2 = await executeTool("run_command", { command: cmd }, repoPath, undefined, { runId: "r6" });

    expect(result1.exitCode).toBe(1);
    expect(result2.exitCode).toBe(1);
    expect(result2.success).toBe(false);
  });

  it("T.7: isMemoizableCommand covers expected patterns", () => {
    expect(isMemoizableCommand("npm test")).toBe(true);
    expect(isMemoizableCommand("npm run test")).toBe(true);
    expect(isMemoizableCommand("npm run typecheck")).toBe(true);
    expect(isMemoizableCommand("npx vitest run src/foo.test.ts")).toBe(true);
    expect(isMemoizableCommand("tsc --noEmit")).toBe(true);
    expect(isMemoizableCommand("ls -la")).toBe(false);
    expect(isMemoizableCommand("git status")).toBe(false);
    expect(isMemoizableCommand("rm -rf dist")).toBe(false);
  });

  it("T.8: subagent worker shares parent run cache via parentRunId", async () => {
    setupNpmEnv({ build: `printf "x" >> hits.log` });
    const cmd = "npm run build";

    // Parent run: cache miss → exec runs
    await executeTool("run_command", { command: cmd }, repoPath, undefined, { runId: "parent-1" });

    // Worker subagent: effectiveRunId = parentRunId → cache hit, exec skipped
    await executeTool("run_command", { command: cmd }, repoPath, undefined, {
      runId: "worker-1",
      subagent: { id: "w1", type: "worker", parentRunId: "parent-1" },
    });

    const hits = fs.readFileSync(path.join(repoPath, "hits.log"), "utf8");
    expect(hits).toBe("x");
  });
});
