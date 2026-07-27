/**
 * Phase R.2 — Stale tool_result_read eviction.
 *
 * Large file reads pile up in conversation history and dominate token cost
 * (R.1 telemetry showed tool_result_read at 72.5% of total). This module
 * replaces stale read results with a compact summary placeholder while
 * keeping the most recent N iteration-groups at full fidelity.
 *
 * Pruning is applied to a COPY of the messages array before the LLM call.
 * The original responseInput is NOT mutated — future iterations continue
 * appending to it normally. Each LLM call receives a freshly-pruned view.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { log } from "../utils/logger.js";

/** Tool names whose results are candidates for eviction. */
export const READ_PRUNE_TOOL_NAMES = new Set([
  "read_file",
  // list_files and list_directory results are small (just filenames); skip.
  // read_background_output results are polling data; skip.
]);

export interface PruneStats {
  blocksReplaced: number;
  charsSaved: number;
  blocksKept: number;
}

interface CallMeta {
  toolName: string;
  /** filePath argument if present in the tool call's JSON args */
  filePath?: string;
  /** lineRange argument if present */
  lineRange?: [number, number] | null;
}

/**
 * Build a map from tool_call_id → CallMeta by scanning all assistant messages.
 * Supports duck-typed tool_calls because the OpenAI SDK exposes multiple
 * ChatCompletionMessageToolCall variants.
 */
function buildCallMeta(messages: readonly ChatCompletionMessageParam[]): Map<string, CallMeta> {
  const index = new Map<string, CallMeta>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const toolCalls = (msg as { tool_calls?: unknown[] }).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const t = tc as Record<string, unknown>;
      const id = typeof t["id"] === "string" ? t["id"] : undefined;
      const fn = t["function"] as Record<string, unknown> | undefined;
      const name = fn && typeof fn["name"] === "string" ? fn["name"] : undefined;
      if (!id || !name) continue;
      let filePath: string | undefined;
      let lineRange: [number, number] | null | undefined;
      if (fn && typeof fn["arguments"] === "string") {
        try {
          const parsed = JSON.parse(fn["arguments"]) as Record<string, unknown>;
          filePath = typeof parsed["filePath"] === "string" ? parsed["filePath"] : undefined;
          const lr = parsed["lineRange"];
          if (Array.isArray(lr) && lr.length === 2) {
            lineRange = [Number(lr[0]), Number(lr[1])];
          } else {
            lineRange = null;
          }
        } catch {
          // Malformed args — skip optional metadata
        }
      }
      index.set(id, { toolName: name, filePath, lineRange });
    }
  }
  return index;
}

/**
 * Marks content this module already elided.
 *
 * Pruning runs against a copy each iteration, so within one process the input is
 * always pristine. A RESUMED run breaks that assumption: the restored history is
 * a previously-pruned array, and re-pruning it would summarize the summary —
 * reporting the placeholder's own byte count and losing the original file
 * metadata, permanently and irreversibly, since the content is already gone.
 */
const PLACEHOLDER_PREFIX = "[Earlier read";

/** @internal exported for the resume regression test */
export function isPrunedPlaceholder(content: unknown): boolean {
  return typeof content === "string" && content.startsWith(PLACEHOLDER_PREFIX);
}

function makeSummaryPlaceholder(meta: CallMeta | undefined, content: string): string {
  const lineCount = content.split("\n").length;
  const byteCount = Buffer.byteLength(content, "utf8");
  const location = meta?.filePath
    ? meta.lineRange
      ? `${meta.filePath} lines ${meta.lineRange[0]}–${meta.lineRange[1]}`
      : meta.filePath
    : null;
  if (location) {
    return `[Earlier read: ${location} — ${lineCount} lines, ${byteCount} bytes. Content elided to save tokens. Re-read ONLY if the file changed since this iter; otherwise reference by line number from the manifest above.]`;
  }
  return `[Earlier read result — ${lineCount} lines, ${byteCount} bytes. Content elided to save tokens. Re-read ONLY if the file changed since this iter; otherwise reference by line number from the manifest above.]`;
}

