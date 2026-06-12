import Anthropic, { BadRequestError } from "@anthropic-ai/sdk";
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
    const isRetention =
      /retention/i.test(fullMsg) ||
      /zero.data.retention/i.test(fullMsg) ||
      /\bzdr\b/i.test(fullMsg);
    const kind: "retention" | "request_shape" | "other" = isRetention
      ? "retention"
      : err.type === "invalid_request_error"
        ? "request_shape"
        : "other";
    const userMessage = isRetention
      ? "Claude Fable 5 requires 30-day data retention and isn't available for accounts configured for zero data retention (ZDR) or shorter retention. Set your Anthropic account's data-retention to ≥30 days, or switch models with /model (e.g. Claude Opus 4.8)."
      : `Invalid API request (${fullMsg}). Check model and parameter configuration.`;
    throw new ProviderRequestError(400, kind, userMessage, err);
  }
  throw err;
}

export class AnthropicAdapter implements LLMClient {
  readonly provider = "anthropic" as const;
  private readonly sdk: Anthropic;

  constructor(apiKey: string) {
    // agent-loop-stability Tur: SDK default timeout (~100s) was killing long
    // agent investigations mid-iteration. 10 minutes covers the worst-case
    // multi-step build-fix flow (15 iters × ~30s/iter = 7.5 min, with slack).
    // maxRetries:0 disables the SDK's built-in retry so Zone's own
    // withExponentialBackoff controls all retry timing and budget.
    this.sdk = new Anthropic({
      apiKey,
      timeout: 600_000,
      maxRetries: 0,
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
      const message = await withExponentialBackoff(
        () => this.sdk.messages.create({ ...anthropicParams, stream: false }, { signal: options.signal }),
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
          { signal: options.signal }
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
      // Streaming retries exhausted — fall back to non-streaming using already-converted params.
      const wasJsonMode = params.response_format?.type === "json_object";
      const message = await withExponentialBackoff(
        () => this.sdk.messages.create({ ...anthropicParams, stream: false }, { signal: options.signal }),
        backoffCtx
      );
      return convertResponse(message, { wasJsonMode });
    }
  }

  async createChatCompletionStream(
    params: ChatCompletionCreateParamsStreaming,
    options: LLMRequestOptions = {}
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const { params: anthropicParams, warnings } = convertParams(params, { webSearch: options.webSearch });
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
