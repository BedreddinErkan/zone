import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  _setTrustedProjectsPathForTest,
  isProjectTrusted,
  addTrustedProject,
  resolveProjectRoot,
  canonicalizePath,
  type TrustedProjectsFile,
} from "./diskTrustedProjects.js";

let tmpDir: string;
let storeFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zone-trust-test-"));
  storeFile = join(tmpDir, "trusted-projects.json");
  _setTrustedProjectsPathForTest(storeFile);
});

afterEach(() => {
  _setTrustedProjectsPathForTest(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeStore(store: TrustedProjectsFile): void {
  writeFileSync(storeFile, JSON.stringify(store), "utf-8");
}

describe("load/save round-trip", () => {
  it("returns empty store when file is missing", () => {
    expect(isProjectTrusted("/some/path")).toBe(false);
  });

  it("round-trips a project entry", () => {
    const projectPath = canonicalizePath(tmpDir);
    addTrustedProject(projectPath, "user");
    expect(isProjectTrusted(projectPath)).toBe(true);
  });
});

describe("addTrustedProject dedup", () => {
  it("does not add duplicate entries", () => {
    const projectPath = canonicalizePath(tmpDir);
    addTrustedProject(projectPath, "user");
    addTrustedProject(projectPath, "user");
    const raw = JSON.parse(readFileSync(storeFile, "utf-8")) as TrustedProjectsFile;
    expect(raw.projects.length).toBe(1);
  });

  it("idempotent across different trustedBy values", () => {
    const projectPath = canonicalizePath(tmpDir);
    addTrustedProject(projectPath, "user");
    addTrustedProject(projectPath, "env"); // second call, different trustedBy
    const raw = JSON.parse(readFileSync(storeFile, "utf-8")) as TrustedProjectsFile;
    expect(raw.projects.length).toBe(1);
  });
});

describe("isProjectTrusted truth table", () => {
  let trustedRoot: string;

  beforeEach(() => {
    trustedRoot = canonicalizePath(tmpDir);
    writeStore({ version: 1, projects: [{ path: trustedRoot, trustedAt: new Date().toISOString(), trustedBy: "user" }] });
  });

  it("exact root match → true", () => {
    expect(isProjectTrusted(trustedRoot)).toBe(true);
  });

  it("descendant path → true", () => {
    expect(isProjectTrusted(trustedRoot + sep + "src")).toBe(true);
    expect(isProjectTrusted(trustedRoot + sep + "src" + sep + "deep")).toBe(true);
  });

  it("sibling with shared prefix → false", () => {
    // /home/bedo/foo2 must NOT match a trust on /home/bedo/foo
    const sibling = trustedRoot + "2";
    expect(isProjectTrusted(sibling)).toBe(false);
  });

  it("completely unrelated path → false", () => {
    expect(isProjectTrusted("/totally/different/path")).toBe(false);
  });

  it("trailing slash on candidate → still matches root", () => {
    // canonicalizePath strips trailing slash via path.resolve
    const withSlash = trustedRoot + sep;
    // isProjectTrusted will canonicalize the input, so this should still work
    expect(isProjectTrusted(trustedRoot + sep)).toBe(true);
  });
});

describe("canonicalizePath", () => {
  it("resolves an existing path", () => {
    const result = canonicalizePath(tmpDir);
    expect(result).toBeTruthy();
    expect(result).not.toContain(".."); // should be normalized
  });

  it("falls back to path.resolve for non-existent path", () => {
    const nonExistent = join(tmpDir, "does-not-exist");
    const result = canonicalizePath(nonExistent);
    expect(result).toBe(nonExistent); // path.resolve returns absolute path as-is
  });
});

describe("resolveProjectRoot", () => {
  it("finds .git root when present", () => {
    const gitDir = join(tmpDir, ".git");
    mkdirSync(gitDir);
    const result = resolveProjectRoot(join(tmpDir, "src"));
    expect(result).toBe(canonicalizePath(tmpDir));
  });

  it("falls back to canonicalized startPath when no .git found", () => {
    // tmpDir has no .git directory
    const noGitDir = mkdtempSync(join(tmpdir(), "zone-no-git-"));
    try {
      const result = resolveProjectRoot(noGitDir);
      expect(result).toBe(canonicalizePath(noGitDir));
    } finally {
      rmSync(noGitDir, { recursive: true, force: true });
    }
  });
});
