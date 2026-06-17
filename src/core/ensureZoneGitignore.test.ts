import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Re-import the module fresh for each test so the _checked Set is isolated.
// Each test uses a unique mkdtemp path, so the Set never collides between cases.

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "zone-gitignore-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function helper(): Promise<typeof import("./ensureZoneGitignore.js")> {
  return import("./ensureZoneGitignore.js");
}

describe("ensureZoneGitignore", () => {
  it("non-git dir — does not create .gitignore", async () => {
    const { ensureZoneGitignore } = await helper();
    await ensureZoneGitignore(tmp);
    await expect(readFile(join(tmp, ".gitignore"), "utf-8")).rejects.toThrow(/ENOENT/);
  });

  it("git repo + .gitignore already has .zone/ — no-op (idempotent)", async () => {
    await mkdir(join(tmp, ".git"));
    const { ensureZoneGitignore } = await helper();
    const initial = "node_modules/\n.zone/\ndist/\n";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tmp, ".gitignore"), initial, "utf-8");
    await ensureZoneGitignore(tmp);
    const content = await readFile(join(tmp, ".gitignore"), "utf-8");
    const matches = content.match(/^\.zone\/$/gm);
    expect(matches).toHaveLength(1);
  });

  it("git repo + .gitignore present without .zone/ — appends .zone/", async () => {
    await mkdir(join(tmp, ".git"));
    const { ensureZoneGitignore } = await helper();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(tmp, ".gitignore"), "node_modules/\ndist/\n", "utf-8");
    await ensureZoneGitignore(tmp);
    const content = await readFile(join(tmp, ".gitignore"), "utf-8");
    expect(content).toContain(".zone/");
    expect(content).toContain("node_modules/");
  });

  it("git repo + no .gitignore — creates .gitignore with .zone/", async () => {
    await mkdir(join(tmp, ".git"));
    const { ensureZoneGitignore } = await helper();
    await ensureZoneGitignore(tmp);
    const content = await readFile(join(tmp, ".gitignore"), "utf-8");
    expect(content).toBe(".zone/\n");
  });
});
