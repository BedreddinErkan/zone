import type Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletion,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";

export function convertStopReason(
  reason: Anthropic.StopReason | null
): ChatCompletion.Choice["finish_reason"] {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    default:
      return "stop";
  }
}

export interface ConvertResponseOptions {
  wasJsonMode?: boolean;
}

export function stripJsonFences(content: string): string {
  const fenceMatch = content.match(
    /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/
  );
  if (fenceMatch) return fenceMatch[1].trim();
  return content;
}

export function convertResponse(
  msg: Anthropic.Message,
  options: ConvertResponseOptions = {}
): ChatCompletion {
  const created = Math.floor(Date.now() / 1000);

  const textParts: string[] = [];
  const toolCalls: ChatCompletionMessageToolCall[] = [];

  for (const block of msg.content) {
    if (block.type === "text") {
      if (typeof block.text === "string") textParts.push(block.text);
      continue;
    }
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: safeStringifyToolInput(block.input),
        },
      });
      continue;
    }
    // ignore thinking/citations/etc. for now
  }

  let text = textParts.join("");
  if (options.wasJsonMode && text.length > 0) {
    text = stripJsonFences(text);
  }

  const hasToolCalls = toolCalls.length > 0;

  const message: ChatCompletion.Choice["message"] = {
    role: "assistant",
    refusal: null,
    content: hasToolCalls && text.length === 0 ? null : text,
    ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
  };

  return {
    id: msg.id,
    object: "chat.completion",
    created,
    model: msg.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: convertStopReason(msg.stop_reason),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: msg.usage.input_tokens,
      completion_tokens: msg.usage.output_tokens,
      total_tokens: msg.usage.input_tokens + msg.usage.output_tokens,
      // Anthropic-specific cache telemetry. Not part of the OpenAI usage shape;
      // downstream readers must use bracket access. Always present when caching
      // is enabled, both fields default to 0 on cache miss / non-cached calls.
      ...({
        cache_creation_input_tokens:
          (msg.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
        cache_read_input_tokens:
          (msg.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
        web_search_requests:
          (msg.usage as { server_tool_use?: { web_search_requests?: number } })
            .server_tool_use?.web_search_requests ?? 0,
      } as Record<string, number>),
    } as ChatCompletion["usage"],
  };
}

function safeStringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}
