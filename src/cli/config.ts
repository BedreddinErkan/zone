import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { LLMProvider } from "../llm/types.js";
import type { TaskTier } from "../llm/taskClassifier.js";
import { getProviderForModel, isKnownModelId, type EffortLevel } from "../llm/modelRegistry.js";
import { providerOf, resolveProfile, type ProviderProfile } from "../llm/providerProfile.js";
import { readDailyUsdCapOverride } from "../visual/tierSettings.js";
import { loadDiskModelSync } from "../api/diskModel.js";
import { loadDiskKeys } from "../api/diskKeys.js";
import { readGatewayProfilesSync } from "../llm/gatewayProfiles.js";

export interface CliConfig {
  model: string;
  /**
   * The PROTOCOL SELECTOR — which adapter and conversion modules run. Stays two-valued: a gateway
   * speaking openai-chat resolves to `"openai"` here, so every existing adapter path, ternary and
   * string-typed provider field keeps working unchanged and `LLMProvider` never widens. The endpoint
   * IDENTITY lives on `profile` below; splitting the two is the whole point of `ProviderProfile`.
   */
  provider: LLMProvider;
  /**
   * Set only when the active provider is a gateway profile from the key store. Absent for the two
   * built-ins, where `provider` alone still says everything. Threaded to the agent loop so
   * `createLLMClient` uses it verbatim (base URL, credential, capabilities, pricing).
   */
  profile?: ProviderProfile;
  /** The resolved key for `profile`, when one is active. Vendor keys stay in their own fields. */
  profileApiKey?: string;
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

/**
 * This file's own provider resolution, now delegating to the one resolver in
 * `llm/providerProfile.ts`. `"anthropic"` is passed as THIS site's fallback rather than being a
 * constant inside the resolver — the twelve defaulting sites do not agree on a default, and
 * preserving that disagreement explicitly is the point (see `resolveProfile`'s own comment).
 *
 * The unrecognized-value warning is item 385's and is reproduced verbatim, including the raw value.
 */
function resolveProviderProfile(value: string | undefined): ProviderProfile {
  // Gateway profiles from the key store are consulted FIRST, and only for a non-empty explicit
  // value. `resolveProfile` itself is left untouched: it can only ever return a built-in, and it is
  // pinned by the characterization baseline at all twelve defaulting sites. Falling through to it
  // unchanged is what keeps item 385's unrecognized-provider warning firing byte-exact for a value
  // that names neither a built-in nor a configured gateway.
  if (value !== undefined && value !== "") {
    const gateway = readGatewayProfilesSync().find((p) => p.id === value);
    if (gateway) return gateway;
  }
  return resolveProfile({
    explicit: value,
    fallback: "anthropic",
    onUnrecognized: (raw) => {
      console.warn(`[zone] provider "${raw}" is not recognized; falling back to anthropic.`);
    },
  });
}

/** True for a profile that is not one of the two built-ins — i.e. one that came from the key store. */
function isGatewayProfile(profile: ProviderProfile): boolean {
  return profile.id !== "anthropic" && profile.id !== "openai";
}

/**
 * The API key for whichever provider this config actually resolved to.
 *
 * Extracted because the same two-valued ternary was written out six times (`config.ts` twice,
 * `dispatch.ts` four) and a gateway needs a third arm at every one of them. Adding a seventh copy
 * was the alternative; replacing the six is the same edit count and leaves one place to be wrong.
 */
export function keyForConfig(cfg: CliConfig): string | undefined {
  if (cfg.profile) return cfg.profileApiKey;
  return cfg.provider === "openai" ? cfg.openaiApiKey : cfg.anthropicApiKey;
}

/** The env var name to suggest when `keyForConfig` comes back empty. */
export function keyEnvVarForConfig(cfg: CliConfig): string {
  if (cfg.profile) return cfg.profile.keyRef.envVar;
  return cfg.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
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
  const resolvedProfile = resolveProviderProfile(explicitProvider);
  const gatewayProfile = isGatewayProfile(resolvedProfile) ? resolvedProfile : undefined;

  // A gateway outranks the model->provider pin below. That pin exists to stop a catalog model from
  // running on the wrong vendor; but a proxy may legitimately serve a catalog id (a LiteLLM route
  // named `claude-sonnet-4-6`), and letting the pin win there would silently send the call to
  // Anthropic direct — the exact "badge says one thing, loop runs another" failure the pin prevents,
  // just pointed the other way.
  if (gatewayProfile) {
    provider = providerOf(gatewayProfile);
  } else if (explicitModel && isKnownModelId(explicitModel)) {
    provider = getProviderForModel(explicitModel);
    // Compared through providerOf, NEVER by profile object identity: identity is always-unequal
    // once a profile is cloned or frozen, which would fire this conflict warning on pairs that
    // actually agree (confirmed by trial edit — it turns config.test.ts to 5 failures).
    // `resolvedProfile` rather than a second resolve call — R4 (resolve once, thread the object),
    // and re-resolving would now re-read the key store on every branch as well.
    if (explicitProvider && providerOf(resolvedProfile) !== provider) {
      console.warn(
        `[zone] provider "${explicitProvider}" conflicts with model "${explicitModel}" ` +
          `(${provider}); using ${provider} to match the selected model.`
      );
    }
  } else {
    provider = providerOf(resolvedProfile);
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
    // Spread rather than assigned, so a non-gateway config has no `profile` key at all — the two
    // built-in paths stay byte-identical to what they returned before this pass.
    ...(gatewayProfile ? { profile: gatewayProfile } : {}),
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
  // A gateway's key lives under its own identity, so it neither reads from nor writes to the two
  // vendor fields — a configured gateway and a configured OpenAI key coexist without either
  // shadowing the other.
  if (config.profile && !config.profileApiKey) {
    config.profileApiKey = store.keys.find(k => k.provider === config.profile!.id)?.key;
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
  const key = keyForConfig(cfg);
  if (!key) {
    const envVar = keyEnvVarForConfig(cfg);
    // The profile id, not the protocol selector: for a gateway, `cfg.provider` is "openai" and
    // naming it here would send the user looking for an OpenAI key they do not need.
    const label = cfg.profile?.id ?? cfg.provider;
    throw new Error(
      `No API key found for provider "${label}". ` +
        `Set ${envVar} or run "zone login" to configure.`
    );
  }
}
