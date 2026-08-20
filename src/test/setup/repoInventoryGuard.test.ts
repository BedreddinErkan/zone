import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _inventoryForTest as inventory,
  _diffForTest as diff,
  _repoSkipSetForTest as repoSkipSet,
  _repoRootForTest as REPO_ROOT,
} from "./globalHome.js";
import { REPO_GUARD_ALLOWED_DIRS } from "../testHome.js";

/**
 * The inventory half of the repository guard (ledger item 236).
 *
 * This half is the one that catches what the write-interception half cannot:
 * 13 test files import fs write functions by name, which snapshots the binding
 * and never sees homeGuard.ts's property assignments, and child processes are
 * outside any in-process wrap entirely. It catches those by comparing the tree
 * against itself.
 *
 * These tests exist so that a mutation of the DETECTION LOGIC — not of the code
 * it guards — has something to kill. A diff that always returned no changes, or
 * a skip set that swallowed the whole repository, would leave both halves
 * installed and mute on an otherwise green suite.
 */
describe("repo inventory guard — the detection logic discriminates", () => {
  function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "zone-repo-inv-"));
  }

  it("reports a created file", () => {
    const dir = tmp();
    const before = inventory(dir);
    fs.writeFileSync(path.join(dir, "new.txt"), "x");
    const changes = diff(before, inventory(dir));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^created /);
    expect(changes[0]).toContain("new.txt");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a modified file by content size, not only by presence", () => {
    const dir = tmp();
    const f = path.join(dir, "a.txt");
    fs.writeFileSync(f, "short");
    const before = inventory(dir);
    fs.writeFileSync(f, "considerably longer content");
    const changes = diff(before, inventory(dir));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^modified /);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a deleted file", () => {
    const dir = tmp();
    const f = path.join(dir, "gone.txt");
    fs.writeFileSync(f, "x");
    const before = inventory(dir);
    fs.unlinkSync(f);
    const changes = diff(before, inventory(dir));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatch(/^deleted /);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("says nothing when nothing changed — it is not a detector that always fires", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "stable.txt"), "x");
    const before = inventory(dir);
    expect(diff(before, inventory(dir))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("skips only the allowlisted directories, and descends into everything else", () => {
    const dir = tmp();
    const skipped = path.join(dir, "node_modules");
    const watched = path.join(dir, "src");
    fs.mkdirSync(skipped, { recursive: true });
    fs.mkdirSync(watched, { recursive: true });
    const skip = new Set([skipped]);
    const before = inventory(dir, new Map(), skip);
    fs.writeFileSync(path.join(skipped, "cache.json"), "ignored");
    fs.writeFileSync(path.join(watched, "real.ts"), "caught");
    const changes = diff(before, inventory(dir, new Map(), skip));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("real.ts");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the real skip set is exactly the shared allowlist, resolved against the repo root", () => {
    // Pins the single-source-of-truth link: if one half's allowlist drifted from
    // the other's, this fails rather than leaving the two halves disagreeing.
    const expected = REPO_GUARD_ALLOWED_DIRS.map((d) => path.join(REPO_ROOT, d));
    expect([...repoSkipSet()].sort()).toEqual([...expected].sort());
    expect(REPO_GUARD_ALLOWED_DIRS).not.toContain("dist");
    expect(REPO_GUARD_ALLOWED_DIRS).not.toContain(".zone");
  });

  it("the repo root it guards is this repository, not a parent or a sibling", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, "vitest.config.ts"))).toBe(true);
  });
});
