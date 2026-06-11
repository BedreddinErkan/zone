import type { Response as OpenAIResponse } from "openai/resources/responses/responses.js";
import type { ChatCompletion } from "openai/resources/chat/completions";

export function responsesConvertResponse(response: OpenAIResponse): ChatCompletion {
  const textParts: string[] = [];
  const toolCalls: ChatCompletion.Choice["message"]["tool_calls"] = [];
  // Reasoning items collected for S4-SEAM below (discarded for now).
  const _reasoningItems: unknown[] = [];

  for (const item of response.output) {
    if (item.type === "reasoning") {
      _reasoningItems.push(item);
      continue;
    }
    if (item.type === "function_call") {
      // id := call_id (NOT item.id which is the fc_ prefix id) — see design doc §2 load-bearing trap.
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      });
      continue;
    }
    if (item.type === "message") {
      for (const block of item.content) {
        if ("text" in block && typeof block.text === "string") {
          textParts.push(block.text);
        }
      }
      continue;
    }
  }

  // S4-SEAM: carrier.store(callIds, reasoningItems) — stash reasoning when carrier is added in S4.
  // S4 will add:
  //   if (_reasoningItems.length > 0 && toolCalls.length > 0) {
  //     carrier?.store(toolCalls.map(c => c.id), _reasoningItems);
  //   }

  const hasToolCalls = toolCalls.length > 0;
  const text = textParts.join("");

  let refusal: string | null = null;
  let finishReason: ChatCompletion.Choice["finish_reason"] = "stop";

  if (hasToolCalls) {
    finishReason = "tool_calls";
  }

  const status = (response as { status?: string }).status;
  if (status === "failed" || status === "cancelled") {
    const errMsg =
      (response as { error?: { message?: string } }).error?.message ?? "Response failed";
    refusal = errMsg;
    // finish_reason stays "stop" (or "tool_calls" if somehow both — unlikely)
    if (!hasToolCalls) finishReason = "stop";
  }

  if (response.incomplete_details) {
    finishReason = "length";
  }

  const message: ChatCompletion.Choice["message"] = {
    role: "assistant",
    content: hasToolCalls && text.length === 0 ? null : text || null,
    refusal,
    ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
  };

  // Usage — guard all fields: failed/incomplete responses may omit usage entirely.
  // Do NOT pre-subtract cached_tokens from prompt_tokens: extractUsage (recordingClient.ts:31-38) does that.
  const usage: ChatCompletion["usage"] = {
    prompt_tokens: response.usage?.input_tokens ?? 0,
    completion_tokens: response.usage?.output_tokens ?? 0,
    total_tokens: response.usage?.total_tokens ?? 0,
    // Bracket-accessed cache field (mirroring convertResponse.ts:112-115 for OpenAI Chat path).
    ...({
      prompt_tokens_details: {
        cached_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
    } as Record<string, unknown>),
    // reasoning_tokens is a SUBSET of output_tokens — expose in detail field only, never add to completion_tokens.
    ...({
      completion_tokens_details: {
        reasoning_tokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      },
    } as Record<string, unknown>),
  } as ChatCompletion["usage"];

  const created = Math.floor(Date.now() / 1000);

  return {
    id: response.id,
    object: "chat.completion",
    created,
    model: response.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage,
  };
}
