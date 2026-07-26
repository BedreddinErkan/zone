import Anthropic, { BadRequestError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { Agent } from "undici";
import { withExponentialBackoff, UpstreamUnavailableError } from "./withExponentialBackoff.js";
import { ProviderRequestError } from "./factory.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type { LLMClient, LLMRequestOptions } from "./types.js";
import { convertParams } from "./anthropicAdapter/convertParams.js";
import { convertResponse } from "./anthropicAdapter/convertResponse.js";
import { convertStream } from "./anthropicAdapter/convertStream.js";

// ── Request duration ─────────────────────────────────────────────────────────
//
// A non-streaming request holds one connection for the whole generation with no
// bytes coming back, so how long it may take is a function of how much output it
// may produce. Anthropic's own SDK models that as 128k output tokens ≈ 60 minutes
// (client.js calculateNonstreamingTimeout) — reuse the vendor's number rather than
// inventing one.

/** Vendor's implied generation cost per unit of output budget: 60 min / 128k tokens. */
const VENDOR_MS_PER_MAX_TOKEN = (60 * 60 * 1000) / 128_000;

/**
 * The vendor figure is an ESTIMATE the SDK uses as a threshold ("is this long
 * enough that you should be streaming?"), not a deadline. Used raw it would abort a
 * request that actually fills its budget at exactly its expected completion time.
 * Doubling turns the estimate into a deadline a full-budget request clears.
 */
const REQUEST_TIMEOUT_MARGIN = 2;

/** Floor: the SDK's own DEFAULT_TIMEOUT, so small requests behave exactly as before. */
const MIN_REQUEST_TIMEOUT_MS = 600_000;

/** Ceiling: the SDK's own maxTime for a single request.
 *  Budgets above ~64k land here rather than getting the full margin, which is
 *  acceptable — the vendor's implied ~35 tokens/sec is conservative against observed
 *  rates, so 60 minutes still carries real headroom at 128k. */
const MAX_REQUEST_TIMEOUT_MS = 3_600_000;

/**
 * Per-request timeout for a given output budget.
 * Exported for tests: the relationship to TRANSPORT_TIMEOUT_MS is the property that
 * matters, so it is asserted by sweeping this function rather than by comparing
 * literals.
 */
export function deriveRequestTimeoutMs(maxTokens: number | undefined): number {
  const budget = typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 0;
  const expected = Math.ceil(budget * VENDOR_MS_PER_MAX_TOKEN * REQUEST_TIMEOUT_MARGIN);
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, expected));
}

/**
 * Transport ceiling, kept strictly above every derivable request timeout so the
 * SDK's AbortController is the single authority and undici never cuts first.
 *
 * undici defaults both timers to 300s. For a non-streaming request `headersTimeout`
 * is a hard, non-refreshing deadline covering the entire generation — which made the
 * real ceiling 5 minutes, half of what the SDK was configured for. Deliberately not
 * 0: disabling the timers would let a genuinely dead connection hang for the full
 * SDK timeout, so the transport keeps a backstop that simply never fires first.
 */
export const TRANSPORT_TIMEOUT_MS = MAX_REQUEST_TIMEOUT_MS + 5 * 60 * 1000;

/** Shared across clients: one connection pool per process, not one per adapter. */
const zoneDispatcher = new Agent({
  headersTimeout: TRANSPORT_TIMEOUT_MS,
  bodyTimeout: TRANSPORT_TIMEOUT_MS,
});

/** True when `err` is (or wraps) a request timeout rather than a transport failure. */
export function isTimeoutError(err: unknown): boolean {
  if (err instanceof APIConnectionTimeoutError) return true;
  if (err instanceof UpstreamUnavailableError) return isTimeoutError(err.cause);
  return false;
}

/**
 * Maps a raw Anthropic SDK BadRequestError (HTTP 400) to a ProviderRequestError with a
 * user-facing message. Rethrows everything else unchanged.
 *
 * SDK body shape: {"type":"error","error":{"type":"invalid_request_error","message":"..."}}
 * err.error = the full body; err.error.error.message = the actual message.
 * err.type = SDK convenience property for the inner error.error.type.
 */
