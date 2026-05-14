import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageToolCall,
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
    if (options.onToolArgumentsDelta) {
      return this._streamWithToolCallbacks(params, options);
    }
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

  private async _streamWithToolCallbacks(
    params: ChatCompletionCreateParamsNonStreaming,
    options: LLMRequestOptions
  ): Promise<ChatCompletion> {
    const { params: anthropicParams, warnings } = convertParams(params);
    if (warnings.length > 0) {
      for (const w of warnings) console.warn(`[zone-anthropic] ${w}`);
    }
    const stream = this.sdk.messages.stream(
      { ...anthropicParams },
      { signal: options.signal }
    );

    let responseId = "";
    let responseModel = "";
    let textAccum = "";
    let finishReason: ChatCompletion.Choice["finish_reason"] = "stop";
    const toolsByIndex = new Map<number, { id: string; name: string; argsAccum: string }>();
    let usagePrompt = 0;
    let usageCompletion = 0;
    let usageCacheWrite = 0;
    let usageCacheRead = 0;

    for await (const chunk of convertStream(stream)) {
      if (!responseId && chunk.id) responseId = chunk.id;
      if (!responseModel && chunk.model) responseModel = chunk.model;

      // Synthetic usage chunk (empty choices array)
      if (chunk.choices.length === 0) {
        const u = (chunk as { usage?: Record<string, number> }).usage;
        if (u) {
          usagePrompt = u.prompt_tokens ?? usagePrompt;
          usageCompletion = u.completion_tokens ?? usageCompletion;
          usageCacheWrite = u.cache_creation_input_tokens ?? usageCacheWrite;
          usageCacheRead = u.cache_read_input_tokens ?? usageCacheRead;
        }
        continue;
      }

      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      if (typeof delta.content === "string" && delta.content) {
        textAccum += delta.content;
      }

      const tcArr = (delta as { tool_calls?: Array<{
        index?: number; id?: string; type?: string;
        function?: { name?: string; arguments?: string };
      }> }).tool_calls;
      if (Array.isArray(tcArr)) {
        for (const tc of tcArr) {
          const idx = tc.index ?? 0;
          if (tc.id && tc.function?.name !== undefined) {
            toolsByIndex.set(idx, { id: tc.id, name: tc.function.name ?? "", argsAccum: "" });
          }
          const argFrag = tc.function?.arguments;
          if (typeof argFrag === "string" && argFrag.length > 0) {
            const entry = toolsByIndex.get(idx);
            if (entry) {
              entry.argsAccum += argFrag;
              options.onToolArgumentsDelta!(entry.id, entry.name, argFrag);
            }
          }
        }
      }
    }

    const toolCalls: ChatCompletionMessageToolCall[] =
      toolsByIndex.size > 0
        ? [...toolsByIndex.values()].map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.argsAccum },
          }))
        : [];

    const hasToolCalls = toolCalls.length > 0;
    const message: ChatCompletion.Choice["message"] = {
      role: "assistant",
      refusal: null,
      content: hasToolCalls && textAccum.length === 0 ? null : textAccum,
      ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
    };

    return {
      id: responseId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseModel,
      choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
      usage: {
        prompt_tokens: usagePrompt,
        completion_tokens: usageCompletion,
        total_tokens: usagePrompt + usageCompletion,
        ...({
          cache_creation_input_tokens: usageCacheWrite,
          cache_read_input_tokens: usageCacheRead,
        } as Record<string, number>),
      } as ChatCompletion["usage"],
    };
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
