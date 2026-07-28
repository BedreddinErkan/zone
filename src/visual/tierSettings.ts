// Phase L.3: per-tier execution limit overrides. Persisted to
// ~/.zone/tier-limits.json, parallel to visual-verification.json from I.2.
// Default values live in TIER_LIMITS (tierLimits.ts) — this module only
// stores user-supplied deltas.

// Namespace import, not named bindings: the test-suite home guard
// (src/test/setup/homeGuard.ts) intercepts writes by assigning over the fs
// module's properties, and a named function import snapshots the binding at
// evaluation and never sees that assignment.
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TaskTier } from "../llm/taskClassifier.js";
import { type AuditMode, DEFAULT_AUDIT_MODE } from "../llm/auditMode.js";

export interface PerTierSettings {
  tokenBudgetCap?: number;
  softIterWarn?: number;
  maxSubagentCalls?: number;
}

export interface TierSettingsFile {
  tierSettings?: Partial<Record<TaskTier, PerTierSettings>>;
  /** Phase AS: auto-run scope investigation before complex task execution. Default true. */
  autoAuditComplexTasks?: boolean;
  /** Phase H: audit mode. "auto" skips simple tasks; "always" audits all; "on_demand" audits only when explicitRequest=true. */
  auditMode?: AuditMode;
  /** Phase K.1: per-user daily spend cap (USD). 0 = unlimited. Absent = use env/default. */
  dailyUsdCapOverride?: number;
}

export type TierSettings = Partial<Record<TaskTier, PerTierSettings>>;

// Resolved per call, never captured into a module-level const: a path captured
// at module load ignores any later redirection of the home directory, which is
// how test runs end up writing into the real ~/.zone.
function settingsDir(): string {
  return join(homedir(), ".zone");
}

function settingsPath(): string {
  return join(settingsDir(), "tier-limits.json");
}

const VALIDATION = {
  tokenBudgetCap: { min: 10_000, max: 2_000_000 },
  softIterWarn: { min: 1, max: 100 },
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

    for (const field of ["tokenBudgetCap", "softIterWarn", "maxSubagentCalls"] as const) {
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
  return settingsPath();
}

export function readTierSettings(): TierSettings {
  try {
    if (!fs.existsSync(settingsPath())) return {};
    const raw = fs.readFileSync(settingsPath(), "utf8");
    return validateAndSanitize(JSON.parse(raw));
  } catch (err) {
    console.warn("[zone-tier-settings-read-failed]", String(err));
    return {};
  }
}

export function writeTierSettings(settings: TierSettings): TierSettings {
  if (!fs.existsSync(settingsDir())) {
    fs.mkdirSync(settingsDir(), { recursive: true });
  }
  const sanitized = validateAndSanitize(settings);
  fs.writeFileSync(settingsPath(), JSON.stringify(sanitized, null, 2), "utf8");
  return sanitized;
}

function readRawFile(): Record<string, unknown> {
  try {
    if (!fs.existsSync(settingsPath())) return {};
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeRawFile(data: Record<string, unknown>): void {
  if (!fs.existsSync(settingsDir())) fs.mkdirSync(settingsDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), "utf8");
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

/** Phase H: reads the auditMode setting. Defaults to DEFAULT_AUDIT_MODE when absent. */
export function readAuditModeSetting(): AuditMode {
  const raw = readRawFile();
  const v = raw["auditMode"];
  if (v === "auto" || v === "always" || v === "on_demand") return v;
  return DEFAULT_AUDIT_MODE;
}

/** Phase H: persists the auditMode setting. */
export function writeAuditModeSetting(mode: AuditMode): void {
  const raw = readRawFile();
  raw["auditMode"] = mode;
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
