import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We override the HOME env var so the module's homedir() call resolves to a
// tmp directory, isolating these tests from the user's real ~/.zone. The
// module path constants (SETTINGS_DIR / SETTINGS_PATH) are computed at
// import time, so we must vi.resetModules() between tests.
let originalHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "zone-visual-settings-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("visualSettings", () => {
  it("loadVisualSettings returns defaults when no file exists", async () => {
    const mod = await import("./visualSettings.js");
    const settings = mod.loadVisualSettings();
    expect(settings.devServerBaseUrl).toBe("http://localhost:3000");
    expect(settings.defaultViewport).toEqual({ width: 1280, height: 720 });
    expect(settings.autoVerifyAfterPatch).toBe(false);
  });

  it("saveVisualSettings persists to ~/.zone/visual-verification.json", async () => {
    const mod = await import("./visualSettings.js");
    const saved = mod.saveVisualSettings({
      devServerBaseUrl: "http://localhost:5173",
      defaultViewport: { width: 1440, height: 900 },
      autoVerifyAfterPatch: true,
    });
    expect(saved.devServerBaseUrl).toContain("localhost:5173");
    expect(saved.defaultViewport).toEqual({ width: 1440, height: 900 });
    expect(saved.autoVerifyAfterPatch).toBe(true);

    const filePath = join(tmpHome, ".zone", "visual-verification.json");
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk.devServerBaseUrl).toContain("localhost:5173");

    // Round-trip: load returns what we saved.
    const loaded = mod.loadVisualSettings();
    expect(loaded.defaultViewport.width).toBe(1440);
    expect(loaded.autoVerifyAfterPatch).toBe(true);
  });

  it("falls back to defaults for invalid URL / out-of-range viewport / wrong type", async () => {
    const mod = await import("./visualSettings.js");
    const saved = mod.saveVisualSettings({
      devServerBaseUrl: "not-a-url",
      defaultViewport: { width: 99999, height: -50 },
      // @ts-expect-error wrong type intentionally
      autoVerifyAfterPatch: "yes",
    });
    expect(saved.devServerBaseUrl).toBe("http://localhost:3000");
    expect(saved.defaultViewport).toEqual({ width: 1280, height: 720 });
    expect(saved.autoVerifyAfterPatch).toBe(false);
  });

  it("rejects ftp:// and javascript: protocols", async () => {
    const mod = await import("./visualSettings.js");
    const ftp = mod.saveVisualSettings({
      devServerBaseUrl: "ftp://localhost:21",
      defaultViewport: { width: 1280, height: 720 },
      autoVerifyAfterPatch: false,
    });
    expect(ftp.devServerBaseUrl).toBe("http://localhost:3000");

    const js = mod.saveVisualSettings({
      devServerBaseUrl: "javascript:alert(1)",
      defaultViewport: { width: 1280, height: 720 },
      autoVerifyAfterPatch: false,
    });
    expect(js.devServerBaseUrl).toBe("http://localhost:3000");
  });

  it("accepts https:// URLs", async () => {
    const mod = await import("./visualSettings.js");
    const saved = mod.saveVisualSettings({
      devServerBaseUrl: "https://staging.example.com",
      defaultViewport: { width: 1280, height: 720 },
      autoVerifyAfterPatch: false,
    });
    expect(saved.devServerBaseUrl).toContain("https://staging.example.com");
  });

  it("survives malformed JSON in the settings file", async () => {
    const mod = await import("./visualSettings.js");
    const filePath = join(tmpHome, ".zone", "visual-verification.json");
    mkdirSync(join(tmpHome, ".zone"), { recursive: true });
    writeFileSync(filePath, "{not valid json}");
    const settings = mod.loadVisualSettings();
    expect(settings.devServerBaseUrl).toBe("http://localhost:3000");
  });
});
