import type { FsConversationEvent } from "../core/conversationFilesystemStore.js";

export const SESSION_WINDOW_MAX_BYTES = 4096;
export const TURN_SUMMARY_MAX_BYTES = 2048;
export const USER_PROMPT_MAX_BYTES = 256;
export const MAX_CHANGED_FILES = 12;

const TRUNCATE_NOTICE = "[…truncated…]\n";
// Byte cap after reserving space for the truncation notice
const TURN_SUMMARY_BODY_MAX = TURN_SUMMARY_MAX_BYTES - TRUNCATE_NOTICE.length;

/**
 * Neutral truncator for per-turn summaries — does NOT special-case APPLY_ROLLED_BACK.
 * Keeps the TAIL of the text (most recent content is most relevant) and strips any
 * surviving rollback marker so it never appears under a neutral SESSION MEMORY header.
 */
export function truncateSessionTurn(text: string): string {
  let s = String(text ?? "");
  if (s.length > TURN_SUMMARY_MAX_BYTES) {
    s = TRUNCATE_NOTICE + s.slice(-TURN_SUMMARY_BODY_MAX);
  }
  // Strip any surviving APPLY_ROLLED_BACK text — neutral framing must never carry
  // the rollback marker vocabulary.
  s = s.replace(/APPLY_ROLLED_BACK[^\n]*/g, "(no net change remained during that turn)");
  return s;
}

/** Represents one turn extracted from the JSONL event store. */
interface TurnEvent {
  /** Index from the original event array (oldest = lowest). Used for Turn N numbering. */
  originalIndex: number;
  userPrompt: string;
  summary: string;
  changedFiles: string[];
}

function extractTurns(events: FsConversationEvent[]): TurnEvent[] {
  const turns: TurnEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "turn") continue;
    const userPrompt = typeof e.userPrompt === "string" ? e.userPrompt : "";
    // Pass the stored summary through truncateSessionTurn to ensure rollback markers
    // are stripped even if the write path didn't sanitize them (defensive).
    const rawSummary = typeof e.summary === "string" ? e.summary : "";
    const summary = rawSummary ? truncateSessionTurn(rawSummary) : "";
    // Skip turns that carry no useful information
    if (!userPrompt && !summary) continue;
    const cf = Array.isArray(e.changedFiles)
      ? (e.changedFiles as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    turns.push({ originalIndex: i, userPrompt, summary, changedFiles: cf });
  }
  return turns;
}

function renderTierA(turn: TurnEvent, turnNumber: number): string {
  let s = `Turn ${turnNumber} — you asked: "${turn.userPrompt}"`;
  if (turn.summary) s += `\n   result: ${turn.summary}`;
  if (turn.changedFiles.length > 0) s += `\n   files: ${turn.changedFiles.join(", ")}`;
  return s;
}

function renderTierB(turn: TurnEvent): string {
  // Intent + paths only — no summary, no outcome (framing-drift guard)
  const intent = turn.userPrompt.slice(0, 80);
  let s = `earlier you asked to "${intent}"`;
  if (turn.changedFiles.length > 0) s += `; files: ${turn.changedFiles.join(", ")}`;
  return s;
}

/**
 * Build a tiered, hard-capped multi-turn session window string.
 *
 * Pure and synchronous — no I/O, no Date.now(), no random.
 * Byte-identical output for identical input (within-run cache stability).
 *
 * Tier A: newest turn at full fidelity.
 * Tier B: older turns as one-line intent+paths summaries.
 * Hard cap: SESSION_WINDOW_MAX_BYTES on the assembled string including framing.
 * Empty window: returns "" (sessionMemBlock will be omitted from the user message).
 */
export function buildSessionWindow(events: FsConversationEvent[]): string {
  const turns = extractTurns(events);
  if (turns.length === 0) return "";

  // Assign turn numbers oldest→newest (1-indexed).
  // turns[] is already oldest-first (events are stored in append order).
  const numberedTurns = turns.map((t, i) => ({ ...t, number: i + 1 }));

  // Newest turn = last element
  const newest = numberedTurns[numberedTurns.length - 1];

  // Tier A: render newest turn at full fidelity.
  // If its raw rendering exceeds the cap, degrade the summary until it fits.
  let tierA = renderTierA(newest, newest.number);
  if (tierA.length > SESSION_WINDOW_MAX_BYTES) {
    // Degrade: fit the summary to leave room for the rest of Tier A
    const overhead = tierA.length - newest.summary.length;
    const summaryBudget = Math.max(0, SESSION_WINDOW_MAX_BYTES - overhead - 4);
    const degradedSummary = newest.summary.slice(0, summaryBudget) + "…";
    tierA = renderTierA({ ...newest, summary: degradedSummary }, newest.number);
  }

  // Collect Tier B lines (older turns, newest→oldest), prepend while under cap.
  const tierBLines: string[] = [];
  let assembledLength = tierA.length;

  for (let i = numberedTurns.length - 2; i >= 0; i--) {
    const t = numberedTurns[i];
    const line = renderTierB(t);
    const wouldBe = assembledLength + 1 /* newline */ + line.length;
    if (wouldBe > SESSION_WINDOW_MAX_BYTES) break;
    tierBLines.push(line);
    assembledLength = wouldBe;
  }

  // Compose: Tier B (oldest→newest order for readability) + Tier A
  const parts: string[] = [];
  for (let i = tierBLines.length - 1; i >= 0; i--) {
    parts.push(tierBLines[i]);
  }
  parts.push(tierA);

  return parts.join("\n");
}
