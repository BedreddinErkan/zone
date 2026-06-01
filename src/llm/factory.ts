import type { LLMClient, LLMClientResolveOptions, LLMProvider } from "./types.js";
import { OpenAIAdapter } from "./openaiAdapter.js";
import { AnthropicAdapter } from "./anthropicAdapter.js";
import { getRequestContext } from "./openaiContext.js";
import { RecordingLLMClient } from "./recordingClient.js";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

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
  } else if (provider === "gemini") {
    if (!process.env.ZONE_GEMINI_ENABLE) throw new Error(`Unsupported provider: ${provider}`);
    const apiKey = resolveGeminiApiKey(options.apiKey, ctx?.userApiKey);
    inner = new OpenAIAdapter(apiKey, GEMINI_BASE_URL, "gemini");
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

function assertApiKeyCharset(key: string, provider: "openai" | "anthropic" | "gemini"): void {
  const examples: Record<string, string> = { openai: "sk-…", anthropic: "sk-ant-…", gemini: "AIzaSy…" };
  if (key.startsWith("<")) {
    throw new Error(
      `${provider.toUpperCase()} API key looks like a placeholder ("<…>"). ` +
      `Set a real key (e.g. ${examples[provider]}) or run \`zone login\`.`
    );
  }
  for (let i = 0; i < key.length; i++) {
    const cp = key.charCodeAt(i);
    if (cp < 0x20 || cp > 0x7e) {
      throw new Error(
        `${provider.toUpperCase()} API key contains a non-ASCII character at byte ${i} ` +
        `(U+${cp.toString(16).toUpperCase().padStart(4, "0")}) — likely a placeholder. ` +
        `Set a real key (e.g. ${examples[provider]}) or run \`zone login\`.`
      );
    }
  }
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

  assertApiKeyCharset(apiKey, "openai");
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

  assertApiKeyCharset(apiKey, "anthropic");
  return apiKey;
}

function resolveGeminiApiKey(explicit?: string, contextKey?: string): string {
  const trimmedExplicit =
    typeof explicit === "string" && explicit.trim() ? explicit.trim() : "";
  const trimmedContext =
    typeof contextKey === "string" && contextKey.trim() ? contextKey.trim() : "";
  const envKey =
    typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.trim()
      ? process.env.GEMINI_API_KEY.trim()
      : "";

  const apiKey = trimmedExplicit || trimmedContext || envKey;
  const source = trimmedExplicit
    ? "explicit"
    : trimmedContext
      ? "user"
      : envKey
        ? "env"
        : "none";

  console.log(`[zone] llm key source=${source} provider=gemini`);

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing for gemini provider.");
  }

  assertApiKeyCharset(apiKey, "gemini");
  return apiKey;
}
