import type { Response as OpenAIResponse } from "openai/resources/responses/responses.js";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { ChatCompletionWithReasoning } from "../types.js";

export function responsesConvertResponse(response: OpenAIResponse): ChatCompletionWithReasoning {
  const textParts: string[] = [];
  const toolCalls: ChatCompletion.Choice["message"]["tool_calls"] = [];
  // Reasoning items collected for the S4-SEAM carrier below. Only encrypted_content remains an
  // unconsumed discard now — the carrier itself is still unbuilt. reasoningTextParts is the
  // display half (mirrors Anthropic's extractReasoningText); reasoningItems stays the full-item
  // record S4's carrier will eventually consume, same split thinkingBlocks.ts draws between
  // captureThinkingBlocks (replay, whole block) and extractReasoningText (display, text only) —
  // narrowed to one pass here because only the display half exists on this side yet.
  const reasoningItems: unknown[] = [];
  const reasoningTextParts: string[] = [];

  for (const item of response.output) {
    if (item.type === "reasoning") {
      reasoningItems.push(item);
      for (const part of item.summary) {
        if (typeof part.text === "string" && part.text.length > 0) {
          reasoningTextParts.push(part.text);
        }
      }
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
  // encrypted_content is the only field still discarded past this point; summary text has
  // already been read out into reasoningText, below.
  // S4 will add:
  //   if (reasoningItems.length > 0 && toolCalls.length > 0) {
  //     carrier?.store(toolCalls.map(c => c.id), reasoningItems);
  //   }

  // Join/trim convention matches thinkingBlocks.ts's extractReasoningText exactly: the outer
  // trim strips only the joined string's own ends, so a trailing space on a non-final part
  // survives inside the string — real behavior, not an idealized one, and pinned by a test.
  const reasoningText = reasoningTextParts.join("\n\n").trim();

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
    // Bracket-accessed cache fields (mirroring convertResponse.ts for the OpenAI Chat path).
    // cache_write_tokens is absent from the installed SDK's InputTokensDetails type but
    // is present on the wire, so it needs the cast; without it the gpt-5.6 cache-write
    // rates in pricing.ts have no producer and every OpenAI cache write books as zero.
    ...({
      prompt_tokens_details: {
        cached_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
        cache_write_tokens:
          Number(
            (response.usage?.input_tokens_details as { cache_write_tokens?: number } | undefined)
              ?.cache_write_tokens ?? 0
          ) || 0,
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

  // Typed as a Pick of the shared type, not built inline in the return statement below: excess
  // property checking runs on a literal assigned to a typed target, but is bypassed for a
  // literal merged into a wider object via spread — so a renamed key here (caught: confirmed by
  // mutation) fails the build, while the same rename inside an inline spread would not have.
  const reasoningTextField: Pick<ChatCompletionWithReasoning, "reasoningText"> = reasoningText
    ? { reasoningText }
    : {};

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
    ...reasoningTextField,
    usage,
  };
}
