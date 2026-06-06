import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadDiskModel, saveDiskModel } from "./diskModel.js";
import type { DiskModelSettings } from "./diskModel.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zone-diskmodel-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("diskModel", () => {
  it("returns null when no file exists (ENOENT)", async () => {
    const result = await loadDiskModel(tmpDir);
    expect(result).toBeNull();
  });

  it("loads a valid version 2 settings file", async () => {
    const settings: DiskModelSettings = {
      version: 2,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      effort: "medium",
      updatedAt: "2026-05-24T00:00:00.000Z",
    };
    await saveDiskModel(tmpDir, settings);
    const result = await loadDiskModel(tmpDir);
    expect(result).toEqual(settings);
  });

  it("returns null and warns for wrong version", async () => {
    const p = path.join(tmpDir, ".zone", "model.json");
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify({ version: 1, model: "claude-sonnet-4-6", provider: "anthropic" }), "utf-8");
    const result = await loadDiskModel(tmpDir);
    expect(result).toBeNull();
  });

  // Phase 2a: planDepth persists and round-trips
  it("planDepth:'quick' round-trips through saveDiskModel / loadDiskModel", async () => {
    const settings: DiskModelSettings = {
      version: 2,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      planDepth: "quick",
      updatedAt: "2026-06-05T00:00:00.000Z",
    };
    await saveDiskModel(tmpDir, settings);
    const result = await loadDiskModel(tmpDir);
    expect(result?.planDepth).toBe("quick");
  });

  it("planDepth:'investigate' round-trips through saveDiskModel / loadDiskModel", async () => {
    const settings: DiskModelSettings = {
      version: 2,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      planDepth: "investigate",
      updatedAt: "2026-06-05T00:00:00.000Z",
    };
    await saveDiskModel(tmpDir, settings);
    const result = await loadDiskModel(tmpDir);
    expect(result?.planDepth).toBe("investigate");
  });

  it("planDepth is undefined when the field is absent from stored settings", async () => {
    const settings: DiskModelSettings = {
      version: 2,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      updatedAt: "2026-06-05T00:00:00.000Z",
    };
    await saveDiskModel(tmpDir, settings);
    const result = await loadDiskModel(tmpDir);
    expect(result?.planDepth).toBeUndefined();
  });
});
