import type { CapabilityFilter } from "./capabilities.js";
import type { TaskTier } from "../llm/taskClassifier.js";

// Core read/write/patch/execute — sufficient for single-file tasks.
export const SIMPLE_TIER_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "apply_patch",
  "run_command",
]);

// Adds exploration + planning tools needed for multi-file work.
export const MEDIUM_TIER_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "apply_patch",
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
 */
export function tierToolFilter(tier: TaskTier): CapabilityFilter | undefined {
  if (tier === "simple") return { allowToolNames: SIMPLE_TIER_TOOLS };
  if (tier === "medium") return { allowToolNames: MEDIUM_TIER_TOOLS };
  return undefined;
}
