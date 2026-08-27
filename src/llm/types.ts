import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { EffortLevel } from "./modelRegistry.js";
// Type-only, and deliberately so: erased at compile time, so no runtime edge is created back into
// providerProfile.ts and its import-leaf rule (R1) is unaffected.
import type { ProviderProfile } from "./providerProfile.js";

export type LLMProvider = "openai" | "anthropic";
export type { EffortLevel };

/**
 * What ONE MODEL served by a provider profile supports — its context window, output ceiling, cache
 * minimum, effort ladder and thinking style.
 *
 * NAMING HAZARD, stated because a grep lands on the wrong one otherwise. This is NOT
 * `src/tools/capabilities.ts`'s `Capability`, which is what a TOOL may do (`fs.read`, `fs.write`,
 * `shell.exec`, `net.fetch`, …) and gates which tools an agent loop may call. Same English word,
 * unrelated concepts, and the two never appear in the same expression. See ledger item 393.
 *
 * Lives here rather than in `providerProfile.ts` for two reasons: `LLMRequestOptions` below needs
 * it, and `providerProfile.ts` already type-imports this module — defining it there would make a
 * type-only import cycle and would sit awkwardly against that module's import-leaf rule (R1).
 *
 * Every field is optional. An absent field means "this profile says nothing about it", and the
 * caller falls through to the global per-model tables exactly as before — the resolution order is
 * always profile override → global table → conservative default, never a merge.
 */
export interface ModelCapabilities {
  /** Tokens the model accepts in context. Overrides `MODEL_CONTEXT_WINDOWS`. */
  contextWindow?: number;
  /** Ceiling for `max_tokens`. Overrides `MODEL_MAX_OUTPUT_TOKENS`. */
  maxOutputTokens?: number;
  /** Smallest prompt worth a cache breakpoint, in characters. Overrides `MODEL_CACHE_MIN_CHARS`. */
  cacheMinChars?: number;
  /**
   * Effort levels this model accepts, weakest first. An empty array means "no effort", which is a
   * different statement from omitting the field (omitted = defer to the global tables).
   */
  effortLevels?: readonly EffortLevel[];
  /** True when the model takes an adaptive `effort` rather than an explicit thinking budget. */
  adaptiveThinking?: boolean;
  /**
   * Whether the model accepts image input. DECLARED BUT NOT YET CONSUMED: the only reader of vision
   * support is the TUI composer, which has no profile in scope. Recorded in ledger item 394
   * together with the reason the global default cannot be corrected without that same TUI change.
   */
  supportsVision?: boolean;
}

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
   * When provided the Anthropic adapter fires this callback for every assistant-text
   * fragment it accumulates into textAccum while streaming. Anthropic only — the OpenAI
   * adapter never reads this option, matching onToolArgumentsDelta's own precedent.
   */
  onTextDelta?: (fragment: string) => void;
  /**
   * Y.1.6.3/Y.1.6.4: receives retry lifecycle events emitted by
   * withExponentialBackoff (zone_llm_retry_started, llm_retry_in_progress).
   * Threaded from agentLoop so the caller can emit SSE narration and write
   * per-run retry telemetry without coupling the adapter to the run context.
   */
  onRetryEvent?: (event: string, payload: Record<string, unknown>) => void;
  /** TUI.7.G: user-selected reasoning effort level; applied by each adapter when the model supports it. */
  effort?: EffortLevel;
  /**
   * Per-call capability overrides for `params.model`, resolved from the run's provider profile.
   *
   * This is the seam by which a profile reaches the adapter layer. It is per-call rather than a
   * constructor argument deliberately: both adapter constructors have their argument lists pinned
   * by assertions in `factory.test.ts`, and this field's shape matches the sibling `effort` /
   * `webSearch` options already threaded the same way. Absent on every existing caller, so the
   * global tables answer exactly as before.
   */
  capabilities?: ModelCapabilities;
  /** When true (Anthropic only), the provider runs a server-side web search during generation. Max 3 searches per turn. */
  webSearch?: boolean;
}

export interface LLMClient {
  readonly provider: LLMProvider;

  /**
   * The endpoint identity behind `provider`'s protocol selector, when the client was built from a
   * profile. Optional so that the many hand-built `LLMClient` object literals in the test suite
   * still satisfy this interface unchanged.
   *
   * `RecordingLLMClient` — which `createLLMClient` always returns — has held this since step 3 and
   * merely exposes it now, so no construction site changed to make it reachable. It exists on the
   * interface so a call site holding a plain `LLMClient` can pass it to `getModelName`.
   */
  readonly profile?: ProviderProfile;

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
  /**
   * An already-resolved provider profile, used verbatim instead of resolving one from `provider`.
   *
   * The seam by which a profile that is not one of the two built-ins reaches the client — including
   * a profile with no pricing table, which is what makes the no-pricing warning reachable at all.
   * The import below is type-only and therefore erased, so it creates no runtime module edge and
   * leaves `providerProfile.ts`'s import-leaf rule (R1) untouched.
   */
  profile?: ProviderProfile;
}
