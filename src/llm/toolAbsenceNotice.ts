import { resolveToolList } from "../tools/toolRegistry.js";

export type ToolAbsenceFilterSource =
  | "capabilityFilter"
  | "tierFilterFromClassifier"
  | "allowedTools"
  | "modeDefault"
  | "none";

export interface ToolAbsenceInput {
  offeredToolNames: ReadonlySet<string>;
  filterSource: ToolAbsenceFilterSource;
  tier?: string;
  archetype?: string;
  mode?: string;
}

function describeCause(input: ToolAbsenceInput): string {
  switch (input.filterSource) {
    case "tierFilterFromClassifier":
      return `this task's tier (${input.tier ?? "unknown"})`;
    case "capabilityFilter":
      return `this task's archetype (${input.archetype ?? "unknown"})`;
    case "modeDefault":
      return `this run's mode (${input.mode ?? "unknown"})`;
    case "allowedTools":
      // No semantic reason is recoverable here — the restriction is a caller-
      // supplied list, not a tier/archetype/mode decision. Name the caller,
      // not an invented justification.
      return "a tool list set by the caller";
    case "none":
    default:
      // Reachable when no capability filter was selected at all but the
      // offered set is still short of the full registry — excludeTools or
      // the subagent-budget Task-hide, neither a tier/archetype/mode fact.
      return "this run's own configuration";
  }
}

/**
 * Renders a system-prompt block naming every tool withheld from this run and
 * why, or "" when nothing is withheld. Deterministic for a given
 * (offeredToolNames, filterSource, tier, archetype, mode) tuple: the absent
 * list is sorted explicitly rather than left to the registry's own insertion
 * order, and nothing here varies by run beyond those inputs — no timestamp,
 * no count that isn't a function of the tool sets themselves. That stability
 * is what keeps this affordable in the cached system-prompt prefix; a block
 * that varied per run would defeat the cache it is meant to sit inside.
 *
 * Does not invite a request for an absent tool — no such path exists, and
 * telling the agent to ask for one it cannot receive is worse than the
 * silence this replaces.
 */
export function buildToolAbsenceBlock(input: ToolAbsenceInput): string {
  const fullNames = resolveToolList(undefined).map((t) => t.name);
  const absentRaw = fullNames.filter((name) => !input.offeredToolNames.has(name));
  // A withheld name that is a strict prefix of an OFFERED name reads as covering that
  // offered tool: measured (this arc's behavioural establish, seven ground tasks,
  // question archetype) to make an agent holding run_command_readonly stop using the
  // shell entirely and report two false negatives, once "run_command" was named
  // withheld alongside it. Suppressed in this direction only. The reverse — a
  // withheld name is a prefix OF an offered name (e.g. run_command_readonly withheld
  // while run_command is offered, at tier=simple/medium) — is left alone: the offered
  // tool there is a strict superset, so naming the narrower sibling absent is true and
  // harmless, not misleading, and there is no measured reason to drop it.
  const offeredList = [...input.offeredToolNames];
  const absent = absentRaw
    .filter((name) => !offeredList.some((offered) => offered !== name && offered.startsWith(name)))
    .sort();
  if (absent.length === 0) return "";

  return (
    `TOOLS NOT AVAILABLE THIS RUN — withheld by ${describeCause(input)}, not a permission error: ` +
    `${absent.join(", ")}. Do not attempt these via another tool or a shell workaround.\n\n`
  );
}
