/**
 * Capture of Anthropic thinking blocks, shared by both transport paths.
 *
 * The blocks are carried verbatim and never inspected: they are replayed to the
 * API byte-identically, and the signature they carry is validated against their
 * exact bytes. Anything that rebuilds a block field-by-field — even correctly —
 * risks changing key order or dropping a field a future API version adds.
 *
 * Capture is deliberately blind to content. See `isThinkingBlock`.
 */

/**
 * A thinking block as received. Deliberately opaque: no field is read except
 * `type`, and that only to decide whether to carry it.
 */
export type ProviderThinkingBlock = { type: string } & Record<string, unknown>;

/**
 * Blocks that must survive replay. `redacted_thinking` carries `data` rather
 * than `thinking` and must never be read at all — it is encrypted.
 */
const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

/**
 * Type test for capture — **on `type` alone, never on content.**
 *
 * @unverified-probe(thinking:fable-display) Anthropic's guidance is that raw
 * thinking is never returned for Fable 5: `thinking.display` defaults to
 * "omitted", with "summarized" as the alternative. Zone sends no `display`
 * field, so it takes the default. Two shapes are possible and Zone cannot tell
 * them apart without a live call: either no thinking block is returned at all —
 * in which case there is nothing to capture and this increment does nothing for
 * Fable — or a signed block is returned whose content is omitted or summarized,
 * which must still be replayed for its signature to validate.
 *
 * Gating on `typeof block.thinking === "string"` would silently drop the second
 * shape: a signed block with no content, discarded on the one model this was
 * built for and on no other. So the gate is `type` only. Content-blindness is
 * what makes the capture correct under both shapes without knowing which holds.
 */
export function isThinkingBlock(block: unknown): block is ProviderThinkingBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    THINKING_BLOCK_TYPES.has((block as { type?: unknown }).type as string)
  );
}

/**
 * Collect thinking blocks from a message's content, by reference.
 *
 * Returns the SDK's own block objects — not copies. A copy would be a
 * re-serialization, which is the one thing byte-identity cannot survive.
 */
export function captureThinkingBlocks(content: readonly unknown[]): ProviderThinkingBlock[] {
  const blocks: ProviderThinkingBlock[] = [];
  for (const block of content) {
    if (isThinkingBlock(block)) blocks.push(block);
  }
  return blocks;
}

/**
 * What an assistant turn carries alongside its content, so the blocks can be
 * replayed to the model that produced them and to no other.
 *
 * `model` is not decoration. A thinking block is signed by the model that
 * emitted it and will not validate against a different one, and Zone changes
 * model underneath a live history in three ways: stall escalation mid-run
 * (`agentLoop.ts`, behind ZONE_ESCALATE_ON_STALL), a resume whose envelope was
 * written by another model, and a provider switch. Carrying the model with the
 * blocks covers all three with one comparison at translation time, instead of
 * three call-site patches that each have to remember.
 */
export interface ZoneProviderState {
  blocks: ProviderThinkingBlock[];
  model: string;
}

/**
 * Field name on the internal assistant message. Deliberately prefixed: it rides
 * an OpenAI-shaped `ChatCompletionMessageParam` that Zone owns but did not
 * define, and it must be recognisable as Zone's own on sight.
 */
export const ZONE_PROVIDER_FIELD = "_zoneProvider" as const;

/** Read the passthrough state off a message, if it has one. */
export function readProviderState(msg: unknown): ZoneProviderState | null {
  if (typeof msg !== "object" || msg === null) return null;
  const state = (msg as Record<string, unknown>)[ZONE_PROVIDER_FIELD];
  if (typeof state !== "object" || state === null) return null;
  const { blocks, model } = state as { blocks?: unknown; model?: unknown };
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  if (typeof model !== "string" || model.length === 0) return null;
  return { blocks: blocks as ProviderThinkingBlock[], model };
}

/**
 * Human-readable reasoning for the TUI event (`agentLoop.ts` investigation mode).
 *
 * Unlike capture, this one *does* gate on content: it needs text, and a block
 * without any is simply not displayable. Keeping the two separate is the point —
 * the display path may skip a block that the replay path must still carry.
 */
export function extractReasoningText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (!isThinkingBlock(block)) continue;
    const text = (block as { thinking?: unknown }).thinking;
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.join("\n\n").trim();
}
