import type { AgentLoopResult } from "./agentLoop.js";

export const WORKER_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_files",
  "search_in_files",
  "apply_patch",
  "write_file",
  // NOTE: deliberately excluded for MVP — run_command, update_memory, Task,
  // background-process tools, get_dependencies, etc.
]);

export const WORKER_MAX_ITERATIONS = 12;
export const MAX_SUBAGENT_CALLS_PER_PARENT_RUN = 5;
export const VALID_SUBAGENT_TYPES = ["worker", "explore"] as const;
export type SubagentType = (typeof VALID_SUBAGENT_TYPES)[number];

export const EXPLORE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_files",
  "search_in_files",
  "find_references",
]);

export const EXPLORE_MAX_ITERATIONS = 8;

export function subagentTypeAllowedTools(type: SubagentType): ReadonlySet<string> {
  return type === "explore" ? EXPLORE_ALLOWED_TOOLS : WORKER_ALLOWED_TOOLS;
}

export function subagentTypeMaxIterations(type: SubagentType): number {
  return type === "explore" ? EXPLORE_MAX_ITERATIONS : WORKER_MAX_ITERATIONS;
}

const subagentCallCounts = new Map<string, number>();

export function getSubagentCallCount(parentRunId: string): number {
  return subagentCallCounts.get(parentRunId) ?? 0;
}

export function incrementSubagentCallCount(parentRunId: string): number {
  const next = (subagentCallCounts.get(parentRunId) ?? 0) + 1;
  subagentCallCounts.set(parentRunId, next);
  return next;
}

export function resetSubagentCallCount(parentRunId: string): void {
  subagentCallCounts.delete(parentRunId);
}

export interface SubagentSummary {
  subagentId: string;
  status: "completed" | "failed" | "partial";
  summary: string;
  filesModified: string[];
  notes?: string;
}

const SUMMARY_MAX_CHARS = 500;

function truncateSummary(text: string): string {
  const trimmed = String(text || "").trim();
  if (trimmed.length <= SUMMARY_MAX_CHARS) return trimmed;
  return trimmed.slice(0, SUMMARY_MAX_CHARS - 15).trimEnd() + "... [truncated]";
}

function parseFiles(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return [];
  return trimmed
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Parses the structured tail block from a worker's final summary text.
 * Falls back to a partial summary when any required field is missing or out of
 * order, so parent runs can continue even if the worker ignores the format.
 */
export function parseWorkerSummary(rawSummary: string): {
  status: SubagentSummary["status"] | "success";
  summary: string;
  filesModified: string[];
  notes?: string;
} {
  const raw = String(rawSummary || "").trim();
  const match = raw.match(
    /(?:^|\n)SUMMARY:\s*([\s\S]*?)\nFILES_MODIFIED:\s*([^\n]*)\nSTATUS:\s*(success|completed|failed|partial)\s*(?:\nNOTES:\s*([^\n]*))?\s*$/i
  );
  if (!match) {
    return {
      status: "partial",
      summary: truncateSummary(raw),
      filesModified: [],
    };
  }
  return {
    status: match[3]!.toLowerCase() as SubagentSummary["status"],
    summary: truncateSummary(match[1] ?? ""),
    filesModified: parseFiles(match[2] ?? ""),
    notes: match[4]?.trim() || undefined,
  };
}

export function formatSubagentSummaryForParent(
  result: AgentLoopResult,
  subagentId: string
): string {
  const parsed = parseWorkerSummary(result.summary ?? "");
  const parsedStatus =
    parsed.status === "success" ? "completed" : parsed.status;
  const summary: SubagentSummary = {
    subagentId,
    status: result.success ? parsedStatus : "failed",
    summary: parsed.summary || result.summary || "(no summary)",
    filesModified:
      parsed.filesModified.length > 0 ? parsed.filesModified : result.filesModified ?? [],
    notes: parsed.notes,
  };
  return JSON.stringify(summary);
}

export function formatSubagentToolResultForParent(
  result: AgentLoopResult,
  subagentId: string
): { success: true; output: string } {
  return {
    success: true,
    output: formatSubagentSummaryForParent(result, subagentId),
  };
}

export interface ExploreFinding {
  path: string;
  line?: number;
  note: string;
}

export interface ExploreSummary {
  findings: ExploreFinding[];
  summary: string;
  status: "completed" | "partial" | "failed";
  rawSummary?: string;
}

/**
 * Parses the structured tail block from an Explore subagent's final output.
 * Expected format:
 *   FINDINGS:\n- path:line — note\n...\nSUMMARY: ...\nSTATUS: completed|partial|failed
 */
export function parseExploreSummary(rawOutput: string): ExploreSummary {
  const raw = String(rawOutput || "").trim();

  const match = raw.match(
    /(?:^|\n)FINDINGS:\s*([\s\S]*?)\nSUMMARY:\s*([\s\S]*?)\nSTATUS:\s*(completed|partial|failed)\s*$/i
  );
  if (!match) {
    return {
      findings: [],
      summary: raw.slice(0, 500),
      status: "partial",
      rawSummary: raw,
    };
  }

  const findingsRaw = String(match[1] ?? "").trim();
  const findings: ExploreFinding[] = findingsRaw
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const dashIdx = line.indexOf(" — ");
      if (dashIdx === -1) return { path: line, note: "" };
      const loc = line.slice(0, dashIdx).trim();
      const note = line.slice(dashIdx + 3).trim();
      const colonIdx = loc.lastIndexOf(":");
      if (colonIdx > 0) {
        const maybeNum = Number(loc.slice(colonIdx + 1));
        if (Number.isInteger(maybeNum) && maybeNum > 0) {
          return { path: loc.slice(0, colonIdx), line: maybeNum, note };
        }
      }
      return { path: loc, note };
    });

  return {
    findings,
    summary: truncateSummary(String(match[2] ?? "").trim()),
    status: match[3]!.toLowerCase() as ExploreSummary["status"],
  };
}

export function formatExploreSubagentSummaryForParent(
  result: AgentLoopResult,
  subagentId: string
): string {
  const parsed = parseExploreSummary(result.summary ?? "");
  const payload = {
    subagentId,
    status: result.success ? parsed.status : "failed",
    summary: parsed.summary || result.summary || "(no summary)",
    findings: parsed.findings,
  };
  return JSON.stringify(payload);
}

export function formatExploreSubagentToolResultForParent(
  result: AgentLoopResult,
  subagentId: string
): { success: true; output: string } {
  return {
    success: true,
    output: formatExploreSubagentSummaryForParent(result, subagentId),
  };
}