/**
 * Replace stale tool_result_read blocks with compact summary placeholders.
 *
 * "Stale" = older than freshIterWindow completed assistant-turn groups ago.
 * Groups are identified structurally: each role:"assistant" message with
 * tool_calls starts a new group; tool_result messages belong to the last
 * seen group. The pruned copy is safe to pass to the LLM API; the original
 * messages array is not mutated.
 *
 * @param messages - Current conversation history (system + user + turns)
 * @param freshIterWindow - Number of recent iteration-groups to preserve (default 2)
 * @returns Pruned copy + stats
 */
export function pruneStaleReads(
  messages: readonly ChatCompletionMessageParam[],
  freshIterWindow = 2
): { pruned: ChatCompletionMessageParam[]; stats: PruneStats } {
  // Count total assistant groups to determine age of each group
  let numGroups = 0;
  for (const msg of messages) {
    if (msg.role === "assistant" && (msg as { tool_calls?: unknown[] }).tool_calls) {
      numGroups += 1;
    }
  }

  if (numGroups === 0) {
    return {
      pruned: [...messages],
      stats: { blocksReplaced: 0, charsSaved: 0, blocksKept: 0 },
    };
  }

  const callMeta = buildCallMeta(messages);
  const stats: PruneStats = { blocksReplaced: 0, charsSaved: 0, blocksKept: 0 };
  const pruned: ChatCompletionMessageParam[] = [];
  let currentGroup = -1; // increments to 0 when first assistant+tool_calls is seen

  for (const msg of messages) {
    // Advance group index when we see an assistant message with tool_calls
    if (msg.role === "assistant" && (msg as { tool_calls?: unknown[] }).tool_calls) {
      currentGroup += 1;
      pruned.push(msg);
      continue;
    }

    if (msg.role === "tool") {
      const toolMsg = msg as { role: "tool"; tool_call_id?: string; content?: unknown };
      const callId = toolMsg.tool_call_id ?? "";
      const meta = callMeta.get(callId);
      const toolName = meta?.toolName ?? "";
      const isReadResult = READ_PRUNE_TOOL_NAMES.has(toolName);

      if (isReadResult && currentGroup >= 0) {
        const age = numGroups - 1 - currentGroup;
        if (isPrunedPlaceholder(toolMsg.content)) {
          // Already elided on a previous run. Pass the message through BY
          // REFERENCE — rebuilding it would drop any field this module does not
          // know about, which is how thinking blocks would be lost once they
          // enter the history.
          stats.blocksKept += 1;
          pruned.push(msg);
          continue;
        }
        if (age > freshIterWindow) {
          // Evict: replace content with summary placeholder
          const originalContent =
            typeof toolMsg.content === "string" ? toolMsg.content : String(toolMsg.content ?? "");
          const placeholder = makeSummaryPlaceholder(meta, originalContent);
          const charsSaved = originalContent.length - placeholder.length;
          stats.blocksReplaced += 1;
          stats.charsSaved += Math.max(0, charsSaved);
          pruned.push({ ...msg, content: placeholder });
          continue;
        } else {
          stats.blocksKept += 1;
        }
      }

      pruned.push(msg);
      continue;
    }

    pruned.push(msg);
  }

  return { pruned, stats };
}

/** Emit per-iter pruning telemetry when blocks were actually replaced. */
export function emitContextPruned(opts: {
  runId: string;
  iter: number;
  stats: PruneStats;
}): void {
  if (opts.stats.blocksReplaced === 0) return;
  log(
    "[zone-context-pruned]",
    JSON.stringify({
      event: "context_pruned",
      runId: opts.runId,
      iter: opts.iter,
      blocksReplaced: opts.stats.blocksReplaced,
      charsSaved: opts.stats.charsSaved,
      blocksKept: opts.stats.blocksKept,
    })
  );
}

