/**
 * A-1 regression: run_command_readonly must see staged edits via withStagingTempFlush.
 * B-2: chain-blocked commands emit an actionable "run separately" message.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-readonly-staging-"));
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("run_command_readonly: staging temp-flush (A-1 regression)", () => {
  it("command sees staged content, not stale disk content", async () => {
    const absPath = path.join(repoPath, "data.txt");
    const original = "original content\n";
    const staged = "staged content\n";
    fs.writeFileSync(absPath, original, "utf8");

    const stagingFiles = new Map<string, string>([[absPath, staged]]);

    const result = await executeTool(
      "run_command_readonly",
      { command: `cat ${absPath}` },
      repoPath,
      undefined,
      { stagingFiles }
    );

    // Command must have seen the staged version
    expect(result.output).toContain("staged content");
    expect(result.output).not.toContain("original content");
  });

  it("disk is restored to original after command (temp-flush reverted)", async () => {
    const absPath = path.join(repoPath, "data.txt");
    const original = "original content\n";
    const staged = "staged content\n";
    fs.writeFileSync(absPath, original, "utf8");

    const stagingFiles = new Map<string, string>([[absPath, staged]]);

    await executeTool(
      "run_command_readonly",
      { command: `cat ${absPath}` },
      repoPath,
      undefined,
      { stagingFiles }
    );

    // Disk must be back to original — temp-flush restored it
    expect(fs.readFileSync(absPath, "utf8")).toBe(original);
  });

  it("staging map still holds the edit after command (no permanent write)", async () => {
    const absPath = path.join(repoPath, "data.txt");
    fs.writeFileSync(absPath, "original content\n", "utf8");

    const stagingFiles = new Map<string, string>([[absPath, "staged content\n"]]);

    await executeTool(
      "run_command_readonly",
      { command: `cat ${absPath}` },
      repoPath,
      undefined,
      { stagingFiles }
    );

    // Staging map must still carry the edit — finalizeStaging is the only permanent write
    expect(stagingFiles.get(absPath)).toBe("staged content\n");
  });

  it("no staging map: command reads disk normally", async () => {
    const absPath = path.join(repoPath, "data.txt");
    fs.writeFileSync(absPath, "disk content\n", "utf8");

    const result = await executeTool(
      "run_command_readonly",
      { command: `cat ${absPath}` },
      repoPath
    );

    expect(result.output).toContain("disk content");
  });
});

describe("run_command_readonly: chain-block message (B-2)", () => {
  it("blocked && chain emits actionable 'run separately' message", async () => {
    const result = await executeTool(
      "run_command_readonly",
      { command: "git status -s && git diff --stat" },
      repoPath
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("separate");
    // Must NOT emit the old dead-end generic message
    expect(result.output).not.toContain("Use only whitelisted read-only commands");
  });

  it("blocked ; chain also emits actionable message", async () => {
    const result = await executeTool(
      "run_command_readonly",
      { command: "git status -s; git diff --stat" },
      repoPath
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("separate");
  });

  it("non-chain block (mutation) keeps generic message", async () => {
    const result = await executeTool(
      "run_command_readonly",
      { command: "rm -rf /tmp/zone-test-disposable" },
      repoPath
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Use only whitelisted read-only commands");
    expect(result.output).not.toContain("separate call");
  });

  it("non-whitelisted command keeps generic message", async () => {
    const result = await executeTool(
      "run_command_readonly",
      { command: "curl https://example.com" },
      repoPath
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Use only whitelisted read-only commands");
  });
});
