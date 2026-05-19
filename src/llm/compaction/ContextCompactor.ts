import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMClient } from "../types.js";
import { classifyTurns } from "./classifyTurns.js";
import { summarize } from "./summarizer.js";
import {
  TurnClass,
  CompactionExhaustedError,
  type ClassifiedTurn,
  type CompactionResult,
  type ToolCallRecord,
} from "./types.js";

const MANIFEST_MAX_ENTRIES = 20;

/**
 * Build a deterministic file-read manifest from CANDIDATE tool turns (J.3).
 *
 * Scans assistant messages in responseInput for read_file tool_calls, correlates
 * with CANDIDATE tool result turns, and aggregates path+lineRange pairs.
 * Deduplicates same-range reads into "read Nx" notation.
 * Caps at MANIFEST_MAX_ENTRIES with truncation notice.
 *
 * VERBATIM/PINNED reads are excluded — they remain visible in context already.
 */
export interface ManifestEntry {
  filePath: string;
  readCount: number;  // total reads across all ranges for this file
  lineRange: string;  // "outline" if no range, else "lines S-E" of most-read range
}

export function buildFileReadManifest(
  responseInput: ChatCompletionMessageParam[],
  classified: ClassifiedTurn[]
): { manifest: string; truncated: boolean; entryCount: number; structuredEntries: ManifestEntry[] } {
  // Build callId → {filePath, lineRange} by parsing assistant tool_call args in responseInput.
  const readCallArgs = new Map<string, { filePath: string; lineRange: [number, number] | null }>();
  for (const msg of responseInput) {
    if (msg.role !== "assistant") continue;
    const toolCalls = (msg as { tool_calls?: unknown[] }).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const typed = tc as { id?: string; type?: string; function?: { name?: string; arguments?: string } };
      if (typed.type !== "function" || typed.function?.name !== "read_file" || !typed.id) continue;
      try {
        const args = JSON.parse(typed.function.arguments ?? "{}") as Record<string, unknown>;
        if (typeof args.filePath !== "string") continue;
        const lr = Array.isArray(args.lineRange) && args.lineRange.length === 2
          ? [args.lineRange[0] as number, args.lineRange[1] as number] as [number, number]
          : null;
        readCallArgs.set(typed.id, { filePath: args.filePath, lineRange: lr });
      } catch {
        // skip malformed arguments JSON
      }
    }
  }

  interface RangeEntry { startLine: number | null; endLine: number | null; readCount: number; }
  const entries = new Map<string, { path: string; ranges: RangeEntry[] }>();

  for (let i = 0; i < responseInput.length; i++) {
    if (classified[i]?.class !== TurnClass.CANDIDATE) continue;
    const turn = responseInput[i];
    if (turn.role !== "tool") continue;
    const toolCallId = (turn as { tool_call_id?: string }).tool_call_id;
    if (!toolCallId) continue;
    const readInfo = readCallArgs.get(toolCallId);
    if (!readInfo) continue;

    const { filePath, lineRange } = readInfo;
    const startLine = lineRange?.[0] ?? null;
    const endLine = lineRange?.[1] ?? null;

    if (!entries.has(filePath)) entries.set(filePath, { path: filePath, ranges: [] });
    const entry = entries.get(filePath)!;
    const existing = entry.ranges.find((r) => r.startLine === startLine && r.endLine === endLine);
    if (existing) {
      existing.readCount++;
    } else {
      entry.ranges.push({ startLine, endLine, readCount: 1 });
    }
  }

  const allEntries = Array.from(entries.values());
  const truncated = allEntries.length > MANIFEST_MAX_ENTRIES;
  const finalEntries = allEntries.slice(0, MANIFEST_MAX_ENTRIES);

  if (finalEntries.length === 0) {
    return { manifest: "", truncated: false, entryCount: 0, structuredEntries: [] };
  }

  const lines = finalEntries.map((e) => {
    const rangeStrs = e.ranges.map((r) => {
      if (r.startLine !== null && r.endLine !== null) {
        const range = `lines ${r.startLine}-${r.endLine}`;
        return r.readCount > 1 ? `${range} (read ${r.readCount}x)` : range;
      }
      return r.readCount > 1 ? `(full file, read ${r.readCount}x)` : "(full file)";
    });
    return `- ${e.path} ${rangeStrs.join(", ")}`;
  });

  let manifest = "Files read earlier this session (compacted from history):\n" + lines.join("\n");
  if (truncated) {
    manifest += `\n(... ${allEntries.length - MANIFEST_MAX_ENTRIES} more entries truncated)`;
  }

  // Build structured entries for telemetry: per-file total readCount + dominant lineRange.
  const structuredEntries: ManifestEntry[] = finalEntries.map((e) => {
    const totalReadCount = e.ranges.reduce((s, r) => s + r.readCount, 0);
    // Pick the range with the highest readCount as the representative lineRange.
    const topRange = e.ranges.reduce((best, r) => (r.readCount > best.readCount ? r : best), e.ranges[0]);
    const lineRange =
      topRange.startLine !== null && topRange.endLine !== null
        ? `lines ${topRange.startLine}-${topRange.endLine}`
        : "outline";
    return { filePath: e.path, readCount: totalReadCount, lineRange };
  });

  return { manifest, truncated, entryCount: finalEntries.length, structuredEntries };
}

