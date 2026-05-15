import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  readTierSettings,
  writeTierSettings,
  getTierSettingsPath,
  readAutoAuditSetting,
  writeAutoAuditSetting,
} from "./tierSettings.js";

const SETTINGS_PATH = getTierSettingsPath();

let backup: string | null = null;

beforeEach(() => {
  // Snapshot whatever is on disk (or null if absent).
  backup = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, "utf8") : null;
  // Start each test with no file.
  if (fs.existsSync(SETTINGS_PATH)) fs.unlinkSync(SETTINGS_PATH);
});

afterEach(() => {
  // Restore pre-test state.
  if (backup !== null) {
    fs.writeFileSync(SETTINGS_PATH, backup, "utf8");
  } else if (fs.existsSync(SETTINGS_PATH)) {
    fs.unlinkSync(SETTINGS_PATH);
  }
});

describe("Phase L.3 tierSettings persistence", () => {
  it("readTierSettings returns empty object when file does not exist", () => {
    expect(readTierSettings()).toEqual({});
  });

  it("readTierSettings parses a valid settings file", () => {
    writeTierSettings({
      medium: { tokenBudgetCap: 500_000, iterCap: 20 },
      complex: { maxSubagentCalls: 3 },
    });
    const loaded = readTierSettings();
    expect(loaded.medium?.tokenBudgetCap).toBe(500_000);
    expect(loaded.medium?.iterCap).toBe(20);
    expect(loaded.complex?.maxSubagentCalls).toBe(3);
  });

  it("writeTierSettings returns the sanitized result", () => {
    const result = writeTierSettings({ medium: { iterCap: 20 } });
    expect(result.medium?.iterCap).toBe(20);
  });

  it("writeTierSettings creates the file on disk", () => {
    writeTierSettings({ simple: { iterCap: 10 } });
    expect(fs.existsSync(SETTINGS_PATH)).toBe(true);
  });

  it("round-trips: write then read yields the same values", () => {
    const input = {
      simple: { tokenBudgetCap: 200_000, iterCap: 12 },
      medium: { tokenBudgetCap: 500_000, iterCap: 22, maxSubagentCalls: 1 },
      complex: { tokenBudgetCap: 700_000, iterCap: 35, maxSubagentCalls: 2 },
    };
    writeTierSettings(input);
    expect(readTierSettings()).toEqual(input);
  });

  describe("value clamping", () => {
    it("clamps tokenBudgetCap below minimum (50 → 10_000)", () => {
      const result = writeTierSettings({ simple: { tokenBudgetCap: 50 } });
      expect(result.simple?.tokenBudgetCap).toBe(10_000);
    });

    it("clamps tokenBudgetCap above maximum (99M → 2_000_000)", () => {
      const result = writeTierSettings({ complex: { tokenBudgetCap: 99_000_000 } });
      expect(result.complex?.tokenBudgetCap).toBe(2_000_000);
    });

    it("clamps iterCap below minimum (0 → 1)", () => {
      const result = writeTierSettings({ medium: { iterCap: 0 } });
      expect(result.medium?.iterCap).toBe(1);
    });

    it("clamps iterCap above maximum (9999 → 100)", () => {
      const result = writeTierSettings({ medium: { iterCap: 9999 } });
      expect(result.medium?.iterCap).toBe(100);
    });

    it("clamps maxSubagentCalls below minimum (-5 → 0)", () => {
      const result = writeTierSettings({ medium: { maxSubagentCalls: -5 } });
      expect(result.medium?.maxSubagentCalls).toBe(0);
    });

    it("clamps maxSubagentCalls above maximum (100 → 5)", () => {
      const result = writeTierSettings({ complex: { maxSubagentCalls: 100 } });
      expect(result.complex?.maxSubagentCalls).toBe(5);
    });

    it("floors decimal values to integers (7.9 → 7)", () => {
      const result = writeTierSettings({ medium: { iterCap: 7.9 } });
      expect(result.medium?.iterCap).toBe(7);
    });
  });

  describe("input sanitization", () => {
    it("ignores unknown tier names", () => {
      const result = writeTierSettings({ bogus: { iterCap: 10 } } as never);
      expect((result as Record<string, unknown>).bogus).toBeUndefined();
    });

    it("ignores non-numeric field values", () => {
      const result = writeTierSettings({
        medium: { tokenBudgetCap: "not-a-number" as unknown as number },
      });
      expect(result.medium?.tokenBudgetCap).toBeUndefined();
    });

    it("ignores null field values", () => {
      const result = writeTierSettings({ medium: { iterCap: null as unknown as number } });
      expect(result.medium?.iterCap).toBeUndefined();
    });

    it("omits a tier entry entirely when all its fields are invalid", () => {
      const result = writeTierSettings({ medium: { tokenBudgetCap: NaN } });
      expect(result.medium).toBeUndefined();
    });

    it("returns empty object for null input", () => {
      expect(writeTierSettings(null as unknown as Record<string, never>)).toEqual({});
    });

    it("returns empty object for non-object input (string)", () => {
      expect(writeTierSettings("bad" as unknown as Record<string, never>)).toEqual({});
    });
  });
});

describe("Phase AS: autoAuditComplexTasks persistence", () => {
  it("readAutoAuditSetting returns true when file does not exist (default on)", () => {
    expect(readAutoAuditSetting()).toBe(true);
  });

  it("writeAutoAuditSetting(false) persists and readAutoAuditSetting returns false", () => {
    writeAutoAuditSetting(false);
    expect(readAutoAuditSetting()).toBe(false);
  });

  it("writeAutoAuditSetting(true) persists and readAutoAuditSetting returns true", () => {
    writeAutoAuditSetting(false);
    writeAutoAuditSetting(true);
    expect(readAutoAuditSetting()).toBe(true);
  });

  it("auto-audit write does not clobber existing tierSettings on disk", () => {
    writeTierSettings({ medium: { iterCap: 5 } });
    writeAutoAuditSetting(false);
    const tiers = readTierSettings();
    expect(tiers.medium?.iterCap).toBe(5);
    expect(readAutoAuditSetting()).toBe(false);
  });

  it("autoAuditComplexTasks absent from file treated as default true", () => {
    writeTierSettings({ complex: { iterCap: 20 } });
    // File exists but has no autoAuditComplexTasks key → default true
    expect(readAutoAuditSetting()).toBe(true);
  });
});
