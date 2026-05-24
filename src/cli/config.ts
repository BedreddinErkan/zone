import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { LLMProvider } from "../llm/types.js";
import type { TaskTier } from "../llm/taskClassifier.js";
import type { EffortLevel } from "../llm/modelRegistry.js";
import { readDailyUsdCapOverride } from "../visual/tierSettings.js";

export interface CliConfig {
  model: string;
  provider: LLMProvider;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  dailyUsdCap: number;
  repoPath: string;
  forceTier?: TaskTier;
  autoApprove: boolean;
  noRevision: boolean;
  verbose: boolean;
  quiet: boolean;
  noColor: boolean;
  effort?: EffortLevel;
}

export interface CliFlags {
  model?: string;
  provider?: string;
  repo?: string;
  forceTier?: string;
  yes?: boolean;
  noRevision?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  noColor?: boolean;
  resume?: boolean;
}

type ZoneConfigFile = {
  userId?: string;
  email?: string;
  defaultModel?: string;
  defaultProvider?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  dailyUsdCap?: number;
};

export function readZoneConfigFile(): ZoneConfigFile {
  const configPath = path.join(os.homedir(), ".zone", "config.json");
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as ZoneConfigFile;
  } catch {
    return {};
  }
}

function envStr(key: string): string | undefined {
  const v = process.env[key];
  return v?.trim() || undefined;
}

function resolveProvider(value: string | undefined): LLMProvider {
  if (value === "openai") return "openai";
  return "anthropic";
}

function resolveForceTier(value: string | undefined): TaskTier | undefined {
  if (value === "simple" || value === "medium" || value === "complex") return value;
  return undefined;
}

export function loadCliConfig(
  flags: Partial<CliFlags> = {},
  _configFile?: ZoneConfigFile
): CliConfig {
  const file = _configFile ?? readZoneConfigFile();

  const model =
    flags.model ??
    envStr("ZONE_MODEL") ??
    file.defaultModel ??
    "claude-sonnet-4-6";

  const provider = resolveProvider(
    flags.provider ?? envStr("ZONE_PROVIDER") ?? file.defaultProvider
  );

  const anthropicApiKey = envStr("ANTHROPIC_API_KEY") ?? file.anthropicApiKey;
  const openaiApiKey = envStr("OPENAI_API_KEY") ?? file.openaiApiKey;

  const dailyUsdCap = (() => {
    const envRaw = envStr("ZONE_DAILY_USD_CAP");
    const envVal = envRaw ? Number(envRaw) : undefined;
    const tierOverride = readDailyUsdCapOverride();
    return envVal ?? tierOverride ?? file.dailyUsdCap ?? 10;
  })();

  const repoPath =
    flags.repo ?? envStr("ZONE_REPO_PATH") ?? process.cwd();

  const forceTier = resolveForceTier(
    flags.forceTier ?? envStr("ZONE_FORCE_TIER")
  );

  return {
    model,
    provider,
    anthropicApiKey,
    openaiApiKey,
    dailyUsdCap,
    repoPath,
    forceTier,
    autoApprove: flags.yes === true,
    noRevision: flags.noRevision === true,
    verbose: flags.verbose === true || envStr("ZONE_VERBOSE_LOGS") === "1",
    quiet: flags.quiet === true,
    noColor: flags.noColor === true || envStr("NO_COLOR") === "1",
  };
}

export function validateCliConfig(cfg: CliConfig): void {
  const key =
    cfg.provider === "openai" ? cfg.openaiApiKey : cfg.anthropicApiKey;
  if (!key) {
    const envVar =
      cfg.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    throw new Error(
      `No API key found for provider "${cfg.provider}". ` +
        `Set ${envVar} or run "zone login" to configure.`
    );
  }
}
