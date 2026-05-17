import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, loadRepoRegistry, removeRepo, saveRepoRegistry } from "./repos.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-repos-"));
  process.env.ZONE_CONFIG_DIR = tmpDir;
  // Pre-populate with default entries so tests have a stable baseline
  saveRepoRegistry([
    { id: "default:zone-api", label: "zone-api", path: "/home/bedo/zone-api", isDefault: true },
    { id: "default:zone-bench", label: "zone-bench", path: "/home/bedo/zone-bench", isDefault: true },
  ]);
});

afterEach(() => {
  delete process.env.ZONE_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("repo registry (D6)", () => {
  it("loadRepoRegistry returns saved entries (zone-api, zone-bench)", () => {
    const repos = loadRepoRegistry();
    expect(repos.length).toBe(2);
    expect(repos.some((r) => r.label === "zone-api")).toBe(true);
    expect(repos.some((r) => r.label === "zone-bench")).toBe(true);
  });

  it("addRepo with valid git path adds entry and persists to config file", async () => {
    // /home/bedo/zone-api exists and is a git repo
    const result = await addRepo("dogfood", "/home/bedo/zone-api");
    // Either newly added or found existing (path already in list)
    expect(result.ok).toBe(true);
    expect(result.repo).toBeDefined();
    expect(result.repo!.path).toBe("/home/bedo/zone-api");
  });

  it("addRepo with non-existent path returns error without mutating registry", async () => {
    const before = loadRepoRegistry().length;
    const result = await addRepo("nope", "/tmp/__zone_d6_nonexistent_path_xyz__");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not exist/i);
    expect(loadRepoRegistry().length).toBe(before);
  });

  it("removeRepo removes a custom entry but returns error for default IDs", () => {
    // Add a custom entry first
    const custom = { id: "custom:test", label: "test-worktree", path: "/tmp/test-wt" };
    saveRepoRegistry([
      { id: "default:zone-api", label: "zone-api", path: "/home/bedo/zone-api", isDefault: true },
      custom,
    ]);

    const failResult = removeRepo("default:zone-api");
    expect(failResult.ok).toBe(false);
    expect(failResult.error).toMatch(/default/i);

    const okResult = removeRepo("custom:test");
    expect(okResult.ok).toBe(true);
    const remaining = loadRepoRegistry();
    expect(remaining.find((r) => r.id === "custom:test")).toBeUndefined();
  });
});
