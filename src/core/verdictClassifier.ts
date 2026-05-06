/**
 * Verdict-fix Tur: classifies the agent's run_command tool calls into
 * verification-relevant categories (test / build / typecheck) so the UI can
 * show honest verdict messaging instead of a static "Tests skipped — No test
 * infrastructure found" line even when the agent ran `npm run build` or
 * `npx tsc --noEmit`.
 *
 * Pure module — string regex + tool-log iteration, no I/O. Lives next to
 * runLlmPatchFlow so the agent_loop return site can populate the field
 * without pulling in the full classifier from a far-flung helper.
 */

export type VerificationCommandCategory = "test" | "build" | "typecheck";
export type VerificationCommandOutcome = "passed" | "failed" | "unknown";

export interface VerificationCommand {
  /** Exact command string the agent ran (truncated to 240 chars to keep payloads small). */
  command: string;
  category: VerificationCommandCategory;
  outcome: VerificationCommandOutcome;
}

/**
 * Classifies a raw command string. Returns null when the command is not a
 * recognized verification tool (e.g. `ls`, `git status`, `cat`).
 *
 * Match priority: typecheck > test > build (so `npx tsc` wins over a
 * pathological `npm test` substring, and `vitest` wins over a literal
 * `build` token elsewhere).
 */
export function classifyVerificationCommand(
  command: string
): VerificationCommandCategory | null {
  const cmd = String(command ?? "").trim().toLowerCase();
  if (!cmd) return null;

  // Typecheck — matches both `tsc` and `npx tsc` / `pnpm tsc` / `yarn tsc`.
  if (/(?:^|\s|\/)tsc(?:\s|$)/.test(cmd)) return "typecheck";

  // Test runners.
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(cmd)) return "test";
  if (/\bvitest\b/.test(cmd)) return "test";
  if (/\bjest\b/.test(cmd)) return "test";
  if (/\bplaywright\s+test\b/.test(cmd)) return "test";
  if (/\bcypress\s+run\b/.test(cmd)) return "test";

  // Build commands.
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/.test(cmd)) return "build";
  if (/\bnext\s+build\b/.test(cmd)) return "build";
  if (/\bvite\s+build\b/.test(cmd)) return "build";

  return null;
}

/**
 * Derives outcome from a tool result. `success === true` → passed; `false` →
 * failed; missing → unknown (so the UI can show neutral language).
 */
export function classifyVerificationOutcome(
  result: { success?: boolean | null | undefined } | null | undefined
): VerificationCommandOutcome {
  if (!result) return "unknown";
  if (result.success === true) return "passed";
  if (result.success === false) return "failed";
  return "unknown";
}

/**
 * Extracts verification commands from an agent's tool-call log. Iterates in
 * order; non-`run_command` entries and unclassifiable commands are skipped.
 * Result preserves order so callers can take "last wins" for tie-breaking.
 *
 * The shape matches `AgentLoopResult["toolCallLog"]` from agentLoop.ts but is
 * loose-typed so this module stays decoupled.
 */
export function collectVerificationCommands(
  toolCallLog:
    | Array<{
        tool?: string;
        args?: Record<string, unknown> | null;
        result?: string | { success?: boolean } | null;
        success?: boolean;
      }>
    | null
    | undefined
): VerificationCommand[] {
  if (!Array.isArray(toolCallLog)) return [];
  const out: VerificationCommand[] = [];
  for (const entry of toolCallLog) {
    if (!entry || entry.tool !== "run_command") continue;
    const command = String(entry.args?.["command"] ?? "").trim();
    if (!command) continue;
    const category = classifyVerificationCommand(command);
    if (!category) continue;
    // Tool-call log entries from agentLoop carry `success` at the entry level
    // (not inside `result` which is a string). Fall back to result.success
    // for callers that pass the raw ToolResult shape.
    const successFlag =
      typeof entry.success === "boolean"
        ? entry.success
        : typeof entry.result === "object" && entry.result !== null && "success" in entry.result
          ? (entry.result as { success?: boolean }).success
          : undefined;
    const outcome = classifyVerificationOutcome({ success: successFlag });
    out.push({
      command: command.slice(0, 240),
      category,
      outcome,
    });
  }
  return out;
}
