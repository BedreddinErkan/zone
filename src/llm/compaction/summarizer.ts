import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMClient } from "../types.js";
import { getModelName } from "../openaiClient.js";

export interface SummarizerInput {
  candidateTurns: ChatCompletionMessageParam[];
  totalCandidates: number;
  client: LLMClient;
  runId: string | undefined;
}

export interface SummarizerOutput {
  summaryText: string;
  inputTokens?: number;
  outputTokens?: number;
}

const SUMMARIZER_PROMPT = `You are summarizing intermediate steps from an autonomous coding agent run to free up context budget.

The agent will continue executing AFTER your summary, so preserve any information that would change its next decisions.

Produce a compact summary covering:

1. Tool activity: count of each tool used (e.g., "read_file: 12, list_files: 3, search_in_files: 4")
2. Files explored: list of paths the agent has already read or listed
3. Key findings: brief bullets of what the agent learned
4. Dead ends: brief bullets of approaches tried that failed or were abandoned (so the agent does not retry)

Keep the entire summary under 600 words. Do not invent details. If a section has no content, omit it.

Output ONLY the summary text — no preamble, no JSON, no markdown headers.`;

export async function summarize(input: SummarizerInput): Promise<SummarizerOutput> {
  const model = getModelName("standard", input.client.provider);

  const serialized = input.candidateTurns
    .map((t, i) => `--- Turn ${i} (${t.role}) ---\n${stringifyTurn(t)}`)
    .join("\n\n");

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SUMMARIZER_PROMPT },
    {
      role: "user",
      content: `Summarize the following ${input.totalCandidates} turns:\n\n${serialized}`,
    },
  ];

  const response = await input.client.createChatCompletion({ model, messages });

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
