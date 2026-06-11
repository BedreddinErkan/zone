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

export class OpenAIAdapter implements LLMClient {
  readonly provider: LLMProvider;
  private readonly sdk: OpenAI;

  constructor(apiKey: string, baseUrl?: string, provider: LLMProvider = "openai") {
    // maxRetries:0 disables the SDK's built-in retry so Zone's own
    // withExponentialBackoff controls all retry timing and budget.
    this.sdk = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0 });
    this.provider = provider;
  }

  async createChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming,
    options: LLMRequestOptions = {}
  ): Promise<ChatCompletion> {
    if (this.provider === "openai" && normalizeModelId(params.model).startsWith("gpt-5")) {
      const body = responsesConvertParams(params, { effort: options.effort });
      const resp = await withExponentialBackoff(
        () => this.sdk.responses.create(body, { signal: options.signal }),
        { provider: this.provider, model: params.model, emit: options.onRetryEvent }
      );
      return responsesConvertResponse(resp);
    }
    const resolvedEffort = resolveEffortForModel(params.model, options.effort);
    // OpenAI reasoning_effort only supports "low"|"medium"|"high"; xhigh/max are narrowed to "high".
    const reasoningEffort =
      resolvedEffort === "xhigh" || resolvedEffort === "max" ? "high" : resolvedEffort;
    const withEffort: ChatCompletionCreateParamsNonStreaming =
      reasoningEffort && supportsEffort(params.model)
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
      () => this.sdk.chat.completions.create(resolvedParams, { signal: options.signal }),
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
    const response = await this.sdk.embeddings.create(params, {
      signal: options.signal,
    });
    return { data: response.data };
  }
}
