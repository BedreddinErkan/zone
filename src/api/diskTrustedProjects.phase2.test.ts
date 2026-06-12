import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  _setTrustedProjectsPathForTest,
  addTrustedProject,
  isProjectTrusted,
  canonicalizePath,
  type TrustedProjectsFile,
} from "./diskTrustedProjects.js";

let tmpDir: string;
let storeFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "zone-trust-p2-test-"));
  storeFile = join(tmpDir, "trusted-projects.json");
  _setTrustedProjectsPathForTest(storeFile);
});

afterEach(() => {
  _setTrustedProjectsPathForTest(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("addTrustedProject — refuses system/home_root paths", () => {
  it("silently ignores / (system root)", () => {
    addTrustedProject("/", "user");
    expect(isProjectTrusted("/")).toBe(false);
    // File should not have been written (or written empty)
    try {
      const raw = JSON.parse(readFileSync(storeFile, "utf-8")) as TrustedProjectsFile;
      expect(raw.projects.length).toBe(0);
    } catch {
      // ENOENT is fine — store was never written
    }
  });

  it("silently ignores os.homedir() (home_root)", () => {
    addTrustedProject(homedir(), "user");
    expect(isProjectTrusted(homedir())).toBe(false);
  });

  it("stores a normal project normally", () => {
    const projectPath = canonicalizePath(tmpDir);
    addTrustedProject(projectPath, "user");
    expect(isProjectTrusted(projectPath)).toBe(true);
  });
});

describe("isProjectTrusted — ignores hand-injected system/home_root entries", () => {
  function writeStoreDirect(projects: TrustedProjectsFile["projects"]): void {
    writeFileSync(storeFile, JSON.stringify({ version: 1, projects }), "utf-8");
  }

  it("ignores an entry for / injected into JSON", () => {
    writeStoreDirect([{ path: "/", trustedAt: new Date().toISOString(), trustedBy: "user" }]);
    expect(isProjectTrusted("/")).toBe(false);
    // Also check descendants of / — they should not be trusted via / entry
    expect(isProjectTrusted("/usr")).toBe(false);
  });

  it("ignores an entry for /usr (system root) injected into JSON", () => {
    writeStoreDirect([{ path: "/usr", trustedAt: new Date().toISOString(), trustedBy: "user" }]);
    expect(isProjectTrusted("/usr/local/myapp")).toBe(false);
  });

  it("ignores an entry for home dir injected into JSON", () => {
    writeStoreDirect([{ path: canonicalizePath(homedir()), trustedAt: new Date().toISOString(), trustedBy: "user" }]);
    expect(isProjectTrusted(homedir())).toBe(false);
    // Subdirs should not be trusted via home root entry
    expect(isProjectTrusted(join(homedir(), "projects"))).toBe(false);
  });

  it("still trusts a normal project entry in the same file", () => {
    const projectPath = canonicalizePath(tmpDir);
    writeStoreDirect([
      { path: "/", trustedAt: new Date().toISOString(), trustedBy: "user" },       // system — ignored
      { path: projectPath, trustedAt: new Date().toISOString(), trustedBy: "user" }, // normal — trusted
    ]);
    expect(isProjectTrusted("/")).toBe(false);
    expect(isProjectTrusted(projectPath)).toBe(true);
  });
});
