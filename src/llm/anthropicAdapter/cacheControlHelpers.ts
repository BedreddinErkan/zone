import type Anthropic from "@anthropic-ai/sdk";
import { log } from "../../utils/logger.js";

/**
 * Stable content prefix that identifies a manifest message injected by ManifestInjectionProcessor.
 * Used to skip the manifest when placing cache breakpoint #2 so the marker lands on the last
 * PERSISTENT user message instead (the manifest varies per iter, busting the prefix cache).
 */
export const MANIFEST_CONTENT_PREFIX = "## Files already read this run";

function isManifestMessage(msg: Anthropic.MessageParam): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") {
    return msg.content.startsWith(MANIFEST_CONTENT_PREFIX);
  }
  if (Array.isArray(msg.content) && msg.content.length > 0) {
    const first = msg.content[0] as { type?: string; text?: string };
    return first.type === "text" && typeof first.text === "string" && first.text.startsWith(MANIFEST_CONTENT_PREFIX);
  }
  return false;
}

/**
 * Applies Anthropic cache breakpoint #2 (last-persistent-user-message marker).
 * Called from convertParams.ts after breakpoint #1 (last-tool marker, which stays inline).
 * Returns the messages array with cache_control attached to the last non-manifest user message's
 * last content block, or the original array unchanged if conditions are not met.
 *
 * The manifest (injected by ManifestInjectionProcessor) is skipped because its content varies
 * per iter (file set grows) and its position shifts (new assistant+tool messages are added ahead
 * of it), making every cache write unreachable by the next iter. Falls back to marking the manifest
 * when no other user message exists (first iter before any tool calls).
 */
export function applyMessageCacheBreakpoint2(
  messages: Anthropic.MessageParam[],
  opts: { enabled: boolean; isFirstAndTinyThreshold?: number },
): Anthropic.MessageParam[] {
  if (!opts.enabled || messages.length === 0) return messages;

  const threshold = opts.isFirstAndTinyThreshold ?? 500;

  let lastUserIdx = -1;
  let manifestFallbackIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") {
      if (isManifestMessage(messages[i])) {
        if (manifestFallbackIdx < 0) manifestFallbackIdx = i;
        continue; // skip manifest, keep scanning for a persistent message
      }
      lastUserIdx = i;
      break;
    }
  }
  // Fall back to the manifest if no persistent user message was found.
  const isManifestFallback = lastUserIdx < 0 && manifestFallbackIdx >= 0;
  if (lastUserIdx < 0) lastUserIdx = manifestFallbackIdx;

  if (lastUserIdx < 0) return messages;

  // Skip caching a single tiny initial user prompt — it's not worth the write cost.
  // Exclude the manifest-fallback path: when the manifest is the only target we should
  // still cache it rather than leaving breakpoint #2 entirely unused.
  const isFirstAndTiny =
    !isManifestFallback &&
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
      manifestSkipped: manifestFallbackIdx >= 0 && lastUserIdx !== manifestFallbackIdx,
    }));
  }

  return result;
}
