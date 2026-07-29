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
 * How many trailing assistant turns replay their thinking. Unlimited, and the
 * reason is measured rather than assumed — a bounded window is actively worse.
 *
 * THE CACHE DECIDES THIS. `translateMessages` renders every role:"tool" message
 * as a role:"user" carrying a tool_result block, so cache breakpoint #2 lands on
 * the LAST TOOL RESULT and advances every iteration: the conversation is inside
 * the cached prefix, and Anthropic re-uses everything up to the previous
 * iteration's marker.
 *
 * A bounded window breaks that. With N=1, an assistant turn carries its thinking
 * in the iteration it is newest and LOSES it in the next one, so bytes that were
 * already cached change retroactively — a miss on the whole conversation from
 * the previous assistant turn onward, every iteration. Measured directly in
 * `thinkingPrefixStability.test.ts`: with a finite window the prefix is not
 * append-only. It saves re-uploading ~600 tokens that would have been read at
 * 0.1x and pays a full-price re-read of the entire tail for it.
 *
 * Replaying everything keeps the prefix append-only: each block costs one cache
 * write (1.25x) in the iteration it first appears, then 0.1x reads. That is the
 * cheap direction, not the expensive one.
 *
 * The envelope does not argue against it either. Dropping happens at translation
 * time, never by mutating history — the R2 shim reuses its previous pruned array
 * by reference, so a rewrite would corrupt a prefix another iteration is still
 * holding. The internal history therefore carries every captured block whatever
 * this constant says, and envelope size is independent of it. Bounding what is
 * *stored* is a separate lever from bounding what is *replayed*, and only the
 * first would help there.
 *
 * @unverified-probe(thinking:older-turn-stripping) What remains unverified is
 * whether Anthropic strips thinking from earlier assistant turns server-side. If
 * it does, replaying them is inert — harmless, since the bytes must be sent
 * consistently for the cache to match either way, but it would mean the model
 * genuinely cannot see beyond the last turn and the feature's ceiling is one
 * turn of memory. If it does not, older turns are real context and this is
 * already the right setting. Either way a bounded window is the wrong answer;
 * the probe decides how much benefit to expect, not the policy.
 */
export const THINKING_REPLAY_TURNS = Number.POSITIVE_INFINITY;

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
 * Which assistant turns replay their thinking, by index into `messages`.
 *
 * Two gates, both necessary:
 *
 *  - Recency. Only the last `THINKING_REPLAY_TURNS` assistant turns that carry
 *    tool_calls are considered. A turn without tool_calls ends the exchange;
 *    there is no tool_result coming back that its reasoning has to survive to
 *    meet.
 *  - Model. A block is signed by the model that produced it. Replaying it to a
 *    different one is the failure this gate exists to prevent, and it is the
 *    same gate for all three ways Zone changes model: mid-run escalation, a
 *    resume from another model's envelope, and a provider switch.
 *
 * Returns indices rather than mutating: the caller's history is shared with the
 * R2 shim, which reuses its previous pruned array by reference. Stripping
 * thinking by rewriting messages would corrupt a prefix another iteration is
 * still holding.
 */
export function selectThinkingReplayIndices(
  messages: ReadonlyArray<{ role?: string; tool_calls?: unknown }>,
  requestModel: string | undefined,
  maxTurns: number = THINKING_REPLAY_TURNS
): Set<number> {
  const eligible = new Set<number>();
  if (!requestModel || maxTurns <= 0) return eligible;

  let seen = 0;
  for (let i = messages.length - 1; i >= 0 && seen < maxTurns; i -= 1) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) continue;
    seen += 1;
    const state = readProviderState(msg);
    if (state && state.model === requestModel) eligible.add(i);
  }
  return eligible;
}

/**
 * Assistant turns holding thinking that will NOT be replayed to `requestModel`
 * because it was signed by a different one. Telemetry only — the drop itself is
 * a side effect of `selectThinkingReplayIndices` returning fewer indices.
 */
export function countThinkingDroppedForModel(
  messages: ReadonlyArray<{ role?: string }>,
  requestModel: string
): number {
  let dropped = 0;
  for (const msg of messages) {
    const state = readProviderState(msg);
    if (state && state.model !== requestModel) dropped += 1;
  }
  return dropped;
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
