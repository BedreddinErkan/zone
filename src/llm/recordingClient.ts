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
import { profileForProvider, type ProviderProfile } from "./providerProfile.js";

interface UsageBreakdown {
  input_uncached: number;
  cache_write: number;
  cache_read: number;
  output: number;
  output_reasoning: number;
  webSearchRequests: number;
}

/** Fires once per process — a partition violation is structural, not per-request,
 *  and extractUsage has no model id to key a finer dedupe on. */
let usagePartitionViolationWarned = false;

/** Test-only: clear the partition-violation warning dedupe. */
export function _resetUsagePartitionWarningForTest(): void {
  usagePartitionViolationWarned = false;
}

export function extractUsage(rawUsage: unknown): UsageBreakdown | null {
  if (!rawUsage || typeof rawUsage !== "object") return null;
  const u = rawUsage as Record<string, unknown>;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const promptTokenDetails =
    u.prompt_tokens_details && typeof u.prompt_tokens_details === "object"
      ? (u.prompt_tokens_details as Record<string, unknown>)
      : null;
  // OpenAI reports its cache buckets inside prompt_tokens_details; Anthropic reports
  // them as top-level fields. Read OpenAI first, Anthropic as fallback, for both.
  const openAiCacheRead = Number(promptTokenDetails?.cached_tokens ?? 0) || 0;
  const openAiCacheWrite = Number(promptTokenDetails?.cache_write_tokens ?? 0) || 0;
  const cacheRead = openAiCacheRead || Number(u.cache_read_input_tokens ?? 0) || 0;
  const cacheWrite = openAiCacheWrite || Number(u.cache_creation_input_tokens ?? 0) || 0;
  if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0) {
    return null;
  }
  // Provider discriminator, not a mere guard: OpenAI's input_tokens is a TOTAL that
  // contains its cache buckets, so they are carved out of it; Anthropic's already
  // excludes them, so its branch must not subtract. Both OpenAI buckets are removed
  // — subtracting only the read side would bill a first-call cache write twice, once
  // inside input_uncached at the input rate and again at the cache-write rate.
  const openAiCachedPortion = openAiCacheRead + openAiCacheWrite;
  const rawUncached = input - openAiCachedPortion;
  if (openAiCachedPortion > 0 && rawUncached < 0 && !usagePartitionViolationWarned) {
    // Negative means the buckets are NOT a subset of input_tokens — an assumption
    // this code depends on. Clamping alone would bury the disproof, so say it first.
    usagePartitionViolationWarned = true;
    console.warn(
      "[zone-usage-partition-violated]",
      JSON.stringify({
        input,
        cacheRead: openAiCacheRead,
        cacheWrite: openAiCacheWrite,
        shortfall: -rawUncached,
        impact:
          "cache buckets exceed input_tokens, so they are reported additively rather " +
          "than as a subset; input_uncached is being clamped to 0 and cost is under-reported",
        rawUsage: u,
      })
    );
  }
  const inputUncached = openAiCachedPortion > 0 ? Math.max(0, rawUncached) : input;
  const completionTokenDetails =
    u.completion_tokens_details && typeof u.completion_tokens_details === "object"
      ? (u.completion_tokens_details as Record<string, unknown>)
      : null;
  const outputReasoning = Number(completionTokenDetails?.reasoning_tokens ?? 0) || 0;
  const webSearchRequests = Number(u.web_search_requests ?? 0) || 0;
  return {
    input_uncached: inputUncached,
    cache_write: cacheWrite,
    cache_read: cacheRead,
    output,
    output_reasoning: outputReasoning,
    webSearchRequests,
  };
}

// Centralized post-call hook. Reads usage from the response (works for both
// OpenAI Chat Completions usage shape and the Anthropic adapter's translated
// shape that adds cache_creation_input_tokens / cache_read_input_tokens).
//
// Takes the run's resolved ProviderProfile rather than a provider string: the pricing table now
// comes from `profile.pricing`, which is what replaced the old `toProviderName` if-return. That
// helper existed only because `LLMProvider` and `ProviderName` were separate declarations of the
// same two-value union, and it is deleted rather than rewired.
async function recordFromResponse(
  profile: ProviderProfile,
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
    // The unpriceable signal rides INSIDE the record. It is deliberately not a second positional
    // argument to recordExecution: two pinned tests assert that call with
    // `toHaveBeenCalledWith(expect.objectContaining(...))`, which compares the whole args array,
    // so an arity change breaks them while an extra object key does not.
    await recordExecution({
      userId,
      runId,
      subagentId,
      subagentType,
      parentRunId,
      provider: (profile.pricing?.table ?? profile.adapterProvider) as ProviderName,
      model: responseModel || fallbackModel,
      ...usage,
      ...(profile.pricing ? {} : { unpriceable: true as const }),
    });
  } catch (err) {
    // Best-effort: a recording failure must never fail the actual LLM call.
    console.warn("[zone-usage] recordFromResponse failed", err);
  }
}

export class RecordingLLMClient implements LLMClient {
  readonly provider: LLMProvider;
  private readonly inner: LLMClient;
  private readonly profile: ProviderProfile;

  /**
   * `profile` is optional and defaults to the built-in matching `inner.provider`, so every
   * existing one-argument construction keeps working unchanged (providerProfile.ts's R9 — this is
   * the one rewired site whose default is derived rather than a literal).
   */
  constructor(inner: LLMClient, profile?: ProviderProfile) {
    this.inner = inner;
    this.provider = inner.provider;
    this.profile = profile ?? profileForProvider(inner.provider);
  }

  async createChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming,
    options: LLMRequestOptions = {}
  ): Promise<ChatCompletion> {
    const response = await this.inner.createChatCompletion(params, options);
    await recordFromResponse(
      this.profile,
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
    // Gated on the PROTOCOL, not the vendor. The investigation's harness section established that
    // this gate is protocol-shaped ("recordingClient.ts gates include_usage on
    // provider === 'openai'; that gate is protocol-shaped, not vendor-shaped"), and reading the
    // profile's protocol is what makes it correct for an openai-chat endpoint that is not OpenAI.
    // Behaviour is identical for both built-ins, whose protocol and vendor agree.
    const augmented: ChatCompletionCreateParamsStreaming =
      this.profile.protocol === "openai-chat"
        ? {
            ...params,
            stream_options: {
              ...(params.stream_options ?? {}),
              include_usage: true,
            },
          }
        : params;
    const baseStream = await this.inner.createChatCompletionStream(augmented, options);
    const profile = this.profile;
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
          await recordFromResponse(profile, fallbackModel, lastUsage, lastModel);
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
