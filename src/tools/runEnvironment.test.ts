import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateRunEnvironment } from "./runEnvironment.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-d7-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("validateRunEnvironment (D7)", () => {
  it("returns valid for non-node commands", () => {
    const r = validateRunEnvironment(tempDir, "ls -la");
    expect(r.valid).toBe(true);
    expect(r.issue).toBeUndefined();
  });

  it("returns invalid when node_modules missing for npm command", () => {
    const r = validateRunEnvironment(tempDir, "npm test");
    expect(r.valid).toBe(false);
    expect(r.issue).toContain("node_modules");
    expect(r.hint).toContain("npm install");
  });

  it("returns invalid when node_modules missing for npx command", () => {
    const r = validateRunEnvironment(tempDir, "npx vitest run");
    expect(r.valid).toBe(false);
    expect(r.issue).toContain("node_modules");
    expect(r.hint).toMatch(/install/i);
  });

  it("returns invalid when node_modules missing for direct vitest command", () => {
    const r = validateRunEnvironment(tempDir, "vitest run --reporter verbose");
    expect(r.valid).toBe(false);
    expect(r.issue).toContain("node_modules");
  });

  it("returns valid when node_modules exists", () => {
    fs.mkdirSync(path.join(tempDir, "node_modules"));
    const r = validateRunEnvironment(tempDir, "npm test");
    expect(r.valid).toBe(true);
    expect(r.issue).toBeUndefined();
  });

  describe("installer exemption (DF-15)", () => {
    it("allows installer commands even when node_modules is absent", () => {
      // tempDir has no node_modules
      for (const cmd of [
        "npm install",
        "npm install lodash",
        "npm i",
        "npm i lodash",
        "npm ci",
        "yarn",
        "yarn install",
        "yarn add lodash",
        "pnpm install",
        "pnpm i",
        "pnpm add lodash",
      ]) {
        const r = validateRunEnvironment(tempDir, cmd);
        expect(r.valid, `expected valid:true for "${cmd}"`).toBe(true);
      }
    });

    it("still blocks build/test commands when node_modules absent (D7 preserved)", () => {
      for (const cmd of [
        "npm run build",
        "npm test",
        "vitest run",
        "tsc --noEmit",
        "npx vitest run",
      ]) {
        const r = validateRunEnvironment(tempDir, cmd);
        expect(r.valid, `expected valid:false for "${cmd}"`).toBe(false);
        expect(r.hint, `expected hint for "${cmd}"`).toMatch(/install/i);
      }
    });
  });

  it("returns valid:true with stale warning when lockfile is newer than installed modules", () => {
    // node_modules exists but package-lock.json was updated after last install
    const nmPath = path.join(tempDir, "node_modules");
    fs.mkdirSync(nmPath);
    fs.writeFileSync(path.join(nmPath, ".package-lock.json"), "{}");

    const lockfilePath = path.join(tempDir, "package-lock.json");
    fs.writeFileSync(lockfilePath, "{}");
    // Set lockfile mtime to 10s in the future relative to now
    const futureMs = Date.now() + 10_000;
    fs.utimesSync(lockfilePath, futureMs / 1000, futureMs / 1000);

    const r = validateRunEnvironment(tempDir, "npm test");
    expect(r.valid).toBe(true);
    expect(r.issue).toContain("newer");
    expect(r.hint).toContain("install");
  });
});
