import type { LLMClient, LLMClientResolveOptions } from "./types.js";
import { OpenAIAdapter } from "./openaiAdapter.js";
import { AnthropicAdapter } from "./anthropicAdapter.js";
import { getRequestContext } from "./openaiContext.js";
import { RecordingLLMClient } from "./recordingClient.js";
import {
  resolveProfile,
  warnProfileCannotPriceOnce,
  type ProviderProfile,
} from "./providerProfile.js";

export class ApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyError";
  }
}

export class ProviderRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly kind: "retention" | "credit" | "request_shape" | "other",
    public readonly userMessage: string,
    public readonly raw: unknown,
  ) {
    super(userMessage);
    this.name = "ProviderRequestError";
  }
}

export class PlanRefusalError extends Error {
  constructor(
    public readonly declineReason: string,
    public readonly costUsd: number,
  ) {
    super(declineReason);
    this.name = "PlanRefusalError";
  }
}

export function createLLMClient(options: LLMClientResolveOptions = {}): LLMClient {
  const ctx = getRequestContext();
  // The run's profile is resolved ONCE, here, and the object is what everything downstream
  // receives (providerProfile.ts's R4). `fallback: "anthropic"` is this site's own historical
  // default, passed explicitly rather than hidden inside the resolver — see resolveProfile's own
  // comment for why the twelve sites each supply their own.
  // An explicitly supplied profile is used verbatim — it is the only way a profile that is not one
  // of the two built-ins reaches this function, since resolveProfile can only ever return a
  // built-in. That is what makes the no-pricing warning below reachable rather than dormant.
  const profile =
    options.profile ??
    resolveProfile({
      explicit: options.provider,
      context: ctx?.provider,
      fallback: "anthropic",
      // Preserves the throw this function has always had for an unrecognized provider, rather than
      // letting it silently become a warn-and-fall-back (R5). Unreachable while LLMProvider is
      // two-valued; kept because dropping it would be a behaviour change on the day it is widened.
      onUnrecognized: (value) => {
        throw new Error(`Unsupported provider: ${value}`);
      },
    });
  warnProfileCannotPriceOnce(profile);

  const apiKey = resolveApiKeyForProfile(profile, options.apiKey, ctx?.userApiKey);
  const inner: LLMClient =
    profile.protocol === "openai-chat"
      ? new OpenAIAdapter(apiKey, profile.baseUrl, profile.adapterProvider)
      : new AnthropicAdapter(apiKey);

  return new RecordingLLMClient(inner, profile);
}

function assertApiKeyCharset(key: string, profile: ProviderProfile): void {
  const label = profile.id.toUpperCase();
  const example = profile.keyRef.keyExample;
  if (key.startsWith("<")) {
    throw new ApiKeyError(
      `${label} API key looks like a placeholder ("<…>"). ` +
      `Set a real key (e.g. ${example}) or run \`zone login\`.`
    );
  }
  for (let i = 0; i < key.length; i++) {
    const cp = key.charCodeAt(i);
    if (cp < 0x20 || cp > 0x7e) {
      throw new ApiKeyError(
        `${label} API key contains a non-ASCII character at byte ${i} ` +
        `(U+${cp.toString(16).toUpperCase().padStart(4, "0")}) — likely a placeholder. ` +
        `Set a real key (e.g. ${example}) or run \`zone login\`.`
      );
    }
  }
}

/**
 * One key resolver, driven by the profile's `keyRef`.
 *
 * This replaces `resolveOpenAIApiKey`/`resolveAnthropicApiKey`, which were near-verbatim twins
 * differing only in an env-var name and two literals. Every observable is unchanged for the
 * built-in profiles: the `[zone] llm key source=… provider=…` line, the source ladder, and the
 * ApiKeyError text all render byte-identically, because `profile.id` is `"openai"`/`"anthropic"`
 * and `keyRef.envVar` is the same variable each twin read.
 */
function resolveApiKeyForProfile(
  profile: ProviderProfile,
  explicit?: string,
  contextKey?: string
): string {
  const trimmedExplicit =
    typeof explicit === "string" && explicit.trim() ? explicit.trim() : "";
  const trimmedContext =
    typeof contextKey === "string" && contextKey.trim() ? contextKey.trim() : "";
  const rawEnv = process.env[profile.keyRef.envVar];
  const envKey = typeof rawEnv === "string" && rawEnv.trim() ? rawEnv.trim() : "";

  const apiKey = trimmedExplicit || trimmedContext || envKey;
  const source = trimmedExplicit
    ? "explicit"
    : trimmedContext
      ? "user"
      : envKey
        ? "env"
        : "none";

  console.log(`[zone] llm key source=${source} provider=${profile.id}`);

  if (!apiKey) {
    throw new ApiKeyError(`${profile.keyRef.envVar} is missing for ${profile.id} provider.`);
  }

  assertApiKeyCharset(apiKey, profile);
  return apiKey;
}
