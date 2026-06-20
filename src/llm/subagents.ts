import type { AgentLoopResult } from "./agentLoop.js";
import { READ_ONLY_TOOLS } from "../tools/toolDefinitions.js";

export const WORKER_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_files",
  "search_in_files",
  "apply_patch",
  "write_file",
  // NOTE: deliberately excluded for MVP — run_command, update_memory, Task,
  // background-process tools, get_dependencies, etc.
]);

export const MAX_SUBAGENT_CALLS_PER_PARENT_RUN = 2; // K.2: tightened from 5 to 2 (defensive)
export const VALID_SUBAGENT_TYPES = ["worker", "explore"] as const;
export type SubagentType = (typeof VALID_SUBAGENT_TYPES)[number];

export const EXPLORE_ALLOWED_TOOLS: ReadonlySet<string> = new Set(READ_ONLY_TOOLS);

/** Phase AS: audit-phase toolset — read-only tools, suggest_scope_change, and run_command_readonly. */
export const AUDIT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ...READ_ONLY_TOOLS,
  "suggest_scope_change",
  "run_command_readonly", // Phase G: reproduce failing tests, run typecheck, inspect runtime behavior
]);

// Phase H.6: plan-aware iteration budgets. Floor protects single-question
// runs; ceiling caps unbounded plans; per-step factor scales with plan size.
export const EXPLORE_ITER_FLOOR = 15;
export const EXPLORE_ITER_CEILING = 40;
export const EXPLORE_ITER_PER_STEP = 6;

export const WORKER_ITER_FLOOR = 6; // K.2: tightened from 20 → 6
export const WORKER_ITER_CEILING = 24; // K.2: tightened from 60 → 24
export const WORKER_ITER_PER_STEP = 4; // K.2: tightened from 8 → 4

export function computeExploreMaxIterations(planStepsCount: number): number {
  const steps = Math.max(1, planStepsCount || 1);
  return Math.min(
    EXPLORE_ITER_CEILING,
    Math.max(EXPLORE_ITER_FLOOR, steps * EXPLORE_ITER_PER_STEP)
  );
}

export function computeWorkerMaxIterations(planStepsCount: number): number {
  const steps = Math.max(1, planStepsCount || 1);
  return Math.min(
    WORKER_ITER_CEILING,
    Math.max(WORKER_ITER_FLOOR, steps * WORKER_ITER_PER_STEP)
  );
}

// Backward-compat: old constants now equal the plan-unaware floor.
export const EXPLORE_MAX_ITERATIONS = EXPLORE_ITER_FLOOR;
export const WORKER_MAX_ITERATIONS = WORKER_ITER_FLOOR;

/** @deprecated Use resolveSubagentCapabilityFilter from subagentDispatch.ts instead. */
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
  parentRunId: string;
  status:
    | "completed"
    | "failed"
    | "partial"
    | "max_iterations"
    | "token_budget_exceeded";
  summary: string;
  tokenUsage: SubagentTokenUsage;
  costUsd: number;
  filesModified: string[];
  notes?: string;
}

export interface SubagentTokenUsage {
  input: number;
  output: number;
  cached: number;
  total: number;
  perIter?: number[];
}

export interface SubagentResult extends SubagentSummary {}

const SUMMARY_MAX_CHARS = 500;

export function emptySubagentTokenUsage(): SubagentTokenUsage {
  return {
    input: 0,
    output: 0,
    cached: 0,
    total: 0,
    perIter: [],
  };
}

function normalizeTokenUsage(raw: unknown): SubagentTokenUsage {
  if (!raw || typeof raw !== "object") return emptySubagentTokenUsage();
  const usage = raw as Record<string, unknown>;
  const input = Math.max(0, Number(usage.input ?? 0) || 0);
  const output = Math.max(0, Number(usage.output ?? 0) || 0);
  const cached = Math.max(0, Number(usage.cached ?? 0) || 0);
  const total = Math.max(0, Number(usage.total ?? input + output) || 0);
  const perIter = Array.isArray(usage.perIter)
    ? usage.perIter
        .map((value) => Math.max(0, Number(value ?? 0) || 0))
        .filter((value) => value > 0)
    : [];
  return {
    input,
    output,
    cached,
    total,
    perIter,
  };
}

function statusFromAgentResult(
  result: AgentLoopResult,
  parsedStatus: SubagentSummary["status"] | "success"
): SubagentSummary["status"] {
  if (result.terminationReason === "token_budget_exceeded") {
    return "token_budget_exceeded";
  }
  if (result.terminationReason === "max_iterations" && !result.success) {
    return "max_iterations";
  }
  if (!result.success) return "failed";
  return parsedStatus === "success" ? "completed" : parsedStatus;
}

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

function buildWorkerSummary(
  result: AgentLoopResult,
  subagentId: string,
  parentRunId: string
): { status: SubagentSummary["status"]; output: string } {
  const parsed = parseWorkerSummary(result.summary ?? "");
  const status = statusFromAgentResult(result, parsed.status);
  const summary: SubagentSummary = {
    subagentId,
    parentRunId,
    status,
    summary: parsed.summary || result.summary || "(no summary)",
    tokenUsage: normalizeTokenUsage(result.tokenUsage),
    costUsd: result.costUsd ?? 0,
    filesModified:
      parsed.filesModified.length > 0 ? parsed.filesModified : result.filesModified ?? [],
    notes: parsed.notes,
  };
  return { status, output: JSON.stringify(summary) };
}

export function formatSubagentSummaryForParent(
  result: AgentLoopResult,
  subagentId: string,
  parentRunId = ""
): string {
  return buildWorkerSummary(result, subagentId, parentRunId).output;
}

export function formatSubagentToolResultForParent(
  result: AgentLoopResult,
  subagentId: string,
  parentRunId = ""
): { success: boolean; output: string } {
  const { status, output } = buildWorkerSummary(result, subagentId, parentRunId);
  return { success: status === "completed" || status === "partial", output };
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

function buildExploreSummary(
  result: AgentLoopResult,
  subagentId: string,
  parentRunId: string
): { status: SubagentSummary["status"]; output: string } {
  const parsed = parseExploreSummary(result.summary ?? "");
  const status = statusFromAgentResult(result, parsed.status);
  const payload = {
    subagentId,
    parentRunId,
    status,
    summary: parsed.summary || result.summary || "(no summary)",
    tokenUsage: normalizeTokenUsage(result.tokenUsage),
    costUsd: result.costUsd ?? 0,
    findings: parsed.findings,
  };
  return { status, output: JSON.stringify(payload) };
}

export function formatExploreSubagentSummaryForParent(
  result: AgentLoopResult,
  subagentId: string,
  parentRunId = ""
): string {
  return buildExploreSummary(result, subagentId, parentRunId).output;
}

export function formatExploreSubagentToolResultForParent(
  result: AgentLoopResult,
  subagentId: string,
  parentRunId = ""
): { success: boolean; output: string } {
  const { status, output } = buildExploreSummary(result, subagentId, parentRunId);
  return { success: status === "completed" || status === "partial", output };
}
