import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";

export type LLMProvider = "openai" | "anthropic";

export type LLMChatParams =
  | ChatCompletionCreateParamsNonStreaming
  | ChatCompletionCreateParamsStreaming;

export interface LLMRequestOptions {
  /** Abort the in-flight request when this signal fires. */
  signal?: AbortSignal;
  /**
   * When provided the Anthropic adapter streams the response internally and
   * fires this callback for every tool-argument fragment (input_json_delta)
   * it receives. Ignored by providers that don't support streaming deltas.
   */
  onToolArgumentsDelta?: (toolCallId: string, toolName: string, argDelta: string) => void;
}

export interface LLMClient {
  readonly provider: LLMProvider;

  createChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming,
    options?: LLMRequestOptions
  ): Promise<ChatCompletion>;

  createChatCompletionStream(
    params: ChatCompletionCreateParamsStreaming,
    options?: LLMRequestOptions
  ): Promise<AsyncIterable<ChatCompletionChunk>>;

  createEmbedding(
    params: {
      model: string;
      input: string | string[];
    },
    options?: LLMRequestOptions
  ): Promise<{ data: { embedding: number[] }[] }>;
}

export interface LLMClientResolveOptions {
  provider?: LLMProvider;
  apiKey?: string;
  model?: string;
}
