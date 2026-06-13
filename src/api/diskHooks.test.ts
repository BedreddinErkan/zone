import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import {
  loadDiskHooks,
  hooksConfigHash,
  isSafeFilePath,
  matchesHook,
  extractFileArg,
} from "./diskHooks.js";
import {
  isHooksTrusted,
  recordHooksTrust,
  _setTrustedHooksPathForTest,
} from "./diskTrustedHooks.js";

const VALID_HOOKS_JSON = JSON.stringify({
  version: 1,
  hooks: {
    PreToolUse: [
      { command: "exit 0", description: "allow-all", matchTools: ["apply_patch"] },
    ],
    PostToolUse: [
      { command: "echo done", feedOutputToModel: true, timeoutMs: 5000 },
    ],
  },
});

describe("diskHooks — loadDiskHooks", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "zone-hooks-"));
    await mkdir(join(tmp, ".zone"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // T-CONFIG-MISSING
  it("returns null when hooks.json is absent", async () => {
    expect(await loadDiskHooks(tmp)).toBeNull();
  });

  // T-CONFIG-VALID
  it("parses valid hooks.json and attaches _rawBytes", async () => {
    await writeFile(join(tmp, ".zone", "hooks.json"), VALID_HOOKS_JSON);
    const cfg = await loadDiskHooks(tmp);
    expect(cfg).not.toBeNull();
    expect(cfg!.version).toBe(1);
    expect(cfg!.hooks.PreToolUse).toHaveLength(1);
    expect(cfg!.hooks.PostToolUse).toHaveLength(1);
    expect(Buffer.isBuffer(cfg!._rawBytes)).toBe(true);
  });

  // T-CONFIG-BAD-VERSION
  it("returns null when version !== 1", async () => {
    await writeFile(join(tmp, ".zone", "hooks.json"), JSON.stringify({ version: 2, hooks: {} }));
    expect(await loadDiskHooks(tmp)).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    await writeFile(join(tmp, ".zone", "hooks.json"), "{ invalid");
    expect(await loadDiskHooks(tmp)).toBeNull();
  });

  it("filters out entries missing command", async () => {
    const json = JSON.stringify({
      version: 1,
      hooks: { PreToolUse: [{ description: "no-command" }, { command: "echo ok" }] },
    });
    await writeFile(join(tmp, ".zone", "hooks.json"), json);
    const cfg = await loadDiskHooks(tmp);
    expect(cfg!.hooks.PreToolUse).toHaveLength(1);
    expect(cfg!.hooks.PreToolUse![0].command).toBe("echo ok");
  });

  it("clamps timeoutMs to [1000, 120000]", async () => {
    const json = JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [
          { command: "a", timeoutMs: 50 },
          { command: "b", timeoutMs: 999999 },
          { command: "c", timeoutMs: 5000 },
        ],
      },
    });
    await writeFile(join(tmp, ".zone", "hooks.json"), json);
    const cfg = await loadDiskHooks(tmp);
    const entries = cfg!.hooks.PreToolUse!;
    expect(entries[0].timeoutMs).toBe(1000);
    expect(entries[1].timeoutMs).toBe(120_000);
    expect(entries[2].timeoutMs).toBe(5000);
  });
});

