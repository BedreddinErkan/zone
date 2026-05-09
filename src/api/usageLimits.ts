import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LimitConfig = {
  dailyLimit: number | null;
  monthlyLimit: number | null;
};

const LIMITS_DIR = join(homedir(), ".zone");
const LIMITS_PATH = join(LIMITS_DIR, "limits.json");

export function loadLimitConfig(): LimitConfig {
  try {
    const raw = readFileSync(LIMITS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const dailyLimit =
      typeof parsed.dailyLimit === "number" && parsed.dailyLimit > 0
        ? parsed.dailyLimit
        : null;
    const monthlyLimit =
      typeof parsed.monthlyLimit === "number" && parsed.monthlyLimit > 0
        ? parsed.monthlyLimit
        : null;
    return { dailyLimit, monthlyLimit };
  } catch {
    return { dailyLimit: null, monthlyLimit: null };
  }
}

export function saveLimitConfig(config: LimitConfig): void {
  mkdirSync(LIMITS_DIR, { recursive: true });
  writeFileSync(LIMITS_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function checkUsageLimit(usage: {
  today: number;
  thisMonth: number;
}): {
  blocked: boolean;
  reason?: "daily_limit" | "monthly_limit";
  limit?: number;
  used?: number;
} {
  const config = loadLimitConfig();
  if (config.dailyLimit !== null && usage.today >= config.dailyLimit) {
    return {
      blocked: true,
      reason: "daily_limit",
      limit: config.dailyLimit,
      used: usage.today,
    };
  }
  if (config.monthlyLimit !== null && usage.thisMonth >= config.monthlyLimit) {
    return {
      blocked: true,
      reason: "monthly_limit",
      limit: config.monthlyLimit,
      used: usage.thisMonth,
    };
  }
  return { blocked: false };
}
