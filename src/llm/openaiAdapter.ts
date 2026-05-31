import OpenAI from "openai";
import { withExponentialBackoff } from "./withExponentialBackoff.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { LLMClient, LLMProvider, LLMRequestOptions } from "./types.js";
import { supportsEffort } from "./modelRegistry.js";

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
    const resolvedParams =
      options.effort && supportsEffort(params.model)
        ? { ...params, reasoning_effort: options.effort }
        : params;
    return withExponentialBackoff(
      () => this.sdk.chat.completions.create(resolvedParams, { signal: options.signal }),
      { provider: this.provider, model: params.model, emit: options.onRetryEvent }
    );
  }

  async createChatCompletionStream(
    params: ChatCompletionCreateParamsStreaming,
    options: LLMRequestOptions = {}
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    return this.sdk.chat.completions.create(params, { signal: options.signal });
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
