import OpenAI from "openai";
import { withExponentialBackoff } from "./withExponentialBackoff.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { LLMClient, LLMProvider, LLMRequestOptions } from "./types.js";
import { supportsEffort, resolveEffortForModel, normalizeModelId } from "./modelRegistry.js";
import { responsesConvertParams } from "./openaiAdapter/responsesConvertParams.js";
import { responsesConvertResponse } from "./openaiAdapter/responsesConvertResponse.js";
import {
  MIN_REQUEST_TIMEOUT_MS,
  deriveRequestTimeoutMs,
  zoneDispatcher,
} from "./requestTimeouts.js";

export class OpenAIAdapter implements LLMClient {
  readonly provider: LLMProvider;
  private readonly sdk: OpenAI;

  constructor(apiKey: string, baseUrl?: string, provider: LLMProvider = "openai") {
    // maxRetries:0 disables the SDK's built-in retry so Zone's own
    // withExponentialBackoff controls all retry timing and budget.
    //
    // timeout is a FLOOR, not the operative value: the two non-streaming paths below pass a
    // per-request timeout derived from their own output budget.
    //
    // The dispatcher is load-bearing and was the whole of ledger item 57's real finding. The SDK
    // clears its own timer as soon as `fetch` resolves, and for a non-streaming request no bytes
    // arrive until generation completes — so undici's `headersTimeout` is what actually bounds the
    // call. Without a dispatcher that is the global Agent's 300s default, which cut every OpenAI
    // generation at 5 minutes: HALF the SDK's configured 600s, and 1/12th of what a 128k-token
    // gpt-5.x request can legitimately need. Same defect anthropicAdapter.ts already fixes.
    this.sdk = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      maxRetries: 0,
      timeout: MIN_REQUEST_TIMEOUT_MS,
      fetchOptions: { dispatcher: zoneDispatcher },
    });
    this.provider = provider;
  }

  async createChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming,
    options: LLMRequestOptions = {}
  ): Promise<ChatCompletion> {
    if (this.provider === "openai" && normalizeModelId(params.model).startsWith("gpt-5")) {
      const body = responsesConvertParams(params, { effort: options.effort, capabilities: options.capabilities });
      const resp = await withExponentialBackoff(
        () =>
          this.sdk.responses.create(body, {
            signal: options.signal,
            timeout: deriveRequestTimeoutMs(body.max_output_tokens ?? undefined),
          }),
        { provider: this.provider, model: params.model, emit: options.onRetryEvent }
      );
      return responsesConvertResponse(resp);
    }
    const resolvedEffort = resolveEffortForModel(params.model, options.effort, options.capabilities);
    // OpenAI reasoning_effort only supports "low"|"medium"|"high"; xhigh/max are narrowed to "high".
    const reasoningEffort =
      resolvedEffort === "xhigh" || resolvedEffort === "max" ? "high" : resolvedEffort;
    const withEffort: ChatCompletionCreateParamsNonStreaming =
      reasoningEffort && supportsEffort(params.model, options.capabilities)
        ? { ...params, reasoning_effort: reasoningEffort }
        : params;
    // gpt-5.x reasoning models reject `max_tokens`; translate to `max_completion_tokens`
    // so call-sites can use the conventional spelling — mirrors Anthropic's convertParams.
    const { max_tokens, ...rest } = withEffort;
    const resolvedParams: ChatCompletionCreateParamsNonStreaming = {
      ...rest,
      ...(typeof max_tokens === "number" && rest.max_completion_tokens == null
          ? { max_completion_tokens: max_tokens }
          : max_tokens != null ? { max_tokens } : {}),
    };
    return withExponentialBackoff(
      () =>
        this.sdk.chat.completions.create(resolvedParams, {
          signal: options.signal,
          timeout: deriveRequestTimeoutMs(
            resolvedParams.max_completion_tokens ?? resolvedParams.max_tokens ?? undefined
          ),
        }),
      { provider: this.provider, model: params.model, emit: options.onRetryEvent }
    );
  }

  async createChatCompletionStream(
    params: ChatCompletionCreateParamsStreaming,
    options: LLMRequestOptions = {}
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    if (this.provider === "openai" && normalizeModelId(params.model).startsWith("gpt-5")) {
      throw new Error("Responses streaming is deferred to S6; gpt-5.x cannot use the streaming path yet.");
    }
    const { max_tokens, ...rest } = params;
    const resolvedParams: ChatCompletionCreateParamsStreaming = {
      ...rest,
      ...(typeof max_tokens === "number" && rest.max_completion_tokens == null
          ? { max_completion_tokens: max_tokens }
          : max_tokens != null ? { max_tokens } : {}),
    };
    // Deliberately left on the constructor floor rather than given a derived per-request timeout.
    // On a streaming request the SDK timer covers time-to-first-token only, for which 600s is
    // already generous; a budget-derived value (up to 60 min at 128k) would bound nothing useful.
    // The dispatcher still applies, so undici no longer cuts this path at 300s either.
    //
    // Also add retry parity with the sync path (stream creation is the retryable part;
    // mid-stream errors remain the consumer's responsibility).
    return withExponentialBackoff(
      () => this.sdk.chat.completions.create(resolvedParams, { signal: options.signal }),
      { provider: this.provider, model: params.model, emit: options.onRetryEvent }
    ) as Promise<AsyncIterable<ChatCompletionChunk>>;
  }

  async createEmbedding(
    params: {
      model: string;
      input: string | string[];
    },
    options: LLMRequestOptions = {}
  ): Promise<{ data: { embedding: number[] }[] }> {
    // Deliberately left on the constructor floor: an embedding call has no generation phase, so
    // its duration is not a function of any output budget and the derivation would not apply.
    const response = await this.sdk.embeddings.create(params, {
      signal: options.signal,
    });
    return { data: response.data };
  }
}
