import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { LLMClient, LLMProvider, LLMRequestOptions } from "./types.js";
import { getRequestContext } from "./openaiContext.js";
import { recordExecution } from "../usage/usageTracker.js";
import type { ProviderName } from "../usage/pricing.js";

interface UsageBreakdown {
  input_uncached: number;
  cache_write: number;
  cache_read: number;
  output: number;
}

export function extractUsage(rawUsage: unknown): UsageBreakdown | null {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const u = rawUsage as Record<string, unknown>;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const cacheWrite = Number(u.cache_creation_input_tokens ?? 0) || 0;
  const promptTokenDetails =
    u.prompt_tokens_details && typeof u.prompt_tokens_details === "object"
      ? (u.prompt_tokens_details as Record<string, unknown>)
      : null;
  const openAiCacheRead = Number(promptTokenDetails?.cached_tokens ?? 0) || 0;
  const cacheRead = openAiCacheRead || Number(u.cache_read_input_tokens ?? 0) || 0;
  if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0) {
    return null;
  }
  const inputUncached = openAiCacheRead > 0 ? Math.max(0, input - openAiCacheRead) : input;
  return {
    input_uncached: inputUncached,
    cache_write: cacheWrite,
    cache_read: cacheRead,
    output,
  };
}

function toProviderName(provider: LLMProvider): ProviderName {
  return provider === "anthropic" ? "anthropic" : "openai";
}

// Centralized post-call hook. Reads usage from the response (works for both
// OpenAI Chat Completions usage shape and the Anthropic adapter's translated
// shape that adds cache_creation_input_tokens / cache_read_input_tokens).
async function recordFromResponse(
  provider: LLMProvider,
  fallbackModel: string,
  rawUsage: unknown,
  responseModel: string | undefined
): Promise<void> {
  try {
    const usage = extractUsage(rawUsage);
    if (!usage) return;
    const ctx = getRequestContext();
    const userId = ctx?.userId?.trim() || "local-dev";
    const runId = ctx?.runId?.trim() || "";
    const subagentId = ctx?.subagentId?.trim() || undefined;
    const subagentType = ctx?.subagentType;
    const parentRunId = ctx?.parentRunId?.trim() || undefined;
    await recordExecution({
      userId,
      runId,
      subagentId,
      subagentType,
      parentRunId,
      provider: toProviderName(provider),
      model: responseModel || fallbackModel,
      ...usage,
    });
  } catch (err) {
    // Best-effort: a recording failure must never fail the actual LLM call.
    console.warn("[zone-usage] recordFromResponse failed", err);
  }
}

export class RecordingLLMClient implements LLMClient {
  readonly provider: LLMProvider;
  private readonly inner: LLMClient;

  constructor(inner: LLMClient) {
    this.inner = inner;
    this.provider = inner.provider;
  }

  async createChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming,
    options: LLMRequestOptions = {}
  ): Promise<ChatCompletion> {
    const response = await this.inner.createChatCompletion(params, options);
    await recordFromResponse(
      this.provider,
      String(params.model || ""),
      (response as { usage?: unknown }).usage,
      response.model
    );
    return response;
  }

  async createChatCompletionStream(
    params: ChatCompletionCreateParamsStreaming,
    options: LLMRequestOptions = {}
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    // For OpenAI, opt into final-chunk usage. The Anthropic adapter emits a
    // synthetic final chunk with `usage` already populated (see convertStream).
    const augmented: ChatCompletionCreateParamsStreaming =
      this.provider === "openai"
        ? {
            ...params,
            stream_options: {
              ...(params.stream_options ?? {}),
              include_usage: true,
            },
          }
        : params;
    const baseStream = await this.inner.createChatCompletionStream(augmented, options);
    const provider = this.provider;
    const fallbackModel = String(params.model || "");

    async function* wrapped(): AsyncGenerator<ChatCompletionChunk, void, unknown> {
      let lastUsage: unknown = null;
      let lastModel: string | undefined;
      try {
        for await (const chunk of baseStream) {
          if ((chunk as { usage?: unknown }).usage) {
            lastUsage = (chunk as { usage?: unknown }).usage;
            lastModel = chunk.model || lastModel;
          } else if (chunk.model && !lastModel) {
            lastModel = chunk.model;
          }
          yield chunk;
        }
      } finally {
        if (lastUsage) {
          await recordFromResponse(provider, fallbackModel, lastUsage, lastModel);
        }
      }
    }
    return wrapped();
  }

  createEmbedding(
    params: { model: string; input: string | string[] },
    options: LLMRequestOptions = {}
  ): Promise<{ data: { embedding: number[] }[] }> {
    // Embeddings are not in pricing.ts; pass through without recording.
    return this.inner.createEmbedding(params, options);
  }
}
