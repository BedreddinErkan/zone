import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OVERRIDE_ENV,
  parseRefUpdates,
  classifyRefUpdate,
  findMultiCommitPushes,
  formatRefusal,
  runPrePush,
} from "./prePush.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIM = path.join(REPO_ROOT, "scripts", "githooks", "pre-push");

const ZERO40 = "0".repeat(40);
const ZERO64 = "0".repeat(64);
const LOCAL = "1111111111111111111111111111111111111111";
const REMOTE = "2222222222222222222222222222222222222222";

function update(overrides: Partial<Record<"localRef" | "localOid" | "remoteRef" | "remoteOid", string>> = {}) {
  return {
    localRef: "refs/heads/master",
    localOid: LOCAL,
    remoteRef: "refs/heads/master",
    remoteOid: REMOTE,
    ...overrides,
  };
}

// ─── parseRefUpdates — the githooks(5) stdin contract ─────────────────────────────────────

describe("parseRefUpdates", () => {
  it("parses one ref update into its four fields", () => {
    const [u] = parseRefUpdates(`refs/heads/master ${LOCAL} refs/heads/master ${REMOTE}\n`);
    expect(u).toEqual({
      localRef: "refs/heads/master",
      localOid: LOCAL,
      remoteRef: "refs/heads/master",
      remoteOid: REMOTE,
    });
  });

  it("parses several ref updates from one push", () => {
    const text =
      `refs/heads/master ${LOCAL} refs/heads/master ${REMOTE}\n` +
      `refs/heads/topic ${LOCAL} refs/heads/topic ${ZERO40}\n`;
    expect(parseRefUpdates(text)).toHaveLength(2);
  });

  it("ignores blank lines and trailing newlines", () => {
    expect(parseRefUpdates(`\n\nrefs/heads/master ${LOCAL} refs/heads/master ${REMOTE}\n\n`)).toHaveLength(1);
  });

  it("drops a malformed line rather than guessing at its fields", () => {
    expect(parseRefUpdates("refs/heads/master deadbeef\n")).toEqual([]);
  });

  it("returns nothing for empty stdin", () => {
    expect(parseRefUpdates("")).toEqual([]);
  });
});

// ─── classifyRefUpdate — the two cases the guard must not have an opinion about ────────────

describe("classifyRefUpdate", () => {
  it("classifies an all-zeroes local oid as delete", () => {
    expect(classifyRefUpdate(update({ localOid: ZERO40 }))).toBe("delete");
  });

  it("classifies an all-zeroes remote oid as create", () => {
    expect(classifyRefUpdate(update({ remoteOid: ZERO40 }))).toBe("create");
  });

  it("classifies two real oids as update", () => {
    expect(classifyRefUpdate(update())).toBe("update");
  });

  it("recognises a 64-character all-zeroes oid, not just the sha-1 width", () => {
    expect(classifyRefUpdate(update({ remoteOid: ZERO64 }))).toBe("create");
  });
});

// ─── findMultiCommitPushes ────────────────────────────────────────────────────────────────