export class ContextCompactor {
  private compactionCount = 0;
  private readonly MAX_COMPACTIONS = 5;
  private readonly WARN_AT = 3;
  private readonly THRESHOLD_RATIO = 0.75;

  getCompactionCount(): number {
    return this.compactionCount;
  }

  async checkAndMaybeCompact(args: {
    responseInput: ChatCompletionMessageParam[];
    toolCallLog: Array<ToolCallRecord>;
    currentUsage: number;
    effectiveCap: number;
    client?: LLMClient;
    runId?: string | undefined;
  }): Promise<CompactionResult> {
    if (args.currentUsage < args.effectiveCap * this.THRESHOLD_RATIO) {
      return { compacted: false, reason: "under_threshold" };
    }

    if (this.compactionCount >= this.MAX_COMPACTIONS) {
      throw new CompactionExhaustedError(
        "Context exhausted via compaction. Break into subtasks."
      );
    }

    const classified = classifyTurns(args.responseInput, args.toolCallLog);
    const candidates = classified.filter((c) => c.class === TurnClass.CANDIDATE);
    if (candidates.length === 0) {
      return { compacted: false, reason: "no_candidates" };
    }

    if (!args.client) {
      return { compacted: false, reason: "summarizer_failed" };
    }

    const nextCount = this.compactionCount + 1;

    // J.3: build deterministic file-read manifest from CANDIDATE reads before summarizing
    const { manifest, truncated: manifestTruncated, entryCount } =
      buildFileReadManifest(args.responseInput, classified);

    let summaryText: string;
    try {
      const output = await summarize({
        candidateTurns: candidates.map((c) => args.responseInput[c.index]),
        totalCandidates: candidates.length,
        client: args.client,
        runId: args.runId,
        compactionDepth: nextCount,   // J.4: tiered prompt
      });
      summaryText = output.summaryText;
    } catch {
      return { compacted: false, reason: "summarizer_failed" };
    }

    // Build newResponseInput: verbatim/pinned turns preserved in order;
    // all candidate positions replaced by ONE synthetic system turn at the first candidate.
    const candidateIndices = new Set(candidates.map((c) => c.index));
    const firstCandidateIdx = candidates[0].index;
    const newResponseInput: ChatCompletionMessageParam[] = [];

    const recurringNotice =
      nextCount >= this.WARN_AT
        ? `\n\nNOTE: This task has been compacted ${nextCount} time(s). ` +
          `Context is heavily summarized. If your next steps don't make clear ` +
          `progress, recommend the user break this task into smaller subtasks.`
        : "";

    // J.3: manifest block prepended to summary in the synthetic system turn
    const manifestBlock = manifest ? `${manifest}\n\n` : "";

    for (let i = 0; i < args.responseInput.length; i++) {
      if (candidateIndices.has(i)) {
        if (i === firstCandidateIdx) {
          newResponseInput.push({
            role: "system",
            content: `[compacted_history]\n${manifestBlock}${summaryText}${recurringNotice}\n[/compacted_history]`,
          });
        }
        continue;
      }
      newResponseInput.push(args.responseInput[i]);
    }

    this.compactionCount += 1;

    // J.1/J.2/J.3/J.4 telemetry stats (payload-only; callers can read what they need)
    const summaryTier = (nextCount <= 2 ? 1 : nextCount <= 4 ? 2 : 3) as 1 | 2 | 3;
    const result: CompactionResult = {
      compacted: true,
      reason: "compacted",
      newResponseInput,
      pinnedStats: {
        audit_artifact: classified.filter((c) => c.pinReason === "audit_artifact").length,
        recent_failure: classified.filter((c) => c.pinReason === "recent_failure").length,
      },
      verbatimCount: classified.filter((c) => c.class === TurnClass.VERBATIM).length,
      candidatesSummarized: candidates.length,
      manifestStats: { entries: entryCount, truncated: manifestTruncated },
      summaryTier,
    };

    if (this.compactionCount === this.WARN_AT) {
      result.warning =
        "Task has compacted 3 times. Context heavily " +
        "summarized. If next steps don't converge, suggest subtasks.";
    }
    return result;
  }
}
