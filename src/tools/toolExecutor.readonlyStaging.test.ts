/**
 * A-1 regression: run_command_readonly must see staged edits via withStagingTempFlush.
 * B-2: chain-blocked commands emit an actionable "run separately" message.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool, CATCH_ALL_TEXT, WHITELIST_MISS_SAMPLE } from "./toolExecutor.js";
import { checkCommandSafe, WHITELIST_PREFIXES, type CatchAllClass } from "../llm/runCommandSafe.js";

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
  // Item 93 fix: branch identity is asserted on the structured `tag` checkCommandSafe
  // returns, not inferred from prose presence/absence. Content is asserted separately.
  it("blocked && chain reports tag 'chain' and emits actionable 'run separately' message", async () => {
    const cmd = "git status -s && git diff --stat";
    expect(checkCommandSafe(cmd).tag).toBe("chain");
    const result = await executeTool("run_command_readonly", { command: cmd }, repoPath);
    expect(result.success).toBe(false);
    expect(result.output).toContain("separate");
  });

  it("blocked ; chain also reports tag 'chain' and emits actionable message", async () => {
    const cmd = "git status -s; git diff --stat";
    expect(checkCommandSafe(cmd).tag).toBe("chain");
    const result = await executeTool("run_command_readonly", { command: cmd }, repoPath);
    expect(result.success).toBe(false);
    expect(result.output).toContain("separate");
  });

  it("non-chain block (mutation) reports tag 'file-mutation', not chain", async () => {
    const cmd = "rm -rf /tmp/zone-test-disposable";
    expect(checkCommandSafe(cmd).tag).toBe("file-mutation");
    const result = await executeTool("run_command_readonly", { command: cmd }, repoPath);
    expect(result.success).toBe(false);
    expect(result.output).toContain("modifies or removes files");
    expect(result.output).not.toContain("separate call");
  });

  it("non-whitelisted safe command (curl, no -X) reports tag 'whitelist-miss' with approval-shell guidance", async () => {
    const cmd = "curl https://example.com";
    expect(checkCommandSafe(cmd).tag).toBe("whitelist-miss");
    const result = await executeTool("run_command_readonly", { command: cmd }, repoPath);
    expect(result.success).toBe(false);
    expect(result.output).toContain("run_command");
  });
});

describe("run_command_readonly: whitelist-miss message (C-3)", () => {
  it("whoami (safe but unlisted) reports tag 'whitelist-miss' with approval-shell guidance", async () => {
    const cmd = "whoami";
    expect(checkCommandSafe(cmd).tag).toBe("whitelist-miss");
    const result = await executeTool("run_command_readonly", { command: cmd }, repoPath);
    expect(result.success).toBe(false);
    expect(result.output).toContain("run_command");
    expect(result.output).not.toContain("separate");
  });

  it("date (safe but unlisted) reports tag 'whitelist-miss' with approval-shell guidance", async () => {
    const cmd = "date";
    expect(checkCommandSafe(cmd).tag).toBe("whitelist-miss");
    const result = await executeTool("run_command_readonly", { command: cmd }, repoPath);
    expect(result.success).toBe(false);
    expect(result.output).toContain("run_command");
  });

  it("rm -rf x (dangerous blacklist hit) reports tag 'file-mutation', not whitelist-miss", async () => {
    const cmd = "rm -rf /tmp/zone-test-c3";
    expect(checkCommandSafe(cmd).tag).toBe("file-mutation");
    const result = await executeTool("run_command_readonly", { command: cmd }, repoPath);
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("run_command");
  });
});

describe("run_command_readonly: catch-all class content guards, map-level (item 93 fix)", () => {
  // Content guards from the old mechanism, PRESERVED and WIDENED: previously each was
  // spot-checked against one rendered example (rm) only. Now checked against all 17
  // catch-all class strings directly in the message table, not one example each.
  const CATCH_ALL_ENTRIES = Object.entries(CATCH_ALL_TEXT) as [CatchAllClass, string][];
  const NO_EQUIVALENT: CatchAllClass[] = [
    "file-mutation", "git-mutation", "network-mutation", "process-kill", "empty-command",
  ];

  it("no catch-all class string contains 'run_command' (substring of run_command_readonly)", () => {
    for (const [cls, text] of CATCH_ALL_ENTRIES) {
      expect(text, `class ${cls}`).not.toContain("run_command");
    }
  });

  it("no catch-all class string contains 'separate call' (chain's own distinguishing phrase)", () => {
    for (const [cls, text] of CATCH_ALL_ENTRIES) {
      expect(text, `class ${cls}`).not.toContain("separate call");
    }
  });

  it("no catch-all class string contains raw regex source ('blocked pattern:')", () => {
    for (const [cls, text] of CATCH_ALL_ENTRIES) {
      expect(text, `class ${cls}`).not.toContain("blocked pattern:");
    }
  });

  it("every catch-all class's own rule sentence fits the 83-char budget before the 100-char TUI title slice", () => {
    const PREFIX = "Command blocked: ";
    const BUDGET = 100 - PREFIX.length;
    for (const [cls, text] of CATCH_ALL_ENTRIES) {
      const rule = text.split(/(?<=[.!?])\s/)[0];
      expect(rule.length, `class ${cls} rule "${rule}" (${rule.length} chars)`).toBeLessThanOrEqual(BUDGET);
    }
  });

  it("the 5 no-equivalent classes name no rephrasing", () => {
    for (const cls of NO_EQUIVALENT) {
      expect(CATCH_ALL_TEXT[cls], `class ${cls}`).not.toMatch(/for example|such as/i);
    }
  });

  it("the 12 remaining catch-all classes each name a rephrasing", () => {
    for (const [cls, text] of CATCH_ALL_ENTRIES) {
      if (NO_EQUIVALENT.includes(cls)) continue;
      expect(text, `class ${cls}`).toMatch(/for example|such as/i);
    }
  });
});

describe("run_command_readonly: catch-all end-to-end, tag + content per class (item 93 fix)", () => {
  // Representative command per class through the real executeTool -- exercises the
  // pattern-to-tag WIRING and the rendered content together, which the map-level tests
  // above cannot (they inspect the message table in isolation, never which pattern
  // actually selects which entry).
  const CASES: { cls: CatchAllClass; cmd: string; expectContent: string }[] = [
    { cls: "find-write-exec", cmd: "find . -type f -delete", expectContent: "writes or runs a program" },
    { cls: "fd-exec", cmd: "fd -x rm {}", expectContent: "runs another program per match" },
    { cls: "rg-preprocessor", cmd: "rg --pre ./run.sh pat", expectContent: "runs an external program" },
    { cls: "file-mutation", cmd: "rm build.log", expectContent: "modifies or removes files" },
    { cls: "write-redirect", cmd: "ls -la > out.txt", expectContent: "writes output to a file" },
    { cls: "tee", cmd: "ls | tee out.txt", expectContent: "writes its input to a file" },
    { cls: "package-mutation", cmd: "npm install left-pad", expectContent: "installs or changes dependencies" },
    { cls: "git-injection", cmd: "git -c core.pager=cat log", expectContent: "arbitrary program" },
    { cls: "git-mutation", cmd: "git push origin master", expectContent: "changes repository state" },
    { cls: "git-branch-mutation", cmd: "git branch -d topic", expectContent: "deletes, renames" },
    { cls: "network-mutation", cmd: "curl http://x -X POST", expectContent: "network write" },
    { cls: "shell-substitution", cmd: "ls $(git rev-parse --show-toplevel)", expectContent: "nested command" },
    { cls: "sort-o", cmd: "ls | sort -o /tmp/x", expectContent: "writes to a file" },
    { cls: "privilege-escalation", cmd: "sudo ls /root", expectContent: "escalate privileges" },
    { cls: "process-kill", cmd: "kill 4242", expectContent: "terminates a process" },
    { cls: "pipe-to-non-utility", cmd: "ls | xargs rm", expectContent: "read-only text utility" },
    { cls: "empty-command", cmd: "", expectContent: "no command was supplied" },
  ];

  for (const { cls, cmd, expectContent } of CASES) {
    it(`${cls}: tag and content both correct for ${JSON.stringify(cmd)}`, async () => {
      expect(checkCommandSafe(cmd).tag).toBe(cls);
      const result = await executeTool("run_command_readonly", { command: cmd }, repoPath);
      expect(result.success).toBe(false);
      expect(result.output).toContain(expectContent);
    });
  }
});

describe("run_command_readonly: whitelist-miss curated sample (item 108 fix)", () => {
  // Item 108 fix: the whitelist-miss render used to print WHITELIST_PREFIXES.slice(0, 8),
  // which put every test runner first and pushed the five discovery binaries an agent
  // holding only run_command_readonly actually needs (ls/find/grep/rg/fd) past the slice.
  // The render now builds its own discovery-first curated sample instead of reading
  // `reason` — these tests check that sample directly, not the old identity-by-prose proxy.

  it("every curated sample entry is a member of the real WHITELIST_PREFIXES array, not a second hardcoded list", () => {
    for (const p of WHITELIST_MISS_SAMPLE) {
      expect(WHITELIST_PREFIXES, `curated entry ${JSON.stringify(p)}`).toContain(p);
    }
  });

  it("message states the sample is partial, with the count read from the live array", async () => {
    const result = await executeTool("run_command_readonly", { command: "whoami" }, repoPath);
    expect(result.output).toContain("Examples of");
    expect(result.output).toContain(`(${WHITELIST_PREFIXES.length} total)`);
  });

  it("a rejected command from a recognized ecosystem gets that ecosystem's own sample, not the generic JS/TS one", async () => {
    // cargo publish: whitelist-miss (destructive, deliberately not added) — the leading token
    // is still recognized, so ecosystemSampleFor fires even though the command itself is refused.
    const result = await executeTool("run_command_readonly", { command: "cargo publish" }, repoPath);
    expect(result.output).toContain("cargo check");
    expect(result.output).toContain("cargo fmt --check");
    expect(result.output).not.toContain("npx vitest");
  });

  it("a rejected command from an unrecognized ecosystem falls back to the generic sample", async () => {
    const result = await executeTool("run_command_readonly", { command: "npm run deploy" }, repoPath);
    for (const p of WHITELIST_MISS_SAMPLE) {
      expect(result.output).toContain(p);
    }
  });

  const DISCOVERY_BINARIES = ["ls", "find", "grep", "rg", "fd"];
  for (const bin of DISCOVERY_BINARIES) {
    it(`discovery binary '${bin}' appears inside the 100-char TUI title slice`, async () => {
      const result = await executeTool("run_command_readonly", { command: "whoami" }, repoPath);
      const title = String(result.output).slice(0, 100);
      expect(title).toMatch(new RegExp(`\\b${bin}\\b`));
    });
  }
});
