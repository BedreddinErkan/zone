import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { EffortLevel } from "./modelRegistry.js";

export type LLMProvider = "openai" | "anthropic";
export type { EffortLevel };

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
  /**
   * Y.1.6.3/Y.1.6.4: receives retry lifecycle events emitted by
   * withExponentialBackoff (zone_llm_retry_started, llm_retry_in_progress).
   * Threaded from agentLoop so the caller can emit SSE narration and write
   * per-run retry telemetry without coupling the adapter to the run context.
   */
  onRetryEvent?: (event: string, payload: Record<string, unknown>) => void;
  /** TUI.7.G: user-selected reasoning effort level; applied by each adapter when the model supports it. */
  effort?: EffortLevel;
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