describe("diskHooks — hooksConfigHash", () => {
  it("produces a 64-char hex string", () => {
    const hash = hooksConfigHash(Buffer.from("test"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is identical for same bytes", () => {
    const buf = Buffer.from(VALID_HOOKS_JSON);
    expect(hooksConfigHash(buf)).toBe(hooksConfigHash(buf));
  });

  it("differs on whitespace change", () => {
    const h1 = hooksConfigHash(Buffer.from('{"a":1}'));
    const h2 = hooksConfigHash(Buffer.from('{ "a": 1 }'));
    expect(h1).not.toBe(h2);
  });
});

describe("diskHooks — isSafeFilePath", () => {
  it("accepts normal paths", () => {
    expect(isSafeFilePath("src/foo.ts")).toBe(true);
    expect(isSafeFilePath("src/bar/baz.js")).toBe(true);
    expect(isSafeFilePath("some-file_name.ts")).toBe(true);
  });

  // T-INJECTION-ENV
  it("rejects paths with shell metacharacters", () => {
    const bad = [
      "src/foo;rm -rf /tmp/test.ts",
      "src/foo|bar.ts",
      "src/foo&bar.ts",
      "src/`whoami`.ts",
      "src/$HOME/foo.ts",
      "src/foo>out.ts",
      "src/foo<in.ts",
      "src/foo(bar).ts",
      "src/foo{bar}.ts",
      "src/foo*bar.ts",
      'src/"foo".ts',
      "src/'foo'.ts",
      "src/foo\nbar.ts",
    ];
    for (const p of bad) {
      expect(isSafeFilePath(p)).toBe(false);
    }
  });
});

describe("diskHooks — matchesHook", () => {
  // T-MATCHER-TOOL-HIT
  it("matches when tool is in matchTools", () => {
    const entry = { command: "x", matchTools: ["apply_patch"] };
    expect(matchesHook(entry, "apply_patch", null)).toBe(true);
  });

  // T-MATCHER-TOOL-MISS
  it("does not match when tool is not in matchTools", () => {
    const entry = { command: "x", matchTools: ["apply_patch"] };
    expect(matchesHook(entry, "write_file", null)).toBe(false);
  });

  // T-MATCHER-PATH-HIT
  it("matches when filePath matches matchPaths glob", () => {
    const entry = { command: "x", matchPaths: ["src/generated/**"] };
    expect(matchesHook(entry, "write_file", "src/generated/foo.ts")).toBe(true);
  });

  // T-MATCHER-PATH-MISS
  it("does not match when filePath does not match matchPaths glob", () => {
    const entry = { command: "x", matchPaths: ["src/generated/**"] };
    expect(matchesHook(entry, "write_file", "src/lib/foo.ts")).toBe(false);
  });

  it("matches all tools when matchTools absent", () => {
    const entry = { command: "x" };
    expect(matchesHook(entry, "write_file", null)).toBe(true);
    expect(matchesHook(entry, "apply_patch", null)).toBe(true);
  });

  it("does not match when matchPaths present but filePath is null", () => {
    const entry = { command: "x", matchPaths: ["src/**"] };
    expect(matchesHook(entry, "apply_patch", null)).toBe(false);
  });
});

describe("diskHooks — extractFileArg", () => {
  it("extracts file_path field", () => {
    expect(extractFileArg("write_file", { file_path: "src/foo.ts" })).toBe("src/foo.ts");
  });

  it("extracts path field as fallback", () => {
    expect(extractFileArg("read_file", { path: "src/bar.ts" })).toBe("src/bar.ts");
  });

  it("returns null for apply_patch", () => {
    expect(extractFileArg("apply_patch", {})).toBeNull();
  });

  it("returns null when no file arg present", () => {
    expect(extractFileArg("run_command", { command: "npm test" })).toBeNull();
  });
});

describe("diskTrustedHooks", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "zone-trusted-hooks-"));
    _setTrustedHooksPathForTest(join(tmp, "trusted-hooks.json"));
  });

  afterEach(async () => {
    _setTrustedHooksPathForTest(null);
    await rm(tmp, { recursive: true, force: true });
  });

  // T-TRUST-UNKNOWN-HASH
  it("isHooksTrusted returns false for unknown hash", () => {
    expect(isHooksTrusted("/some/project", "abc123")).toBe(false);
  });

  // T-TRUST-APPROVED
  it("isHooksTrusted returns true after recordHooksTrust", () => {
    recordHooksTrust("/some/project", "deadbeef");
    expect(isHooksTrusted("/some/project", "deadbeef")).toBe(true);
  });

  // T-TRUST-CHANGED
  it("isHooksTrusted returns false for old hash after re-approval with new hash", () => {
    recordHooksTrust("/some/project", "hash1");
    recordHooksTrust("/some/project", "hash2");
    expect(isHooksTrusted("/some/project", "hash1")).toBe(false);
    expect(isHooksTrusted("/some/project", "hash2")).toBe(true);
  });

  it("recordHooksTrust is idempotent", () => {
    recordHooksTrust("/some/project", "hashX");
    recordHooksTrust("/some/project", "hashX");
    expect(isHooksTrusted("/some/project", "hashX")).toBe(true);
  });

  it("isolates entries by projectPath", () => {
    recordHooksTrust("/proj-a", "h1");
    recordHooksTrust("/proj-b", "h2");
    expect(isHooksTrusted("/proj-a", "h2")).toBe(false);
    expect(isHooksTrusted("/proj-b", "h1")).toBe(false);
    expect(isHooksTrusted("/proj-a", "h1")).toBe(true);
    expect(isHooksTrusted("/proj-b", "h2")).toBe(true);
  });
});
