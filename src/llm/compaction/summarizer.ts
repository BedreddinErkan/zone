import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMClient } from "../types.js";
import { getModelName } from "../openaiClient.js";
import { AUX_CALL_MAX_OUTPUT_TOKENS } from "../models.js";

export interface SummarizerInput {
  candidateTurns: ChatCompletionMessageParam[];
  totalCandidates: number;
  client: LLMClient;
  runId: string | undefined;
  compactionDepth: number;   // 1-indexed compaction count; drives tiered prompt (J.4)
}

export interface SummarizerOutput {
  summaryText: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Build the summarization prompt for the given compaction depth (J.4 tiered degradation).
 *
 * Tier 1 (depth 1-2): full task-shaped summary — context is still wide, preserve detail.
 * Tier 2 (depth 3-4): structured bullets only — context is tightening, force brevity.
 * Tier 3 (depth 5):   minimal three-section — only load-bearing facts survive.
 *
 * J.1/J.2 pins (audit + failures) already live outside the summary, so tighter tiers
 * lose only exploratory chatter — not the critical state.
 */
export function buildSummarizationPrompt(
  _turns: ChatCompletionMessageParam[],
  nextCount: number
): string {
  const tier = nextCount <= 2 ? 1 : nextCount <= 4 ? 2 : 3;
  const base = "You are summarizing intermediate steps from an autonomous coding agent run to free up context budget.";

  if (tier === 1) {
    return `${base}

The agent will continue executing AFTER your summary, so preserve any information that would change its next decisions.

Produce a task-shaped summary covering:

1. Current task: what the user is asking the agent to accomplish
2. Tool activity: count of each tool used (e.g., "read_file: 12, list_files: 3")
3. Files explored: list of paths the agent has already read or listed
4. Key findings: brief bullets of what the agent learned
5. Dead ends: brief bullets of approaches tried that failed or were abandoned (so the agent does not retry)
6. Open questions: any pending decisions or unknowns

Keep the entire summary under 600 words (~1500 tokens). Do not invent details. If a section has no content, omit it.

Output ONLY the summary text — no preamble, no JSON, no markdown headers.`;
  }

  if (tier === 2) {
    return `${base}

Compaction depth ${nextCount}/5 — context is tightening. Produce a tight bullet summary with required headers:

## Task
- One sentence: current goal

## Files touched
- path: change/intent summary (one line each, max 5)

## Recent failures
- tool: failure mode (one line each, max 3)

## Open questions
- pending decisions (one line each, max 3)

Total budget: ~800 tokens. All four headers required; omit bullet if section is empty.

Output ONLY the structured text — no preamble.`;
  }

  // Tier 3 — compaction 5, one step before exhaustion
  return `${base}

Compaction depth 5/5 — minimal context only. Produce exactly three sections:

## Task
One sentence stating the current goal.

## Last failure
One sentence: what failed most recently and why.

## Open question
One sentence: what decision or information blocks progress.

Total budget: ≤500 tokens. No prose between sections. If a section has no content, write "(none)".

Output ONLY the structured text — no preamble.`;
}

export async function summarize(input: SummarizerInput): Promise<SummarizerOutput> {
  const model = getModelName("standard", input.client.provider);

  const serialized = input.candidateTurns
    .map((t, i) => `--- Turn ${i} (${t.role}) ---\n${stringifyTurn(t)}`)
    .join("\n\n");

  const systemPrompt = buildSummarizationPrompt(input.candidateTurns, input.compactionDepth);

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Summarize the following ${input.totalCandidates} turns:\n\n${serialized}`,
    },
  ];

  // Bounded: SUMMARY_OUTPUT_BUDGET targets ~1500 tokens of summary, so the model
  // ceiling this would otherwise inherit is orders of magnitude past what it needs.
  const response = await input.client.createChatCompletion({
    model,
    messages,
    max_tokens: AUX_CALL_MAX_OUTPUT_TOKENS,
  });

  const rawUsage = (response as { usage?: { prompt_tokens?: number; completion_tokens?: number } })
    .usage;

  return {
    summaryText: extractText(response),
    inputTokens: rawUsage?.prompt_tokens,
    outputTokens: rawUsage?.completion_tokens,
  };
}

function stringifyTurn(turn: ChatCompletionMessageParam): string {
  if (turn.role === "tool") {
    const content = typeof turn.content === "string" ? turn.content : "";
    return `[tool_result] ${content.slice(0, 4000)}`;
  }
  if (turn.role === "assistant") {
    const text = typeof turn.content === "string" ? turn.content : "";
    const calls =
      turn.tool_calls
        ?.filter((c) => c.type === "function")
        .map((c) => `[tool_call ${(c as { type: "function"; function: { name: string } }).function.name}]`)
        .join(" ") ?? "";
    return `${text}\n${calls}`.trim();
  }
  return typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content);
}

function extractText(response: { choices?: Array<{ message?: { content?: string | null } }> }): string {
  return response.choices?.[0]?.message?.content?.trim() ?? "";
}
