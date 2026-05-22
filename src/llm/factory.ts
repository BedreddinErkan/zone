import type { LLMClient, LLMClientResolveOptions, LLMProvider } from "./types.js";
import { OpenAIAdapter } from "./openaiAdapter.js";
import { AnthropicAdapter } from "./anthropicAdapter.js";
import { getRequestContext } from "./openaiContext.js";
import { RecordingLLMClient } from "./recordingClient.js";

export function createLLMClient(options: LLMClientResolveOptions = {}): LLMClient {
  const ctx = getRequestContext();
  const provider = resolveProvider(options.provider, ctx?.provider);

  let inner: LLMClient;
  if (provider === "openai") {
    const apiKey = resolveOpenAIApiKey(options.apiKey, ctx?.userApiKey);
    inner = new OpenAIAdapter(apiKey);
  } else if (provider === "anthropic") {
    const apiKey = resolveAnthropicApiKey(options.apiKey, ctx?.userApiKey);
    inner = new AnthropicAdapter(apiKey);
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  return new RecordingLLMClient(inner);
}

/**
 * Resolve the active provider with this precedence:
 *   1. options.provider (explicit caller override)
 *   2. zoneRequestContext.provider (set per-request from headers / BYOM)
 *   3. "anthropic" (default)
 *
 * The Tur 2 ZONE_PROVIDER env backdoor was retired in Tur 5a once the UI
 * provider selector + request-context plumbing became the source of truth.
 */
function resolveProvider(
  explicit: LLMProvider | undefined,
  contextProvider: LLMProvider | undefined
): LLMProvider {
  if (explicit) return explicit;
  if (contextProvider) return contextProvider;
  return "anthropic";
}

function resolveOpenAIApiKey(explicit?: string, contextKey?: string): string {
  const trimmedExplicit =
    typeof explicit === "string" && explicit.trim() ? explicit.trim() : "";
  const trimmedContext =
    typeof contextKey === "string" && contextKey.trim() ? contextKey.trim() : "";
  const envKey =
    typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim()
      ? process.env.OPENAI_API_KEY.trim()
      : "";

  const apiKey = trimmedExplicit || trimmedContext || envKey;
  const source = trimmedExplicit
    ? "explicit"
    : trimmedContext
      ? "user"
      : envKey
        ? "env"
        : "none";

  console.log(`[zone] llm key source=${source} provider=openai`);

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing for openai provider.");
  }

  return apiKey;
}

function resolveAnthropicApiKey(explicit?: string, contextKey?: string): string {
  const trimmedExplicit =
    typeof explicit === "string" && explicit.trim() ? explicit.trim() : "";
  const trimmedContext =
    typeof contextKey === "string" && contextKey.trim() ? contextKey.trim() : "";
  const envKey =
    typeof process.env.ANTHROPIC_API_KEY === "string" &&
    process.env.ANTHROPIC_API_KEY.trim()
      ? process.env.ANTHROPIC_API_KEY.trim()
      : "";

  const apiKey = trimmedExplicit || trimmedContext || envKey;
  const source = trimmedExplicit
    ? "explicit"
    : trimmedContext
      ? "user"
      : envKey
        ? "env"
        : "none";

  console.log(`[zone] llm key source=${source} provider=anthropic`);

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is missing for anthropic provider.");
  }

  return apiKey;
}
