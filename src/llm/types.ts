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
 * All three provider producers (anthropicAdapter/convertResponse.ts, anthropicAdapter.ts's
 * streaming path, and openaiAdapter/responsesConvertResponse.ts) attach reasoning text under this
 * one field name, and every one of them builds it through a `Pick<…, "reasoningText">`-typed
 * const rather than an inline conditional spread.
 *
 * That const is the load-bearing part, and an earlier version of this comment got it wrong: it
 * claimed that declaring the field here "lets a rename on either side fail the build." Declaring
 * it here is necessary but not sufficient. TypeScript's excess-property check runs on a literal
 * assigned to a typed target and is bypassed for one merged into a wider object via spread — so
 * while this type was declared and the annotations were correct, renaming the key at either
 * Anthropic producer still passed `tsc` completely clean (confirmed by mutating both, not
 * reasoned). The read site would then have gone `undefined` forever with a green build. The typed
 * const at each producer is what actually closes it; the streaming site additionally needs it
 * because its literal is returned from a generic callback and has no contextual type at all.
 *
 * `thinkingBlocks` (Anthropic's own replay payload) stays out of this shared type deliberately —
 * it is provider-specific, not part of the generic contract, and the one site that reads it
 * (agentLoop.ts) still casts for it, unchanged. It therefore has none of the protection described
 * above, at any of its producers or at its reader.
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