export function mapAnthropicBadRequest(err: unknown): never {
  if (err instanceof BadRequestError && err.status === 400) {
    const bodyMsg = (err.error as { error?: { message?: string } } | null)?.error?.message ?? "";
    const fullMsg = bodyMsg || err.message;
    const isCredit = /credit balance is too low/i.test(fullMsg);
    const isRetention =
      /retention/i.test(fullMsg) ||
      /zero.data.retention/i.test(fullMsg) ||
      /\bzdr\b/i.test(fullMsg);
    const kind: "retention" | "credit" | "request_shape" | "other" = isCredit
      ? "credit"
      : isRetention
        ? "retention"
        : err.type === "invalid_request_error"
          ? "request_shape"
          : "other";
    const userMessage = isCredit
      ? "API credit exhausted — your Anthropic credit balance is too low. Top up at console.anthropic.com (Plans & Billing), then retry. You can also switch model/provider with /model."
      : isRetention
        ? "This model requires 30-day minimum data retention and isn't available for accounts configured for zero data retention (ZDR) or shorter retention. Adjust your Anthropic account's data-retention policy or switch models with /model."
        : `Invalid API request (${fullMsg}). Check model and parameter configuration.`;
    throw new ProviderRequestError(400, kind, userMessage, err);
  }
  throw err;
}

export class AnthropicAdapter implements LLMClient {
  readonly provider = "anthropic" as const;
  private readonly sdk: Anthropic;

  constructor(apiKey: string) {
    // timeout here is a FLOOR, not the operative value: every call passes a
    // per-request timeout derived from its own output budget. It must stay a
    // positive number regardless — the SDK's "streaming is required for long
    // operations" guard runs only when the constructor timeout is null
    // (messages.js), and Zone depends on that guard staying skipped.
    // maxRetries:0 disables the SDK's built-in retry so Zone's own
    // withExponentialBackoff controls all retry timing and budget.
    this.sdk = new Anthropic({
      apiKey,
      timeout: MIN_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      // Without a dispatcher the SDK uses the global undici, whose 300s timers cut a
      // non-streaming generation off at 5 minutes — half what the SDK was set to.
      fetchOptions: { dispatcher: zoneDispatcher },
    });
  }

