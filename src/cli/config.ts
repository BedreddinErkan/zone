import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { LLMProvider } from "../llm/types.js";
import type { TaskTier } from "../llm/taskClassifier.js";
import { getProviderForModel, isKnownModelId, type EffortLevel } from "../llm/modelRegistry.js";
import { readDailyUsdCapOverride } from "../visual/tierSettings.js";
import { loadDiskModelSync } from "../api/diskModel.js";
import { loadDiskKeys } from "../api/diskKeys.js";

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
  summaryFormat?: "compact" | "detailed";
  memoryEnabled?: boolean;
  commitOnSuccess?: boolean;
  webSearchEnabled?: boolean;
  /** --trust (true) / --no-trust (false) / neither (undefined) */
  trust?: boolean;
  /** --max-turns: user ceiling on MAIN-loop iterations (parent loop only). */
  maxTurns?: number;
  /** --max-budget-usd: user ceiling on this run's total spend, subagent spend included. */
  maxBudgetUsd?: number;
}

export interface CliFlags {
  model?: string;
  effort?: string;
  provider?: string;
  repo?: string;
  forceTier?: string;
  yes?: boolean;
  noRevision?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  noColor?: boolean;
  /** true = --resume with no id (most recent session); a string = --resume <id>. */
  resume?: boolean | string;
  permissionMode?: string;
  /** --trust (true) / --no-trust (false) / neither (undefined) */
  trust?: boolean;
  /** --max-turns: user ceiling on MAIN-loop iterations. Subagents keep their own type-sized
   *  budgets and do not inherit this — see ledger item 259. */
  maxTurns?: number;
  /** --max-budget-usd: user ceiling on THIS RUN's spend, subagent spend included. The deliberate
   *  opposite of maxTurns's parent-only scope — turns are per-loop, dollars are per-run. */
  maxBudgetUsd?: number;
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
  if (value !== undefined && value !== "anthropic") {
    console.warn(`[zone] provider "${value}" is not recognized; falling back to anthropic.`);
  }
  return "anthropic";
}

function resolveForceTier(value: string | undefined): TaskTier | undefined {
  if (value === "simple" || value === "medium" || value === "complex") return value;
  return undefined;
}

function resolveEffortLevel(value: string | undefined): EffortLevel | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
  return undefined;
}

export function loadCliConfig(
  flags: Partial<CliFlags> = {},
  _configFile?: ZoneConfigFile
): CliConfig {
  const file = _configFile ?? readZoneConfigFile();
  const repoPath = flags.repo ?? envStr("ZONE_REPO_PATH") ?? process.cwd();
  const diskModel = loadDiskModelSync(repoPath);

  const explicitModel =
    flags.model ?? envStr("ZONE_MODEL") ?? diskModel?.model ?? file.defaultModel;
  let model = explicitModel ?? "claude-sonnet-4-6";

  const explicitProvider =
    flags.provider ?? envStr("ZONE_PROVIDER") ?? diskModel?.provider ?? file.defaultProvider;

  // Single source of truth for {provider, model}: an explicitly chosen catalog
  // model authoritatively determines its provider. These two used to resolve
  // from independent fallback chains, so `ZONE_MODEL=gemini-3.5-flash` with no
  // provider silently kept the anthropic default — the badge showed Gemini while
  // getModelName rejected the cross-provider override and the loop ran Claude.
  // A known model now pins the provider; an explicit provider that contradicts
  // it is overridden (loudly) to match the model the user actually picked.
  let provider: LLMProvider;
  if (explicitModel && isKnownModelId(explicitModel)) {
    provider = getProviderForModel(explicitModel);
    if (explicitProvider && resolveProvider(explicitProvider) !== provider) {
      console.warn(
        `[zone] provider "${explicitProvider}" conflicts with model "${explicitModel}" ` +
          `(${provider}); using ${provider} to match the selected model.`
      );
    }
  } else {
    provider = resolveProvider(explicitProvider);
  }

  const anthropicApiKey = envStr("ANTHROPIC_API_KEY") ?? file.anthropicApiKey;
  const openaiApiKey = envStr("OPENAI_API_KEY") ?? file.openaiApiKey;

  const dailyUsdCap = (() => {
    const envRaw = envStr("ZONE_DAILY_USD_CAP");
    const envVal = envRaw ? Number(envRaw) : undefined;
    const tierOverride = readDailyUsdCapOverride();
    return envVal ?? tierOverride ?? file.dailyUsdCap ?? 10;
  })();

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
    effort: resolveEffortLevel(flags.effort ?? envStr("ZONE_EFFORT") ?? diskModel?.effort),
    autoApprove: flags.yes === true,
    noRevision: flags.noRevision === true,
    verbose: flags.verbose === true || envStr("ZONE_VERBOSE_LOGS") === "1",
    quiet: flags.quiet === true,
    noColor: flags.noColor === true || envStr("NO_COLOR") === "1",
    webSearchEnabled: diskModel?.webSearchEnabled ?? true,
    summaryFormat: diskModel?.summaryFormat,
    trust: flags.trust,
    maxTurns: flags.maxTurns,
    maxBudgetUsd: flags.maxBudgetUsd,
  };
}

/** Fill missing API keys from ~/.zone/keys.json (BYOK store). Mutates config in-place. */
export async function applyDiskKeyFallbacks(config: CliConfig): Promise<void> {
  const store = await loadDiskKeys();
  if (!config.anthropicApiKey) {
    config.anthropicApiKey = store.keys.find(k => k.provider === "anthropic")?.key;
  }
  if (!config.openaiApiKey) {
    config.openaiApiKey = store.keys.find(k => k.provider === "openai")?.key;
  }
}

/**
 * Parse --trust / --no-trust from an argv array.
 * --no-trust wins when both are present (checked first in the ternary).
 * Returns undefined when neither flag is present (gate is NOT bypassed).
 */
export function parseTrustFlag(argv: string[] = process.argv): boolean | undefined {
  return argv.includes("--no-trust") ? false
    : argv.includes("--trust") ? true
    : undefined;
}

export function validateCliConfig(cfg: CliConfig): void {
  const key = cfg.provider === "openai" ? cfg.openaiApiKey : cfg.anthropicApiKey;
  if (!key) {
    const envVar = cfg.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    throw new Error(
      `No API key found for provider "${cfg.provider}". ` +
        `Set ${envVar} or run "zone login" to configure.`
    );
  }
}
