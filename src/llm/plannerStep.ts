import { z } from "zod";
import { createOpenAIClient } from "./openaiClient.js";

const plannerOutputSchema = z.object({
  filesToEdit: z.array(z.string()),
  changeDescription: z.string(),
  strategy: z.string(),
});

export type PlannerStepOutput = z.infer<typeof plannerOutputSchema>;

export async function plannerStep(input: {
  task: string;
  rankedFilePaths: string[];
  repoSummary: string;
}): Promise<PlannerStepOutput | null> {
  const client = createOpenAIClient();
  const prompt = [
    "You are a code-change planner for a patch execution agent.",
    "You only see file paths (no file contents). Choose the minimal set of files to edit.",
    "",
    "Return ONLY valid JSON with this exact shape:",
    `{ "filesToEdit": string[], "changeDescription": string, "strategy": string }`,
    "",
    "Rules:",
    "- filesToEdit MUST be a subset of rankedFilePaths (do not invent paths).",
    "- Prefer 1-3 files if possible.",
    "- Keep changeDescription and strategy concise (1-3 sentences each).",
    "",
    `Repo summary:\n${input.repoSummary}`,
    "",
    `Task:\n${input.task}`,
    "",
    "rankedFilePaths:",
    ...input.rankedFilePaths.map((p) => `- ${p}`),
  ].join("\n");

  const response = await client.responses.create({
    model: "gpt-4o-mini",
    temperature: 0,
    input: prompt,
  });

  const raw = String((response as { output_text?: unknown }).output_text ?? "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const validated = plannerOutputSchema.safeParse(parsed);
  if (!validated.success) return null;

  const allowed = new Set(input.rankedFilePaths);
  const filesToEdit = validated.data.filesToEdit.filter((p) => allowed.has(p));
  if (filesToEdit.length === 0) return null;

  return {
    filesToEdit,
    changeDescription: validated.data.changeDescription,
    strategy: validated.data.strategy,
  };
}

