import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { LLMClient, LLMRequestOptions } from "./types.js";
import { convertParams } from "./anthropicAdapter/convertParams.js";
import { convertResponse } from "./anthropicAdapter/convertResponse.js";
import { convertStream } from "./anthropicAdapter/convertStream.js";

export class AnthropicAdapter implements LLMClient {
  readonly provider = "anthropic" as const;
  private readonly sdk: Anthropic;

  constructor(apiKey: string) {
    // agent-loop-stability Tur: SDK default timeout (~100s) was killing long
    // agent investigations mid-iteration. 10 minutes covers the worst-case
    // multi-step build-fix flow (15 iters × ~30s/iter = 7.5 min, with slack).
    // maxRetries 2 covers transient network blips without stretching the wall
    // clock for real failures.
    this.sdk = new Anthropic({
      apiKey,
      timeout: 600_000,
      maxRetries: 2,
    });
  }

  async createChatCompletion(
    params: ChatCompletionCreateParamsNonStreaming,
    options: LLMRequestOptions = {}
  ): Promise<ChatCompletion> {
    const wasJsonMode =
      params.response_format?.type === "json_object";
    const { params: anthropicParams, warnings } = convertParams(params);
    if (warnings.length > 0) {
      for (const w of warnings) console.warn(`[zone-anthropic] ${w}`);
    }
    const message = await this.sdk.messages.create(
      {
        ...anthropicParams,
        stream: false,
      },
      { signal: options.signal }
    );
    return convertResponse(message, { wasJsonMode });
  }

  async createChatCompletionStream(
    params: ChatCompletionCreateParamsStreaming,
    options: LLMRequestOptions = {}
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const { params: anthropicParams, warnings } = convertParams(params);
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
