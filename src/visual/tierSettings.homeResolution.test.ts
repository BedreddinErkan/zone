import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTierSettingsPath } from "./tierSettings.js";

// The module is imported once, at the top of this file. Every assertion below
// mutates HOME *after* that import, so a path captured at module load would keep
// pointing at wherever HOME was when this file was first evaluated — which is
// exactly how a test run reaches the real ~/.zone despite the suite-wide
// redirect. Nothing here writes; resolution is the whole subject.

const originalHome = process.env["HOME"];
const tempHomes: string[] = [];

afterEach(() => {
  process.env["HOME"] = originalHome;
  for (const dir of tempHomes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-tiersettings-home-"));
  tempHomes.push(dir);
  return dir;
}

describe("tierSettings resolves its path at call time", () => {
  it("follows HOME when it changes after the module was imported", () => {
    const first = freshHome();
    process.env["HOME"] = first;
    expect(getTierSettingsPath()).toBe(path.join(first, ".zone", "tier-limits.json"));

    const second = freshHome();
    process.env["HOME"] = second;
    expect(getTierSettingsPath()).toBe(path.join(second, ".zone", "tier-limits.json"));
  });

  it("never resolves outside the redirected home", () => {
    const home = freshHome();
    process.env["HOME"] = home;
    // os.userInfo() reads the passwd database, so it still reports the real home
    // after the redirect — the one anchor that cannot be moved by $HOME.
    expect(getTierSettingsPath().startsWith(os.userInfo().homedir)).toBe(false);
  });
});
