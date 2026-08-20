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

/**
 * Both provider converters (anthropicAdapter/convertResponse.ts,
 * openaiAdapter/responsesConvertResponse.ts) attach reasoning text under this one field name.
 * Declaring it here — on LLMClient's own return type, not as a cast at the read site — is what
 * lets a rename on either side fail the build instead of silently reading `undefined` forever:
 * the field name is checked once, at its single declaration, rather than independently at every
 * producer and consumer. `thinkingBlocks` (Anthropic's own replay payload) stays out of this
 * shared type deliberately — it is provider-specific, not part of the generic contract, and the
 * one site that reads it (agentLoop.ts) still casts for it, unchanged.
 */
export type ChatCompletionWithReasoning = ChatCompletion & { reasoningText?: string };

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
  /** When true (Anthropic only), the provider runs a server-side web search during generation. Max 3 searches per turn. */
  webSearch?: boolean;
}

export interface LLMClient {
  readonly provider: LLMProvider;

  createChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming,
    options?: LLMRequestOptions
  ): Promise<ChatCompletionWithReasoning>;

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
