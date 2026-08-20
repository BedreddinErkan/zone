import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realZoneDir } from "../testHome.js";
import { _isInRepoTreeForTest } from "./homeGuard.js";
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

/**
 * The repository half (ledger item 236). These are the tests a guard-detection
 * mutation must kill: pointing the predicate at a prefix that cannot fire, or
 * widening the allowlist to the repository root, leaves the guard installed and
 * mute, and that failure is invisible on a passing suite unless something here
 * asserts the predicate actually discriminates.
 */
const REPO_ROOT_FOR_TEST = path.resolve(import.meta.dirname, "..", "..", "..");

describe("repo guard", () => {
  it("refuses a sync write inside the repository tree", () => {
    const target = path.join(REPO_ROOT_FOR_TEST, "__repo_guard_probe__.tmp");
    expect(() => fs.writeFileSync(target, "x")).toThrow(/zone-repo-guard/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("refuses a write into a tracked source directory — the item 235 shape", () => {
    const target = path.join(REPO_ROOT_FOR_TEST, "src", "__repo_guard_probe__.tmp");
    expect(() => fs.writeFileSync(target, "x")).toThrow(/zone-repo-guard/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("names the offending path so the failure is actionable", () => {
    const target = path.join(REPO_ROOT_FOR_TEST, "__repo_guard_probe__.tmp");
    expect(() => fs.writeFileSync(target, "x")).toThrow(target);
  });

  it("allows the two measured allowlist entries, and only those", () => {
    // Positive discrimination, not just refusal: a predicate that threw on
    // everything would pass the tests above while breaking every run, and a
    // predicate that threw on nothing would pass this one. Both directions are
    // asserted here against the same predicate.
    expect(_isInRepoTreeForTest(path.join(REPO_ROOT_FOR_TEST, "node_modules", "x", "y.json"))).toBe(false);
    expect(_isInRepoTreeForTest(path.join(REPO_ROOT_FOR_TEST, ".git", "objects", "ab", "cd"))).toBe(false);
    expect(_isInRepoTreeForTest(path.join(REPO_ROOT_FOR_TEST, "dist", "cli", "index.js"))).toBe(true);
    expect(_isInRepoTreeForTest(path.join(REPO_ROOT_FOR_TEST, ".zone", "memory.md"))).toBe(true);
    expect(_isInRepoTreeForTest(path.join(REPO_ROOT_FOR_TEST, "src", "x.ts"))).toBe(true);
  });

  it("leaves temp-directory writes alone, which is where tests must write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-repo-guard-ok-"));
    const target = path.join(dir, "fine.txt");
    expect(() => fs.writeFileSync(target, "ok")).not.toThrow();
    expect(_isInRepoTreeForTest(target)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not treat a sibling directory sharing the repo's name prefix as inside it", () => {
    // path.startsWith without the separator would make /home/bedo/zone-dogfood
    // look like it is inside /home/bedo/zone. That sibling really exists here.
    expect(_isInRepoTreeForTest(`${REPO_ROOT_FOR_TEST}-dogfood/src/x.ts`)).toBe(false);
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