describe("findMultiCommitPushes", () => {
  it("passes a ref advancing by exactly one commit", () => {
    expect(findMultiCommitPushes([update()], () => 1)).toEqual([]);
  });

  it("flags a ref advancing by two commits", () => {
    const [v] = findMultiCommitPushes([update()], () => 2);
    expect(v.ref).toBe("refs/heads/master");
    expect(v.count).toBe(2);
  });

  it("skips a brand-new branch, whose whole history necessarily arrives at once", () => {
    expect(findMultiCommitPushes([update({ remoteOid: ZERO40 })], () => 99)).toEqual([]);
  });

  it("skips a ref deletion", () => {
    expect(findMultiCommitPushes([update({ localOid: ZERO40 })], () => 99)).toEqual([]);
  });

  it("passes a rewind, where the count is zero", () => {
    expect(findMultiCommitPushes([update()], () => 0)).toEqual([]);
  });

  it("warns and does not block when the count cannot be determined", () => {
    const warnings: string[] = [];
    expect(findMultiCommitPushes([update()], () => null, (m) => warnings.push(m))).toEqual([]);
    expect(warnings.join("\n")).toContain("could not count commits");
  });

  it("warns and does not block on a NaN count", () => {
    const warnings: string[] = [];
    expect(findMultiCommitPushes([update()], () => Number.NaN, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

// ─── formatRefusal ────────────────────────────────────────────────────────────────────────

describe("formatRefusal", () => {
  it("names the count, so the reader does not have to go back to git for it", () => {
    const text = formatRefusal([{ ref: "refs/heads/master", count: 4, remoteOid: REMOTE, localOid: LOCAL }]);
    expect(text).toContain("would advance by 4 commits");
  });

  it("names the override", () => {
    const text = formatRefusal([{ ref: "refs/heads/master", count: 2, remoteOid: REMOTE, localOid: LOCAL }]);
    expect(text).toContain(OVERRIDE_ENV);
  });
});

// ─── runPrePush ───────────────────────────────────────────────────────────────────────────

describe("runPrePush", () => {
  const twoCommitStdin = `refs/heads/master ${LOCAL} refs/heads/master ${REMOTE}\n`;

  it("refuses a two-commit advance", () => {
    const err: string[] = [];
    const code = runPrePush({
      stdinText: twoCommitStdin,
      countCommits: () => 2,
      stderr: (m) => err.push(m),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("refusing");
  });

  it("permits a one-commit advance silently", () => {
    const err: string[] = [];
    const code = runPrePush({
      stdinText: twoCommitStdin,
      countCommits: () => 1,
      stderr: (m) => err.push(m),
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
  });

  it("permits the push when ZONE_ALLOW_MULTI_PUSH=1, and says so", () => {
    const err: string[] = [];
    const code = runPrePush({
      stdinText: twoCommitStdin,
      env: { [OVERRIDE_ENV]: "1" },
      countCommits: () => 2,
      stderr: (m) => err.push(m),
    });
    expect(code).toBe(0);
    expect(err.join("\n")).toContain("allowing a push of 2 commits");
  });

  it("ignores an override set to anything other than 1", () => {
    const code = runPrePush({
      stdinText: twoCommitStdin,
      env: { [OVERRIDE_ENV]: "0" },
      countCommits: () => 2,
    });
    expect(code).toBe(1);
  });
});

// ─── end to end: the real shim, a real repo, real stdin ───────────────────────────────────
//
// Everything above injects countCommits, so it proves the logic and nothing about whether git
// can actually reach it. These cases run scripts/githooks/pre-push as git would — a synthesized
// stdin line against a throwaway repo — so an exit code and a message naming the count are facts
// only a working shim can produce. The refusal case comes first deliberately: a stdin builder
// that emitted nothing would make the permit case pass while proving nothing.

describe("pre-push shim (end to end)", () => {
  let repo: string;
  let base: string;
  let mid: string;
  let tip: string;

  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  const runShim = (stdinText: string, env: Record<string, string> = {}) =>
    spawnSync(SHIM, ["origin", "https://example.invalid/x.git"], {
      cwd: repo,
      input: stdinText,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "zone-prepush-"));
    git(repo, "init", "-q", "-b", "main");
    for (const n of ["a", "b", "c"]) {
      writeFileSync(path.join(repo, `${n}.txt`), n);
      git(repo, "add", "--", `${n}.txt`);
      git(repo, "commit", "-q", "-m", `add ${n}`);
    }
    tip = git(repo, "rev-parse", "HEAD");
    mid = git(repo, "rev-parse", "HEAD~1");
    base = git(repo, "rev-parse", "HEAD~2");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("refuses a two-commit push end to end", () => {
    const r = runShim(`refs/heads/main ${tip} refs/heads/main ${base}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would advance by 2 commits");
  });

  it("permits a one-commit push end to end", () => {
    const r = runShim(`refs/heads/main ${tip} refs/heads/main ${mid}\n`);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("honours ZONE_ALLOW_MULTI_PUSH end to end", () => {
    const r = runShim(`refs/heads/main ${tip} refs/heads/main ${base}\n`, { [OVERRIDE_ENV]: "1" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("allowing a push of 2 commits");
  });

  it("permits a brand-new branch carrying its whole history", () => {
    const r = runShim(`refs/heads/main ${tip} refs/heads/main ${ZERO40}\n`);
    expect(r.status).toBe(0);
    // Exit 0 alone does not distinguish "the create arm skipped it" from "rev-list against an
    // all-zeroes oid errored and the unknown-count path skipped it" — measured, both routes
    // reach 0. A silent stderr is what separates them.
    expect(r.stderr).toBe("");
  });
});
