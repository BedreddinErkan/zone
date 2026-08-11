/**
 * Task-shape heuristics for plan-mode gating.
 * The prompt carve-outs in planInvestigation.ts and executionPlan.ts must stay
 * conceptually in sync with ADDITIVE_LEAD_VERBS.
 */

/** Lead verbs that introduce additive/structural work — no pre-existing problem to reproduce. */
export const ADDITIVE_LEAD_VERBS = [
  "add", "create", "implement", "build", "scaffold", "introduce", "generate",
  "write", "set up", "make", "new", "refactor", "rename", "extract", "migrate", "convert",
] as const;

/** Problem-signalling words indicating the task asserts a pre-existing defect. */
export const PROBLEM_WORDS = [
  "fix", "bug", "error", "fail", "broken", "crash", "exception", "regression",
  "repro", "stack trace", "not working", "incorrect", "wrong", "stale", "hang", "leak",
] as const;

// NOTE: keep in sync with ADDITIVE_LEAD_VERBS and PROBLEM_WORDS above.
const ADDITIVE_RE = /^(add|create|implement|build|scaffold|introduce|generate|write|set ?up|make|new|refactor|rename|extract|migrate|convert)\b/i;
const PROBLEM_RE  = /\b(fix|bug|error|fails?|failing|failed|broken|crash(?:es)?|exception|regress\w*|repro\w*|stack ?trace|throws?|not working|doesn'?t work|why\s+(?:does|is|did)\b|incorrect|wrong|stale|hang|leak)\b/i;

/**
 * True when the task asserts a pre-existing defect that may or may not reproduce
 * (fix/debug). Additive/structural tasks (create/add/implement/refactor) return
 * false — there is no pre-existing problem to verify, so a no_change/cannot_verify
 * verdict would be a misfire.
 *
 * Ordering: additive lead-verb is checked FIRST, so "add error handling" → false
 * (not a problem assertion despite containing "error").
 */
export function taskAssertsProblem(task: string): boolean {
  if (ADDITIVE_RE.test(task.trim())) return false;
  return PROBLEM_RE.test(task);
}

/**
 * True when the task text contains a problem-signalling word — no additive-lead-verb
 * short-circuit, unlike taskAssertsProblem. "add error handling" returns true here.
 *
 * Exists so a caller can pair this with its own additive/structural distinction
 * (isPureAddition) instead of inheriting taskAssertsProblem's, which excludes every
 * ADDITIVE_LEAD_VERB — including refactor/rename/extract/migrate/convert, verbs
 * isPureAddition already treats as needing investigation, not as safe to skip.
 */
export function problemWordsPresent(task: string): boolean {
  return PROBLEM_RE.test(task);
}

/** Lead verbs that introduce BRAND-NEW code without touching existing logic.
 *  Subset of ADDITIVE_LEAD_VERBS that EXCLUDES structural verbs
 *  (refactor/rename/extract/migrate/convert — blast radius into existing code) and the
 *  ambiguous "make" ("make Y robust" = modify). Those must be investigated, not guessed. */
export const PURE_ADDITION_LEAD_VERBS = [
  "add", "create", "implement", "build", "scaffold", "introduce", "generate", "write", "set up", "new",
] as const;

// keep in sync with PURE_ADDITION_LEAD_VERBS above
const PURE_ADDITION_RE = /^(add|create|implement|build|scaffold|introduce|generate|write|set ?up|new)\b/i;

/**
 * Leading text that carries no bearing on whether the task is a pure addition but
 * sits ahead of the lead verb PURE_ADDITION_RE anchors on, defeating the match.
 * Two shapes, each justified by a measured case, not a general filler scan:
 *
 * - FRAMING: a closed set of request-framing phrases a same-intent rephrasing can
 *   prepend with zero added meaning (please / can you / I need you to / let's).
 *   Measured directly — a perturbation harness applying these four exact templates
 *   flipped isPureAddition on every additive task it touched and none of the rest.
 * - LOCATIVE: "In <path>, " naming the target file before the instruction. Requires
 *   the pre-comma token to contain "/" or "." (file-path-shaped) rather than
 *   matching any leading comma-clause — "In general, add X" is not the same claim
 *   as a file reference, and a bare "In <name> <verb>" with no comma (no locative
 *   clause to strip at all) is deliberately left alone.
 *
 * Applied once each, framing then locative, not looped to a fixed point — a task
 * chaining more than one such clause is outside the two shapes this was built for.
 */
const LEADING_FRAMING_RE = /^(please|can you|i need you to|let'?s)\s+/i;
const LEADING_LOCATIVE_RE = /^in\s+[^\s,]*[./][^\s,]*,\s*/i;

function stripLeadingPreamble(task: string): string {
  return task.trim().replace(LEADING_FRAMING_RE, "").replace(LEADING_LOCATIVE_RE, "");
}

/**
 * True ONLY for clear pure-addition tasks — adding brand-new code that doesn't touch existing
 * logic (add/create/scaffold/…). Structural verbs (refactor/rename/extract/migrate/convert),
 * the ambiguous "make", all problem tasks, and all unrecognized/ambiguous phrasings return false.
 *
 * The plan-mode gate's fail-safe skip predicate: investigate by default, drop to cheap lexical
 * planning ONLY when this returns true. When in doubt → false → investigate.
 */
export function isPureAddition(task: string): boolean {
  return PURE_ADDITION_RE.test(stripLeadingPreamble(task));
}

/**
 * The lead-verb PURE_ADDITION_RE actually matched, lowercased, or null when
 * isPureAddition would return false. Exposed for telemetry — the plan-mode
 * gate needs to record what its decision keyed on, not just the boolean
 * result, since [zone-plan-mode]'s `mode` field alone can't be trusted when
 * an env override forced a branch independent of what this predicate says.
 *
 * Reads the same stripped text isPureAddition decides on, so a returned verb can
 * be one the raw task string does not itself start with (e.g. "add" for "Please
 * add X"). Intentional: this describes what the router decided on, not the raw
 * string — a later reader comparing [zone-plan-mode]'s leadVerb field against the
 * task text should expect that mismatch, not read it as a bug.
 */
export function matchedLeadVerb(task: string): string | null {
  return PURE_ADDITION_RE.exec(stripLeadingPreamble(task))?.[0]?.toLowerCase() ?? null;
}