  async createChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming,
    options: LLMRequestOptions = {}
  ): Promise<ChatCompletion> {
    try {
      if (options.onToolArgumentsDelta) {
        // await required: without it a streaming-path rejection bypasses this try/catch
        return await this._streamWithToolCallbacks(params, options);
      }
      const wasJsonMode =
        params.response_format?.type === "json_object";
      const { params: anthropicParams, warnings } = convertParams(params, { effort: options.effort, webSearch: options.webSearch });
      if (warnings.length > 0) {
        for (const w of warnings) console.warn(`[zone-anthropic] ${w}`);
      }
      const timeout = deriveRequestTimeoutMs(anthropicParams.max_tokens);
      const message = await withExponentialBackoff(
        () => this.sdk.messages.create(
          { ...anthropicParams, stream: false },
          { signal: options.signal, timeout }
        ),
        { provider: "anthropic", model: params.model, emit: options.onRetryEvent }
      );
      return convertResponse(message, { wasJsonMode });
    } catch (err) {
      mapAnthropicBadRequest(err);
    }
  }

  private async _streamWithToolCallbacks(
    params: ChatCompletionCreateParamsNonStreaming,
    options: LLMRequestOptions
  ): Promise<ChatCompletion> {
    const { params: anthropicParams, warnings } = convertParams(params, { effort: options.effort, webSearch: options.webSearch });
    if (warnings.length > 0) {
      for (const w of warnings) console.warn(`[zone-anthropic] ${w}`);
    }

    const backoffCtx = { provider: "anthropic" as const, model: params.model, emit: options.onRetryEvent };

    try {
      return await withExponentialBackoff(async () => {
        const stream = this.sdk.messages.stream(
          { ...anthropicParams },
          { signal: options.signal, timeout: deriveRequestTimeoutMs(anthropicParams.max_tokens) }
        );

        let responseId = "";
        let responseModel = "";
        let textAccum = "";
        let finishReason: ChatCompletion.Choice["finish_reason"] = "stop";
        const toolsByIndex = new Map<number, { id: string; name: string; argsAccum: string }>();
        let usagePrompt = 0;
        let usageCompletion = 0;
        let usageCacheWrite = 0;
        let usageCacheRead = 0;
        let usageWebSearchRequests = 0;

        for await (const chunk of convertStream(stream)) {
          if (!responseId && chunk.id) responseId = chunk.id;
          if (!responseModel && chunk.model) responseModel = chunk.model;

          // Synthetic usage chunk (empty choices array)
          if (chunk.choices.length === 0) {
            const u = (chunk as { usage?: Record<string, number> }).usage;
            if (u) {
              usagePrompt = u.prompt_tokens ?? usagePrompt;
              usageCompletion = u.completion_tokens ?? usageCompletion;
              usageCacheWrite = u.cache_creation_input_tokens ?? usageCacheWrite;
              usageCacheRead = u.cache_read_input_tokens ?? usageCacheRead;
              usageWebSearchRequests = Math.max(usageWebSearchRequests, u.web_search_requests ?? 0);
            }
            continue;
          }

          const choice = chunk.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta;
          if (!delta) continue;

          if (typeof delta.content === "string" && delta.content) {
            textAccum += delta.content;
          }

          const tcArr = (delta as { tool_calls?: Array<{
            index?: number; id?: string; type?: string;
            function?: { name?: string; arguments?: string };
          }> }).tool_calls;
          if (Array.isArray(tcArr)) {
            for (const tc of tcArr) {
              const idx = tc.index ?? 0;
              if (tc.id && tc.function?.name !== undefined) {
                toolsByIndex.set(idx, { id: tc.id, name: tc.function.name ?? "", argsAccum: "" });
              }
              const argFrag = tc.function?.arguments;
              if (typeof argFrag === "string" && argFrag.length > 0) {
                const entry = toolsByIndex.get(idx);
                if (entry) {
                  entry.argsAccum += argFrag;
                  options.onToolArgumentsDelta!(entry.id, entry.name, argFrag);
                }
              }
            }
          }
        }

        let streamReasoningText = "";
        try {
          const finalMsg = await (stream as any).finalMessage?.();
          if (finalMsg && Array.isArray(finalMsg.content)) {
            const parts: string[] = [];
            for (const block of finalMsg.content as Array<{ type: string; thinking?: string }>) {
              if (block.type === "thinking" && typeof block.thinking === "string") {
                parts.push(block.thinking);
              }
            }
            streamReasoningText = parts.join("\n\n").trim();
          }
        } catch { /* fail-soft: SDK version may not expose finalMessage */ }

        const toolCalls: ChatCompletionMessageToolCall[] =
          toolsByIndex.size > 0
            ? [...toolsByIndex.values()].map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.argsAccum },
              }))
            : [];

        const hasToolCalls = toolCalls.length > 0;
        const message: ChatCompletion.Choice["message"] = {
          role: "assistant",
          refusal: null,
          content: hasToolCalls && textAccum.length === 0 ? null : textAccum,
          ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
        };

        return {
          id: responseId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: responseModel,
          choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
          ...(streamReasoningText ? { reasoningText: streamReasoningText } : {}),
          usage: {
            prompt_tokens: usagePrompt,
            completion_tokens: usageCompletion,
            total_tokens: usagePrompt + usageCompletion,
            ...({
              cache_creation_input_tokens: usageCacheWrite,
              cache_read_input_tokens: usageCacheRead,
              web_search_requests: usageWebSearchRequests,
            } as Record<string, number>),
          } as ChatCompletion["usage"],
        };
      }, backoffCtx);
    } catch (err) {
      if (!(err instanceof UpstreamUnavailableError)) throw err;
      // This fallback exists to recover from transport failures — a burst of 5xx or
      // 429s that killed the stream. It must NOT run after a timeout: the request
      // was already too slow, and re-issuing the same output budget without
      // streaming discards the SSE chunks that were the only thing keeping undici's
      // body timer alive. It would double the wait and then fail anyway.
      if (isTimeoutError(err)) throw err;
      // Streaming retries exhausted — fall back to non-streaming using already-converted params.
      const wasJsonMode = params.response_format?.type === "json_object";
      const timeout = deriveRequestTimeoutMs(anthropicParams.max_tokens);
      const message = await withExponentialBackoff(
        () => this.sdk.messages.create(
          { ...anthropicParams, stream: false },
          { signal: options.signal, timeout }
        ),
        backoffCtx
      );
      return convertResponse(message, { wasJsonMode });
    }
  }

  async createChatCompletionStream(
    params: ChatCompletionCreateParamsStreaming,
    options: LLMRequestOptions = {}
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    // effort must be threaded here exactly as the other two entry points do — without
    // it convertParams sees no effort level, so thinking config is silently absent on
    // this path alone.
    const { params: anthropicParams, warnings } = convertParams(params, { effort: options.effort, webSearch: options.webSearch });
    if (warnings.length > 0) {
      for (const w of warnings) console.warn(`[zone-anthropic] ${w}`);
    }
    const stream = this.sdk.messages.stream(
      {
        ...anthropicParams,
      },
      { signal: options.signal }
    );
    return convertStream(stream);
  }

  async createEmbedding(_params: {
    model: string;
    input: string | string[];
  }, _options: LLMRequestOptions = {}): Promise<{ data: { embedding: number[] }[] }> {
    throw new Error(
      "Embeddings are not supported by the Anthropic provider. " +
        "Set OPENAI_API_KEY or provide an OpenAI BYOK header."
    );
  }
}
