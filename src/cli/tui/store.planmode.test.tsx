import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { reducer, buildInitialState } from "./store.js";
import { saveDiskModel } from "../../api/diskModel.js";
import { loadDiskModelSync } from "../../api/diskModel.js";

function initialState() {
  return buildInitialState({ model: "claude-sonnet-4-6", capUsd: 10 });
}

describe("PLANMODE_MODAL_OPEN / CLOSE", () => {
  it("PLANMODE_MODAL_OPEN sets modalView to 'planMode'", () => {
    const s = reducer(initialState(), { type: "PLANMODE_MODAL_OPEN" });
    expect(s.modalView).toBe("planMode");
  });

  it("PLANMODE_MODAL_CLOSE returns modalView to 'none'", () => {
    let s = reducer(initialState(), { type: "PLANMODE_MODAL_OPEN" });
    s = reducer(s, { type: "PLANMODE_MODAL_CLOSE" });
    expect(s.modalView).toBe("none");
  });
});

describe("PLANMODE_APPLY", () => {
  it("applies 'quick' → modelSettings.planDepth='quick', modalView='none'", () => {
    let s = reducer(initialState(), { type: "PLANMODE_MODAL_OPEN" });
    s = reducer(s, { type: "PLANMODE_APPLY", planDepth: "quick" });

    expect(s.modalView).toBe("none");
    expect(s.modelSettings?.planDepth).toBe("quick");
  });

  it("applies 'investigate' → modelSettings.planDepth='investigate'", () => {
    let s = reducer(initialState(), { type: "PLANMODE_MODAL_OPEN" });
    s = reducer(s, { type: "PLANMODE_APPLY", planDepth: "investigate" });

    expect(s.modelSettings?.planDepth).toBe("investigate");
    expect(s.modalView).toBe("none");
  });

  it("preserves other modelSettings fields when updating planDepth", () => {
    const base = {
      ...initialState(),
      modelSettings: {
        version: 2 as const,
        model: "claude-opus-4-8",
        provider: "anthropic" as const,
        summaryFormat: "detailed" as const,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    };
    const s = reducer(base, { type: "PLANMODE_APPLY", planDepth: "quick" });

    expect(s.modelSettings?.model).toBe("claude-opus-4-8");
    expect(s.modelSettings?.summaryFormat).toBe("detailed");
    expect(s.modelSettings?.planDepth).toBe("quick");
  });
});

describe("PLANMODE_NAV", () => {
  it("direction:'down' increments planModeSelectedIndex", () => {
    const s = reducer(initialState(), { type: "PLANMODE_NAV", direction: "down" });
    expect(s.planModeSelectedIndex).toBe(1);
  });

  it("direction:'down' caps at 1 (two options)", () => {
    let s = reducer(initialState(), { type: "PLANMODE_NAV", direction: "down" });
    s = reducer(s, { type: "PLANMODE_NAV", direction: "down" });
    expect(s.planModeSelectedIndex).toBe(1);
  });

  it("direction:'up' decrements planModeSelectedIndex", () => {
    let s = reducer(initialState(), { type: "PLANMODE_NAV", direction: "down" });
    s = reducer(s, { type: "PLANMODE_NAV", direction: "up" });
    expect(s.planModeSelectedIndex).toBe(0);
  });

  it("direction:'up' floors at 0", () => {
    const s = reducer(initialState(), { type: "PLANMODE_NAV", direction: "up" });
    expect(s.planModeSelectedIndex).toBe(0);
  });

  it("initial planModeSelectedIndex is 0", () => {
    expect(initialState().planModeSelectedIndex).toBe(0);
  });
});

describe("disk round-trip — planDepth:'quick'", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-planmode-"));
    fs.mkdirSync(path.join(tmpDir, ".zone"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveDiskModel persists planDepth to same path loadDiskModelSync reads", async () => {
    await saveDiskModel(tmpDir, {
      version: 2,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      planDepth: "quick",
      updatedAt: new Date().toISOString(),
    });

    const loaded = loadDiskModelSync(tmpDir);
    expect(loaded?.planDepth).toBe("quick");
  });

  it("saveDiskModel persists planDepth:'investigate'", async () => {
    await saveDiskModel(tmpDir, {
      version: 2,
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      planDepth: "investigate",
      updatedAt: new Date().toISOString(),
    });

    const loaded = loadDiskModelSync(tmpDir);
    expect(loaded?.planDepth).toBe("investigate");
  });
});
