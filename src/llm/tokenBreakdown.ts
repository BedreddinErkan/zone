/**
 * Phase R.1 — Per-LLM-call token breakdown instrumentation.
 *
 * Non-invasive: read-only inspection of the messages array + tool definitions
 * before each API call. Uses char/4 approximation for token estimation —
 * absolute numbers are rough but *relative proportions between buckets* are
 * what matter for identifying wasters.
 *
 * Emits:
 *   [zone-token-breakdown]         — per-call, before the API request
 *   [zone-token-breakdown-summary] — end of run, aggregate across all calls
 *   [zone-token-breakdown-uncategorized] — when heuristics couldn't classify a block
 */

import { log } from "../utils/logger.js";

export type TokenBucket =
  | "system_prompt"        // role:"system" base content
  | "tool_descriptions"    // tool schema definitions in request payload
  | "repo_manifest"        // "Repository scanned (N files)" block
  | "plan_annotations"     // "PLAN ANNOTATIONS" block (Q.6)
  | "import_context"       // "RELATED FILES" import ecosystem block
  | "tool_result_read"     // role:"tool" from read_file / list_directory
  | "tool_result_command"  // role:"tool" from run_command / run_command_background
  | "tool_result_search"   // role:"tool" from search_in_files / search_codebase
  | "tool_result_other"    // role:"tool" uncategorized
  | "compaction_summary"   // "Context compacted" summary block
  | "assistant_reasoning"  // role:"assistant" text turns (model's previous prose)
  | "assistant_tool_use"   // role:"assistant" tool_use blocks (function call metadata)
  | "user_task"            // role:"user" original task (first user message)
  | "other";               // anything that didn't match a specific bucket

export interface BucketStats {
  chars: number;
  estTokens: number;
  blockCount: number;
}

export type BucketMap = Record<TokenBucket, BucketStats>;

export interface BreakdownEvent {
  event: "token_breakdown";
  runId: string;
  parentRunId?: string;
  subagentId?: string;
  iter: number;
  buckets: BucketMap;
  totals: { chars: number; estTokens: number };
  model: string;
  ts: string;
}

export interface BreakdownSummary {
  event: "token_breakdown_summary";
  runId: string;
  totalCalls: number;
  totalChars: number;
  totalEstTokens: number;
  byBucket: Record<
    TokenBucket,
    {
      cumulativeChars: number;
      cumulativeEstTokens: number;
      callsAppearedIn: number;
      pctOfTotal: number;
    }
  >;
  topThreeWasters: Array<{ bucket: TokenBucket; pctOfTotal: number }>;
  ts: string;
}

const ALL_BUCKETS: TokenBucket[] = [
  "system_prompt",
  "tool_descriptions",
  "repo_manifest",
  "plan_annotations",
  "import_context",
  "tool_result_read",
  "tool_result_command",
  "tool_result_search",
  "tool_result_other",
  "compaction_summary",
  "assistant_reasoning",
  "assistant_tool_use",
  "user_task",
  "other",
];

function emptyBucketMap(): BucketMap {
  const map = {} as BucketMap;
  for (const b of ALL_BUCKETS) {
    map[b] = { chars: 0, estTokens: 0, blockCount: 0 };
  }
  return map;
}

function charCount(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) {
      total += charCount(item);
    }
    return total;
  }
  if (value && typeof value === "object") {
    // For OpenAI tool call objects, serialize to count schema chars
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

function estTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function addTo(map: BucketMap, bucket: TokenBucket, chars: number): void {
  map[bucket].chars += chars;
  map[bucket].estTokens = estTokens(map[bucket].chars);
  map[bucket].blockCount += 1;
}

// Tool names that map to specific result buckets
const READ_TOOL_NAMES = new Set([
  "read_file",
  "list_directory",
  "read_background_output",
]);
const COMMAND_TOOL_NAMES = new Set([
  "run_command",
  "run_command_background",
  "kill_background",
]);
const SEARCH_TOOL_NAMES = new Set([
  "search_in_files",
  "search_codebase",
  "find_files",
  "grep_codebase",
]);

type AnyMessage = {
  role: string;
  content?: unknown;
  // Kept intentionally loose — the OpenAI SDK has multiple ChatCompletionMessageToolCall
  // sub-variants (function vs custom). We only need id + function.name, extracted via
  // duck-typing in buildCallIndex.
  tool_calls?: unknown[];
  tool_call_id?: string;
};

/**
 * Build a callId→toolName index from assistant messages with tool_calls.
 * Used to categorize the matching role:"tool" result messages.
 */
function buildCallIndex(messages: AnyMessage[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        // Duck-type: OpenAI ChatCompletionMessageToolCall has {id, function: {name, ...}}
        // ChatCompletionMessageCustomToolCall may differ — skip gracefully.
        if (tc && typeof tc === "object") {
          const t = tc as Record<string, unknown>;
          const id = typeof t["id"] === "string" ? t["id"] : undefined;
          const fn = t["function"] as Record<string, unknown> | undefined;
          const name = fn && typeof fn["name"] === "string" ? fn["name"] : undefined;
          if (id && name) index.set(id, name);
        }
      }
    }
  }
  return index;
}

