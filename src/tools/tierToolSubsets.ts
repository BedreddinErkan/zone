import type { CapabilityFilter } from "./capabilities.js";
import type { TaskTier } from "../llm/taskClassifier.js";

// Core read/write/patch/execute — sufficient for single-file tasks.
export const SIMPLE_TIER_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "apply_patch",
  "multi_edit",
  "run_command",
]);

// Adds exploration + planning tools needed for multi-file work.
export const MEDIUM_TIER_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "apply_patch",
  "multi_edit",
  "run_command",
  "search_in_files",
  "list_files",
  "find_references",
  "TodoWrite",
]);

/**
 * Returns a CapabilityFilter restricting tools to the tier-appropriate subset,
 * or undefined for complex tier (no restriction — full toolset).
 *
 * Callers must apply the subagent guard (skip when isSubagentLoop=true) so that
 * worker/explore subagents inherit the parent's explicit capabilityFilter rather
 * than a tier-derived subset.
 *
 * Task (subagent dispatch) is intentionally absent from simple/medium — complex-tier-only
 * via the full toolset (undefined return). See AUDIT-subagent-adoption.md §B.#1 for the
 * cost rationale: a fresh-context worker re-reads files and returns a lossy summary,
 * making dispatch cost-negative on typical single/medium tasks.
 *
 * Two more enforcement points key off the same judgment without sharing this
 * source: agentLoop.ts's taskBlockedByBudget strips Task from the array
 * actually sent to the provider regardless of this filter, and
 * toolExecutor.ts's effectiveSubagentCap independently refuses the call at
 * runtime. Lifting only this filter does not make Task usable below complex
 * tier.
 */
export function tierToolFilter(tier: TaskTier): CapabilityFilter | undefined {
  if (tier === "simple") return { allowToolNames: SIMPLE_TIER_TOOLS };
  if (tier === "medium") return { allowToolNames: MEDIUM_TIER_TOOLS };
  return undefined;
}
