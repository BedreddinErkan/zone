// Phase L.3: per-tier execution limit overrides. Persisted to
// ~/.zone/tier-limits.json, parallel to visual-verification.json from I.2.
// Default values live in TIER_LIMITS (tierLimits.ts) — this module only
// stores user-supplied deltas. taskToolAllowed is intentionally absent from
// the schema: it is a system-level guarantee, not a user preference.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TaskTier } from "../llm/taskClassifier.js";

export interface PerTierSettings {
  tokenBudgetCap?: number;
  iterCap?: number;
  maxSubagentCalls?: number;
}

export interface TierSettingsFile {
  tierSettings?: Partial<Record<TaskTier, PerTierSettings>>;
  /** Phase AS: auto-run scope investigation before complex task execution. Default true. */
  autoAuditComplexTasks?: boolean;
  /** Phase K.1: per-user daily spend cap (USD). 0 = unlimited. Absent = use env/default. */
  dailyUsdCapOverride?: number;
}

export type TierSettings = Partial<Record<TaskTier, PerTierSettings>>;

const SETTINGS_DIR = join(homedir(), ".zone");
const SETTINGS_PATH = join(SETTINGS_DIR, "tier-limits.json");

const VALIDATION = {
  tokenBudgetCap: { min: 10_000, max: 2_000_000 },
  iterCap: { min: 1, max: 100 },
  maxSubagentCalls: { min: 0, max: 5 },
} as const;

const VALID_TIERS: TaskTier[] = ["simple", "medium", "complex"];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function validateAndSanitize(raw: unknown): TierSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const result: TierSettings = {};

  for (const tier of VALID_TIERS) {
    const obj = input[tier];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const src = obj as Record<string, unknown>;
    const tierResult: PerTierSettings = {};

    for (const field of ["tokenBudgetCap", "iterCap", "maxSubagentCalls"] as const) {
      const raw = src[field];
      if (raw === undefined || raw === null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      tierResult[field] = clamp(Math.floor(n), VALIDATION[field].min, VALIDATION[field].max);
    }

    if (Object.keys(tierResult).length > 0) {
      result[tier] = tierResult;
    }
  }

  return result;
}

export function getTierSettingsPath(): string {
  return SETTINGS_PATH;
}

export function readTierSettings(): TierSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    const raw = readFileSync(SETTINGS_PATH, "utf8");
    return validateAndSanitize(JSON.parse(raw));
  } catch (err) {
    console.warn("[zone-tier-settings-read-failed]", String(err));
    return {};
  }
}

export function writeTierSettings(settings: TierSettings): TierSettings {
  if (!existsSync(SETTINGS_DIR)) {
    mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  const sanitized = validateAndSanitize(settings);
  writeFileSync(SETTINGS_PATH, JSON.stringify(sanitized, null, 2), "utf8");
  return sanitized;
}

function readRawFile(): Record<string, unknown> {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeRawFile(data: Record<string, unknown>): void {
  if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), "utf8");
}

/** Phase AS: reads the autoAuditComplexTasks setting. Defaults to true when absent. */
export function readAutoAuditSetting(): boolean {
  const raw = readRawFile();
  if (typeof raw["autoAuditComplexTasks"] === "boolean") return raw["autoAuditComplexTasks"];
  return true; // default: on
}

/** Phase AS: persists the autoAuditComplexTasks setting. */
export function writeAutoAuditSetting(value: boolean): void {
  const raw = readRawFile();
  raw["autoAuditComplexTasks"] = value;
  writeRawFile(raw);
}

/** Phase K.1: reads the per-user daily USD cap override. Returns undefined when absent. */
export function readDailyUsdCapOverride(): number | undefined {
  const raw = readRawFile();
  const v = raw["dailyUsdCapOverride"];
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return undefined;
}

/** Phase K.1: persists the daily USD cap override. Pass 0 for unlimited; undefined to clear. */
export function writeDailyUsdCapOverride(value: number | undefined): void {
  const raw = readRawFile();
  if (value === undefined) {
    delete raw["dailyUsdCapOverride"];
  } else {
    raw["dailyUsdCapOverride"] = Math.max(0, value);
  }
  writeRawFile(raw);
}
