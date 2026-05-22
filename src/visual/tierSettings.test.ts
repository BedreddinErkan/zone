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
      medium: { tokenBudgetCap: 500_000 },
      complex: { maxSubagentCalls: 3 },
    });
    const loaded = readTierSettings();
    expect(loaded.medium?.tokenBudgetCap).toBe(500_000);
    expect(loaded.complex?.maxSubagentCalls).toBe(3);
  });

  it("writeTierSettings returns the sanitized result", () => {
    const result = writeTierSettings({ medium: { tokenBudgetCap: 100_000 } });
    expect(result.medium?.tokenBudgetCap).toBe(100_000);
  });

  it("writeTierSettings creates the file on disk", () => {
    writeTierSettings({ simple: { tokenBudgetCap: 100_000 } });
    expect(fs.existsSync(SETTINGS_PATH)).toBe(true);
  });

  it("round-trips: write then read yields the same values", () => {
    const input = {
      simple: { tokenBudgetCap: 200_000 },
      medium: { tokenBudgetCap: 500_000, maxSubagentCalls: 1 },
      complex: { tokenBudgetCap: 700_000, maxSubagentCalls: 2 },
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

    it.skip("clamps iterCap below minimum (0 → 1)", () => {
      // iterCap was planned but never implemented in PerTierSettings; removed 2026-05-22
    });

    it.skip("clamps iterCap above maximum (9999 → 100)", () => {
      // iterCap was planned but never implemented in PerTierSettings; removed 2026-05-22
    });

    it("clamps maxSubagentCalls below minimum (-5 → 0)", () => {
      const result = writeTierSettings({ medium: { maxSubagentCalls: -5 } });
      expect(result.medium?.maxSubagentCalls).toBe(0);
    });

    it("clamps maxSubagentCalls above maximum (100 → 5)", () => {
      const result = writeTierSettings({ complex: { maxSubagentCalls: 100 } });
      expect(result.complex?.maxSubagentCalls).toBe(5);
    });

    it.skip("floors decimal values to integers (7.9 → 7)", () => {
      // iterCap was planned but never implemented in PerTierSettings; removed 2026-05-22
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
    writeTierSettings({ medium: { tokenBudgetCap: 100_000 } });
    writeAutoAuditSetting(false);
    const tiers = readTierSettings();
    expect(tiers.medium?.tokenBudgetCap).toBe(100_000);
    expect(readAutoAuditSetting()).toBe(false);
  });

  it("autoAuditComplexTasks absent from file treated as default true", () => {
    writeTierSettings({ complex: { maxSubagentCalls: 2 } });
    // File exists but has no autoAuditComplexTasks key → default true
    expect(readAutoAuditSetting()).toBe(true);
  });
});
