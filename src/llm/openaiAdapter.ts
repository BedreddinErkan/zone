import OpenAI from "openai";
import { withExponentialBackoff } from "./withExponentialBackoff.js";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { LLMClient, LLMRequestOptions } from "./types.js";

export class OpenAIAdapter implements LLMClient {
  readonly provider = "openai" as const;
  private readonly sdk: OpenAI;

  constructor(apiKey: string) {
    // maxRetries:0 disables the SDK's built-in retry so Zone's own
    // withExponentialBackoff controls all retry timing and budget.
    this.sdk = new OpenAI({ apiKey, maxRetries: 0 });
  }

  async createChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming,
    options: LLMRequestOptions = {}
  ): Promise<ChatCompletion> {
    return withExponentialBackoff(
      () => this.sdk.chat.completions.create(params, { signal: options.signal }),
      { provider: "openai", model: params.model }
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
