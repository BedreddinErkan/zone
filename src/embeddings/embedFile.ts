import crypto from "node:crypto";
import { createLLMClient } from "../llm/factory.js";
import { loadDiskKeys } from "../api/diskKeys.js";
import { debugLog, errorLog } from "../utils/logger.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_INPUT_CHARS = 24000;
const MAX_CONTENT_CHARS = 6000;
const EMBED_TIMEOUT_MS = 30000;

// Per-process memoization: log the skip reason once per provider, then stay silent.
const _embedSkipLoggedProviders = new Set<string>();

// Resolved once per process, then cached. null = no OpenAI key → silent degrade.
let _resolvedOpenAIKey: string | null | undefined = undefined;

// Guards the no_openai_key / client_init_failed log — prevents per-chunk spam.
let _clientInitFailed = false;

async function getEmbeddingApiKey(): Promise<string | null> {
  if (_resolvedOpenAIKey !== undefined) return _resolvedOpenAIKey;
  const diskKeys = await loadDiskKeys();
  const fromDisk = diskKeys.keys.find(k => k.provider === "openai")?.key?.trim() ?? "";
  const fromEnv = (process.env.OPENAI_API_KEY ?? "").trim();
  _resolvedOpenAIKey = fromDisk || fromEnv || null;
  return _resolvedOpenAIKey;
}

// Resets module-level state for test isolation.
export function _resetEmbedStateForTest(): void {
  _resolvedOpenAIKey = undefined;
  _clientInitFailed = false;
  _embedSkipLoggedProviders.clear();
}

function truncateForEmbedding(text: string, maxChars = MAX_INPUT_CHARS): string {
  const raw = String(text || "");
  if (raw.length <= maxChars) return raw;
  return raw.slice(0, maxChars);
}

export function hashFileContent(content: string): string {
  return crypto.createHash("sha256").update(String(content || ""), "utf8").digest("hex");
}

export function buildEmbedInput(filePath: string, content: string): string {
  const normalizedPath = String(filePath || "").trim();
  const body = String(content || "").slice(0, MAX_CONTENT_CHARS);
  return `FILE: ${normalizedPath}\n\n${body}`;
}

export async function embedText(text: string): Promise<number[] | null> {
  if (_clientInitFailed) return null;

  const startedAt = Date.now();
  const truncated = truncateForEmbedding(text);
  const tokensApprox = Math.ceil(truncated.length / 4);

  const openaiKey = await getEmbeddingApiKey();
  if (!openaiKey) {
    if (!_clientInitFailed) {
      _clientInitFailed = true;
      console.warn("[zone-embed-skipped]", {
        reason: "no_openai_key",
        detail: "No OpenAI API key for embeddings; semantic retrieval disabled.",
      });
    }
    return null;
  }

  let client: ReturnType<typeof createLLMClient>;
  try {
    client = createLLMClient({ provider: "openai", apiKey: openaiKey });
  } catch (error) {
    if (!_clientInitFailed) {
      _clientInitFailed = true;
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[zone-embed-skipped]", { reason: "client_init_failed", detail: message });
    }
    return null;
  }

  if (client.provider !== "openai") {
    if (!_embedSkipLoggedProviders.has(client.provider)) {
      _embedSkipLoggedProviders.add(client.provider);
      console.warn(
        `[zone-embed] provider=${client.provider} has no embedding support — skipping all subsequent embed requests silently`
      );
    }
    return null;
  }

  try {
    const response = await Promise.race([
      client.createEmbedding({
        model: EMBEDDING_MODEL,
        input: truncated,
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Embedding request timed out after ${EMBED_TIMEOUT_MS}ms`));
        }, EMBED_TIMEOUT_MS);
      }),
    ]);
    const embedding = Array.isArray(response.data?.[0]?.embedding)
      ? response.data[0].embedding
      : null;

    if (!embedding || embedding.length === 0) {
      throw new Error("Embedding API returned no embedding vector.");
    }

    debugLog("[zone-embed-debug]", {
      textLength: truncated.length,
      tokensApprox,
      elapsedMs: Date.now() - startedAt,
    });

    return embedding;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not supported by the Anthropic provider")) {
      // Already logged at provider-check above; stay silent here.
      return null;
    }
    if (message.includes("timed out")) {
      errorLog("[zone-embed-timeout]", {
        textLength: truncated.length,
        tokensApprox,
        elapsedMs: Date.now() - startedAt,
        stage: "embedText",
      });
    }
    errorLog("[zone-embed-error]", {
      textLength: truncated.length,
      tokensApprox,
      elapsedMs: Date.now() - startedAt,
      error: message,
    });
    throw error;
  }
}