/**
 * Classify a system prompt block's content into sub-buckets.
 * Returns a partial BucketMap for just the system-prompt-related buckets.
 * The spec wants plan_annotations and repo_manifest subtracted from system_prompt.
 */
function classifySystemContent(
  content: string,
  buckets: BucketMap,
  runId: string,
  iter: number
): void {
  // Split into labelled sub-sections. We look for the sentinel strings
  // introduced by our own prompt assembly (assembleAgentSystemPrompt).
  let remainder = content;

  // Extract PLAN ANNOTATIONS block
  const planStart = content.indexOf("PLAN ANNOTATIONS");
  if (planStart >= 0) {
    // Ends at the next double-newline after the section's last bullet
    const planSection = extractSection(content, planStart);
    addTo(buckets, "plan_annotations", planSection.length);
    remainder = remainder.replace(planSection, "");
  }

  // Extract RELATED FILES block
  const relatedStart = content.indexOf("RELATED FILES (read-only context");
  if (relatedStart >= 0) {
    const endMarker = "(End related files context)";
    const endIdx = content.indexOf(endMarker, relatedStart);
    const section =
      endIdx >= 0
        ? content.slice(relatedStart, endIdx + endMarker.length)
        : content.slice(relatedStart);
    addTo(buckets, "import_context", section.length);
    remainder = remainder.replace(section, "");
  }

  // Check for repo manifest anywhere (may be in project memory block or prefix)
  const repoManifestRe = /Repository scanned \(\d+ files/;
  if (repoManifestRe.test(remainder)) {
    // Heuristic: lines mentioning the manifest are typically short — tag them
    const matchIdx = remainder.search(repoManifestRe);
    if (matchIdx >= 0) {
      // Count the line containing the manifest marker
      const lineEnd = remainder.indexOf("\n", matchIdx);
      const manifestLine = lineEnd >= 0 ? remainder.slice(matchIdx, lineEnd + 1) : remainder.slice(matchIdx);
      addTo(buckets, "repo_manifest", manifestLine.length);
      remainder = remainder.replace(manifestLine, "");
    }
  }

  // Check for compaction summary inside system content (rare but possible)
  if (/Context compacted/i.test(remainder)) {
    const compactIdx = remainder.search(/Context compacted/i);
    const section = extractSection(remainder, compactIdx);
    addTo(buckets, "compaction_summary", section.length);
    remainder = remainder.replace(section, "");
    void runId; void iter; // suppress unused vars
  }

  // Everything else is the base system prompt
  if (remainder.trim().length > 0) {
    addTo(buckets, "system_prompt", remainder.length);
  }
}

/** Extracts a "section" starting at startIdx — runs to the next double-newline or end. */
function extractSection(text: string, startIdx: number): string {
  const end = text.indexOf("\n\n", startIdx + 1);
  return end >= 0 ? text.slice(startIdx, end + 2) : text.slice(startIdx);
}

/**
 * Categorize all messages in a responseInput array into token buckets.
 * Also accepts the `tools` array from the API request payload to account
 * for tool description tokens.
 */
export function categorizeMessages(
  messages: readonly AnyMessage[],
  tools: readonly unknown[] | undefined,
  opts: { runId: string; iter: number }
): BucketMap {
  const buckets = emptyBucketMap();
  const callIndex = buildCallIndex(messages as AnyMessage[]);

  // Tool definitions are part of the API request payload (not messages).
  if (Array.isArray(tools) && tools.length > 0) {
    const toolsChars = charCount(tools);
    addTo(buckets, "tool_descriptions", toolsChars);
  }

  let isFirstUserMessage = true;

  for (const msg of messages) {
    const role = msg.role;

    if (role === "system") {
      const content = typeof msg.content === "string" ? msg.content : charCount(msg.content).toString();
      if (typeof msg.content === "string") {
        classifySystemContent(msg.content, buckets, opts.runId, opts.iter);
      } else {
        // Non-string system content — unlikely but handle gracefully
        addTo(buckets, "system_prompt", charCount(msg.content));
      }
      void content;
      continue;
    }

    if (role === "user") {
      const chars = charCount(msg.content);
      if (isFirstUserMessage) {
        // Check if it looks like a compaction summary (happens when compaction replaced the input)
        const contentStr = typeof msg.content === "string" ? msg.content : "";
        if (/Context compacted/i.test(contentStr)) {
          addTo(buckets, "compaction_summary", chars);
        } else {
          addTo(buckets, "user_task", chars);
        }
        isFirstUserMessage = false;
      } else {
        // Subsequent user messages (loop warning injections, compaction notices)
        const contentStr = typeof msg.content === "string" ? msg.content : "";
        if (/Context compacted/i.test(contentStr)) {
          addTo(buckets, "compaction_summary", chars);
        } else {
          addTo(buckets, "other", chars);
        }
      }
      continue;
    }

    if (role === "assistant") {
      // Text content (reasoning / final answer)
      const textContent = typeof msg.content === "string" ? msg.content : "";
      if (textContent.trim().length > 0) {
        addTo(buckets, "assistant_reasoning", textContent.length);
      }
      // Tool call metadata (unknown[] type — charCount handles via JSON.stringify)
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const tcChars = charCount(msg.tool_calls as unknown[]);
        addTo(buckets, "assistant_tool_use", tcChars);
      }
      continue;
    }

    if (role === "tool") {
      const toolCallId = msg.tool_call_id ?? "";
      const toolName = callIndex.get(toolCallId) ?? "";
      const chars = charCount(msg.content);

      if (READ_TOOL_NAMES.has(toolName)) {
        addTo(buckets, "tool_result_read", chars);
      } else if (COMMAND_TOOL_NAMES.has(toolName)) {
        addTo(buckets, "tool_result_command", chars);
      } else if (SEARCH_TOOL_NAMES.has(toolName)) {
        addTo(buckets, "tool_result_search", chars);
      } else if (toolName) {
        // Named but not in a specific set
        addTo(buckets, "tool_result_other", chars);
      } else {
        // No toolName in callIndex — fall back to content heuristics
        const contentStr = typeof msg.content === "string" ? msg.content : "";
        if (/^\[exit_code=/.test(contentStr)) {
          addTo(buckets, "tool_result_command", chars);
        } else if (/^(ZONE_CONTEXT_TRUNCATED|---\s*(content|file)\s*---)/i.test(contentStr)) {
          addTo(buckets, "tool_result_read", chars);
        } else {
          // Emit uncategorized warning (first 80 chars, no PII risk for code content)
          const preview = contentStr.slice(0, 80).replace(/\n/g, " ").trim();
          log(
            "[zone-token-breakdown-uncategorized]",
            JSON.stringify({
              runId: opts.runId,
              iter: opts.iter,
              roleHint: role,
              toolCallId: toolCallId.slice(0, 16),
              preview,
            })
          );
          addTo(buckets, "tool_result_other", chars);
        }
      }
      continue;
    }

    // Unknown role — count as other
    addTo(buckets, "other", charCount(msg.content));
  }

  return buckets;
}

/** Emit a per-call breakdown event to the JSONL telemetry stream. */
export function emitTokenBreakdown(opts: {
  runId: string;
  parentRunId?: string;
  subagentId?: string;
  iter: number;
  messages: readonly AnyMessage[];
  tools: readonly unknown[] | undefined;
  model: string;
}): BreakdownEvent {
  const buckets = categorizeMessages(opts.messages, opts.tools, {
    runId: opts.runId,
    iter: opts.iter,
  });

  let totalChars = 0;
  for (const b of ALL_BUCKETS) {
    totalChars += buckets[b].chars;
  }

  const event: BreakdownEvent = {
    event: "token_breakdown",
    runId: opts.runId,
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    ...(opts.subagentId ? { subagentId: opts.subagentId } : {}),
    iter: opts.iter,
    buckets,
    totals: { chars: totalChars, estTokens: estTokens(totalChars) },
    model: opts.model,
    ts: new Date().toISOString(),
  };

  log("[zone-token-breakdown]", JSON.stringify(event));
  return event;
}

/** Build and emit the end-of-run summary from accumulated per-call events. */
export function emitBreakdownSummary(opts: {
  runId: string;
  events: BreakdownEvent[];
}): BreakdownSummary {
  const { runId, events } = opts;
  const totalCalls = events.length;

  let totalChars = 0;
  for (const ev of events) {
    totalChars += ev.totals.chars;
  }
  const totalEstTokens = estTokens(totalChars);

  // Aggregate per-bucket across all calls
  const byBucket = {} as BreakdownSummary["byBucket"];
  for (const b of ALL_BUCKETS) {
    let cumChars = 0;
    let cumTokens = 0;
    let callsIn = 0;
    for (const ev of events) {
      const bkt = ev.buckets[b];
      if (bkt.chars > 0) {
        cumChars += bkt.chars;
        cumTokens += bkt.estTokens;
        callsIn += 1;
      }
    }
    byBucket[b] = {
      cumulativeChars: cumChars,
      cumulativeEstTokens: cumTokens,
      callsAppearedIn: callsIn,
      pctOfTotal: totalChars > 0 ? Number(((cumChars / totalChars) * 100).toFixed(1)) : 0,
    };
  }

  // Top three wasters by cumulative chars
  const topThreeWasters = ALL_BUCKETS.map((b) => ({
    bucket: b,
    pctOfTotal: byBucket[b].pctOfTotal,
  }))
    .sort((a, b) => b.pctOfTotal - a.pctOfTotal)
    .slice(0, 3);

  const summary: BreakdownSummary = {
    event: "token_breakdown_summary",
    runId,
    totalCalls,
    totalChars,
    totalEstTokens,
    byBucket,
    topThreeWasters,
    ts: new Date().toISOString(),
  };

  log("[zone-token-breakdown-summary]", JSON.stringify(summary));
  return summary;
}
