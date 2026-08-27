import Anthropic, { BadRequestError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { withExponentialBackoff, UpstreamUnavailableError } from "./withExponentialBackoff.js";
import { ProviderRequestError } from "./factory.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type { ChatCompletionWithReasoning, LLMClient, LLMRequestOptions } from "./types.js";
import { convertParams } from "./anthropicAdapter/convertParams.js";
import { convertResponse } from "./anthropicAdapter/convertResponse.js";
import { convertStream } from "./anthropicAdapter/convertStream.js";
import {
  captureThinkingBlocks,
  extractReasoningText,
  type ProviderThinkingBlock,
} from "./anthropicAdapter/thinkingBlocks.js";
import {
  MIN_REQUEST_TIMEOUT_MS,
  TRANSPORT_TIMEOUT_MS,
  deriveRequestTimeoutMs,
  zoneDispatcher,
} from "./requestTimeouts.js";

// Re-exported so every existing import path — and anthropicAdapter.timeout.test.ts — keeps
// resolving here after the move to the shared module (ledger item 57).
export { TRANSPORT_TIMEOUT_MS, deriveRequestTimeoutMs };

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
  ): Promise<ChatCompletionWithReasoning> {
    try {
      // Either callback enters the streaming path. onTextDelta alone must work: it is a
      // separate capability from tool-argument streaming, and gating it on its sibling made it
      // silently inert for any caller that wanted text but not tool args (ledger item 334).
      // The call site below is optional-chained for exactly this reason — see the note there.
      if (options.onToolArgumentsDelta || options.onTextDelta) {
        // await required: without it a streaming-path rejection bypasses this try/catch
        return await this._streamWithToolCallbacks(params, options);
      }
      const wasJsonMode =
        params.response_format?.type === "json_object";
      const { params: anthropicParams, warnings } = convertParams(params, { effort: options.effort, webSearch: options.webSearch, capabilities: options.capabilities });
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
  ): Promise<ChatCompletionWithReasoning> {
    const { params: anthropicParams, warnings } = convertParams(params, { effort: options.effort, webSearch: options.webSearch, capabilities: options.capabilities });
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
            options.onTextDelta?.(delta.content);
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
                  // Optional-chained, not asserted: since the branch above admits an
                  // onTextDelta-only caller, this callback can legitimately be absent while the
                  // model still emits tool-argument fragments. A non-null assertion here threw a
                  // TypeError on the first such fragment.
                  options.onToolArgumentsDelta?.(entry.id, entry.name, argFrag);
                }
              }
            }
          }
        }

        // convertStream classifies thinking as {kind:"ignored"} — the deltas
        // drive the live UI, they are not the artifact. The SDK's own
        // accumulated message is, and it carries the signature the deltas
        // arrive in pieces. Taking blocks from here rather than reassembling
        // thinking_delta + signature_delta is what makes byte-identity a
        // passthrough guarantee instead of a reconstruction one.
        let streamReasoningText = "";
        let streamThinkingBlocks: ProviderThinkingBlock[] = [];
        try {
          const finalMsg = await (stream as { finalMessage?: () => Promise<Anthropic.Message> })
            .finalMessage?.();
          if (finalMsg && Array.isArray(finalMsg.content)) {
            streamThinkingBlocks = captureThinkingBlocks(finalMsg.content);
            streamReasoningText = extractReasoningText(finalMsg.content);
          }
        } catch (err) {
          // Fail-soft: an SDK without finalMessage still streams correctly. But a
          // silent miss here is a silent capability loss — the model stops seeing
          // its own reasoning and nothing says why.
          console.warn(
            "[zone-anthropic] thinking capture unavailable on the streaming path:",
            err instanceof Error ? err.message : String(err)
          );
        }

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

        // Typed const rather than an inline spread, for the same reason convertResponse.ts and
        // responsesConvertResponse.ts use one — and doubly needed here: this literal is returned
        // from a generic callback passed to withExponentialBackoff, so its type is INFERRED from
        // the literal and there is no contextual type to check against at all. The const carries
        // its own target type, so it is checked regardless of what encloses it.
        const reasoningTextField: Pick<ChatCompletionWithReasoning, "reasoningText"> =
          streamReasoningText ? { reasoningText: streamReasoningText } : {};

        return {
          id: responseId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: responseModel,
          choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
          ...reasoningTextField,
          ...(streamThinkingBlocks.length > 0 ? { thinkingBlocks: streamThinkingBlocks } : {}),
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
    const { params: anthropicParams, warnings } = convertParams(params, { effort: options.effort, webSearch: options.webSearch, capabilities: options.capabilities });
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
