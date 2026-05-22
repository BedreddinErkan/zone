import type Anthropic from "@anthropic-ai/sdk";
import { log } from "../../utils/logger.js";

/**
 * Applies Anthropic cache breakpoint #2 (last-user-message marker).
 * Called from convertParams.ts after breakpoint #1 (last-tool marker, which stays inline).
 * Returns the messages array with cache_control attached to the last user message's
 * last content block, or the original array unchanged if conditions are not met.
 */
export function applyMessageCacheBreakpoint2(
  messages: Anthropic.MessageParam[],
  opts: { enabled: boolean; isFirstAndTinyThreshold?: number },
): Anthropic.MessageParam[] {
  if (!opts.enabled || messages.length === 0) return messages;

  const threshold = opts.isFirstAndTinyThreshold ?? 500;

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx < 0) return messages;

  const isFirstAndTiny =
    lastUserIdx === 0 &&
    messages.length === 1 &&
    typeof messages[0].content === "string" &&
    messages[0].content.length < threshold;

  if (isFirstAndTiny) return messages;

  const result = messages.map((msg, i) => {
    if (i !== lastUserIdx) return msg;

    if (typeof msg.content === "string") {
      return {
        ...msg,
        content: [
          {
            type: "text" as const,
            text: msg.content,
            cache_control: { type: "ephemeral" as const },
          },
        ],
      };
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const lastBlockIdx = msg.content.length - 1;
      return {
        ...msg,
        content: msg.content.map((block, bi) =>
          bi === lastBlockIdx
            ? ({ ...block, cache_control: { type: "ephemeral" } } as typeof block)
            : block
        ),
      };
    }
    return msg;
  });

  if (process.env["ZONE_DEBUG_CACHE_PROBE"] === "1") {
    const targetMsg = result[lastUserIdx];
    log("[zone-cache-marker-placed]", JSON.stringify({
      markerOnIdx: lastUserIdx,
      markerOnRole: targetMsg?.role ?? "unknown",
      contentBlockCount: Array.isArray(targetMsg?.content) ? targetMsg.content.length : 1,
      totalMessages: result.length,
    }));
  }

  return result;
}
