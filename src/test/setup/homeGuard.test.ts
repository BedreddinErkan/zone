import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realZoneDir } from "../testHome.js";
import { writeDailyUsdCapOverride, getTierSettingsPath } from "../../visual/tierSettings.js";

// homeGuard.ts is loaded as a setupFile, so it is already installed here.

const FORBIDDEN = path.join(realZoneDir(), "__home_guard_probe__", "x.json");

describe("home guard", () => {
  it("refuses a sync write inside the real ~/.zone", () => {
    expect(() => fs.writeFileSync(FORBIDDEN, "x")).toThrow(/zone-home-guard/);
    expect(() => fs.appendFileSync(FORBIDDEN, "x")).toThrow(/zone-home-guard/);
    expect(() => fs.mkdirSync(path.dirname(FORBIDDEN))).toThrow(/zone-home-guard/);
  });

  it("refuses a promises write inside the real ~/.zone", async () => {
    await expect(fs.promises.writeFile(FORBIDDEN, "x")).rejects.toThrow(/zone-home-guard/);
    await expect(fs.promises.mkdir(path.dirname(FORBIDDEN))).rejects.toThrow(/zone-home-guard/);
  });

  it("names the offending path so the failure is actionable", () => {
    expect(() => fs.writeFileSync(FORBIDDEN, "x")).toThrow(FORBIDDEN);
  });

  it("leaves writes outside the real ~/.zone alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-home-guard-ok-"));
    const target = path.join(dir, "fine.txt");
    expect(() => fs.writeFileSync(target, "ok")).not.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("ok");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still permits reads from the real home", () => {
    // Reads are untouched — the guard is about not mutating the user's data,
    // not about pretending their home does not exist.
    expect(() => fs.existsSync(realZoneDir())).not.toThrow();
  });
});

describe("home guard reaches a production writer, not only its own fixture", () => {
  const originalHome = process.env["HOME"];

  afterEach(() => {
    process.env["HOME"] = originalHome;
  });

  it("stops tierSettings writing to the real ~/.zone when HOME is not redirected", () => {
    // Simulates the exact regression: a ~/.zone writer resolving to the real
    // home mid-run. tierSettings is one of the eleven, imports fs as a
    // namespace, and writes via writeFileSync/mkdirSync — so if the guard is
    // installed and reachable, this must be refused rather than land on disk.
    process.env["HOME"] = os.userInfo().homedir;
    expect(getTierSettingsPath().startsWith(realZoneDir())).toBe(true);

    expect(() => writeDailyUsdCapOverride(999)).toThrow(/zone-home-guard/);
    expect(() => writeDailyUsdCapOverride(999)).toThrow(realZoneDir());
  });
});
