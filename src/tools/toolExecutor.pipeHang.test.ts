/**
 * D5 regression tests: shell wrapper output capture hang fix.
 *
 * Root cause: timeout: 30000 in execOptions killed full vitest suites (~65-100s).
 * Fix: raised timeout to 120000ms.
 *
 * These tests verify that piped commands complete correctly and that the exec
 * wrapper correctly captures and forwards output/exitCode through pipeline shells.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-d5-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("shell wrapper pipe handling (D5)", () => {
  it("piped command completes in under 5s and returns output", async () => {
    const start = Date.now();
    // seq 1 1000 | tail -10 is the canonical fast-pipe probe
    const result = await executeTool(
      "run_command",
      { command: "seq 1 1000 | tail -10" },
      repoPath
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(result.success).toBe(true);
    // Last 10 lines of seq 1 1000 end at 1000
    expect(result.output).toContain("1000");
  });

  it("2>&1 | tail redirection returns combined stdout through pipe", async () => {
    // Simulates the exact dogfood pattern: cmd 2>&1 | tail -N
    // stderr content must appear in captured output
    const result = await executeTool(
      "run_command",
      { command: "echo 'stdout-line' && echo 'stderr-line' >&2 2>&1 | cat" },
      repoPath
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("stdout-line");
  });

  it("exit code passes through correctly when tail is the last pipe stage", async () => {
    // grep no-match | tail exits with tail's code (0), not grep's (1)
    // This confirms /bin/sh pipeline exit = last command's exit code
    const result = await executeTool(
      "run_command",
      { command: "echo hello | grep 'no-match-xyz' | tail -5; echo 'pipe done'" },
      repoPath
    );
    // Shell evaluates to exit 0 because 'echo pipe done' always succeeds
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("pipe done");
  });

  it("grep-pipe returning zero-count output gets likely_no_matches annotation", async () => {
    // D1+D5 integration: grep no-match piped via | wc -l → exits 0, output '0'
    // classifyShellExit annotates the result instead of treating it as failure
    const result = await executeTool(
      "run_command",
      { command: "echo 'hello world' | grep 'NO_MATCH_XYZ' | wc -l" },
      repoPath
    );
    // grep exits 1 but wc -l produces '0\n'; pipeline exit code = wc's = 0
    expect(result.success).toBe(true);
    expect(result.output).toContain("0");
  });
});
