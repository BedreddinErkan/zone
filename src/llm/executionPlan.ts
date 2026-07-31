import { z } from "zod";
import { getModelName } from "./openaiClient.js";
import { AUX_CALL_MAX_OUTPUT_TOKENS } from "./models.js";
import { createLLMClient, PlanRefusalError } from "./factory.js";
import { getRequestContext } from "./openaiContext.js";
import type { LLMProvider } from "./types.js";
import { log } from "../utils/logger.js";

export type ExecutionPlan = {
  objective: string;
  steps: {
    title: string;
    description: string;
    filesLikely: string[];
    /** Phase Q.3: hint that this step is independent / parallelizable enough
     *  to be dispatched as a Task subagent. Informational only — agent still
     *  decides at runtime whether to actually spawn. */
    subagentEligible?: boolean;
    /** Phase Q.3: which subagent kind suits the step. "worker" = isolated
     *  multi-file edits; "explore" = read-only investigation. */
    subagentType?: "explore" | "worker";
  }[];
  riskHints: string[];
  scopeSummary: string;
  scopeNotes?: string;
  /** Reproduce-first: set when the agent verified the asserted problem does not exist
   *  (e.g. build exits 0). IFF invariant: steps MUST be [] when this is set.
   *  Mutually exclusive with cannotVerifyReason. */
  noChangeReason?: string;
  /** Reproduce-first: set when the reproduce command did NOT run (blocked, denied,
   *  infrastructure error) so the premise could not be verified. steps MUST be [].
   *  Mutually exclusive with noChangeReason. */
  cannotVerifyReason?: string;
  /** Set when the investigation found nothing to change AND the task itself was a
   *  question — not a verified-false bug report (noChangeReason) and not a blocked
   *  reproduce attempt (cannotVerifyReason). steps MUST be []. Declares SHAPE ONLY:
   *  this is not the answer, which remains loop.summary -> ASSISTANT_FINAL, produced
   *  post-execution by the read-only loop this shape permits. Mutually exclusive
   *  with the other two. */
  answerOnlyReason?: string;
};

/** True when the investigation verified the asserted problem does not exist.
 *  steps is empty and noChangeReason explains what was verified. */
export function isNoChangePlan(plan: ExecutionPlan): boolean {
  return plan.steps.length === 0 && !!plan.noChangeReason;
}

/** True when the reproduce command did not run and the premise could not be verified.
 *  steps is empty and cannotVerifyReason explains the blockage. */
export function isCannotVerifyPlan(plan: ExecutionPlan): boolean {
  return plan.steps.length === 0 && !!plan.cannotVerifyReason;
}

/** True when the task was a question and the investigation found nothing to change —
 *  not a verified-false bug report (isNoChangePlan) and not a blocked reproduce
 *  attempt (isCannotVerifyPlan). steps is empty and answerOnlyReason names what will
 *  be answered read-only, not the answer itself. */
export function isAnswerOnlyPlan(plan: ExecutionPlan): boolean {
  return plan.steps.length === 0 && !!plan.answerOnlyReason;
}

export type PlanTerminalShape = "steps" | "no_change" | "cannot_verify" | "answer" | "unknown";

/** The single discriminator every consumer branches on instead of a hand-rolled
 *  ternary over the (now three) mutually-exclusive reason fields. "unknown" — steps
 *  empty, no reason field at all — stays schema-REJECTED (superRefine below is
 *  unchanged in that respect), so this arm is an unreachable tripwire for any
 *  schema-validated plan: it can only fire if something built an ExecutionPlan-
 *  shaped object without going through executionPlanSchema.parse. House rule 1 says
 *  an unmatched case must be loud, not silently absorbed by whichever consumer runs
 *  next — if this ever fires, that is itself the finding. Emits inline: a plan
 *  classified "unknown" more than once (multiple consumers calling this on the same
 *  plan) emits more than once — acceptable given this arm should never fire at all
 *  under normal operation; not engineered around for that reason. */
export function planTerminalShape(plan: ExecutionPlan): PlanTerminalShape {
  if (plan.steps.length > 0) return "steps";
  if (plan.noChangeReason) return "no_change";
  if (plan.cannotVerifyReason) return "cannot_verify";
  if (plan.answerOnlyReason) return "answer";
  log("[zone-plan-unknown-terminal-shape]", JSON.stringify({ objective: plan.objective.slice(0, 80) }));
  return "unknown";
}

const executionPlanSchema = z
  .object({
    objective: z.string(),
    steps: z
      .array(
        z.object({
          title: z.string(),
          description: z.string(),
          filesLikely: z.array(z.string()),
          subagentEligible: z.boolean().optional(),
          subagentType: z.enum(["explore", "worker"]).optional(),
        })
      )
      .min(0)
      .max(8),
    riskHints: z.array(z.string()),
    scopeSummary: z.string(),
    scopeNotes: z.string().optional(),
    noChangeReason: z.string().optional(),
    cannotVerifyReason: z.string().optional(),
    answerOnlyReason: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const hasNoChange = !!data.noChangeReason;
    const hasCantVerify = !!data.cannotVerifyReason;
    const hasAnswerOnly = !!data.answerOnlyReason;
    const reasonsSet = [hasNoChange, hasCantVerify, hasAnswerOnly].filter(Boolean).length;
    if (data.steps.length === 0) {
      // When steps is empty, exactly one of noChangeReason / cannotVerifyReason /
      // answerOnlyReason must be set — zero stays rejected, same as before this
      // field existed; a hard rejection is the loudest response to a genuinely
      // malformed model output.
      if (reasonsSet === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "steps must be non-empty unless noChangeReason, cannotVerifyReason, or answerOnlyReason is set",
          path: ["steps"],
        });
      }
      if (reasonsSet >= 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "at most one of noChangeReason / cannotVerifyReason / answerOnlyReason may be set",
          path: ["noChangeReason"],
        });
      }
    }
    // steps non-empty + reason set: salvaged by .transform() below — not rejected here.
  })
  .transform((data): typeof data => {
    if (
      data.steps.length > 0 &&
      (data.noChangeReason !== undefined || data.cannotVerifyReason !== undefined || data.answerOnlyReason !== undefined)
    ) {
      const dropped = [
        data.noChangeReason !== undefined ? "noChangeReason" : null,
        data.cannotVerifyReason !== undefined ? "cannotVerifyReason" : null,
        data.answerOnlyReason !== undefined ? "answerOnlyReason" : null,
      ]
        .filter((f): f is string => f !== null)
        .join(", ");
      // log, not debugLog: debugLog only reaches console.log under
      // ZONE_VERBOSE_LOGS=1, so the line never existed for stdoutShield's
      // marker sink to intercept — the same defect 19c98c6a fixed for
      // [zone-plan-mode].
      log(`[zone-plan-salvaged] dropped ${dropped} (steps=${data.steps.length})`);
      return { ...data, noChangeReason: undefined, cannotVerifyReason: undefined, answerOnlyReason: undefined };
    }
    return data;
  });

function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function extractJson(raw: string): string {
  const cleaned = stripJsonFences(raw);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("No JSON object found in execution plan response.");
  }
  return cleaned.slice(first, last + 1);
}

// Phase Q.6 normalization shared by generateExecutionPlan and tryParseExecutionPlan.
function normalizeExecutionPlanSteps(
  steps: ExecutionPlan["steps"]
): ExecutionPlan["steps"] {
  return steps.map((step) => {
    const explicitEligibleFalse = step.subagentEligible === false;
    const rawType = step.subagentType;
    const typeIsValid = rawType === "worker" || rawType === "explore";
    const eligibleSignal = step.subagentEligible === true || typeIsValid;
    if (!explicitEligibleFalse && eligibleSignal) {
      const inferredType: "worker" | "explore" = typeIsValid ? rawType : "worker";
      return {
        title: step.title,
        description: step.description,
        filesLikely: step.filesLikely,
        subagentEligible: true as const,
        subagentType: inferredType,
      };
    }
    return {
      title: step.title,
      description: step.description,
      filesLikely: step.filesLikely,
    };
  });
}

/** Parse the last ```json block in `text` as an ExecutionPlan.
 *  Returns null if no block found, JSON is invalid, or schema validation fails. */
export function tryParseExecutionPlan(text: string): ExecutionPlan | null {
  try {
    const blocks = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
    if (blocks.length === 0) return null;
    const inner = blocks[blocks.length - 1]![1] ?? "";
    const parsed: unknown = JSON.parse(inner);
    const plan = executionPlanSchema.parse(parsed);
    const steps = normalizeExecutionPlanSteps(plan.steps);
    return {
      objective: plan.objective,
      steps,
      riskHints: plan.riskHints,
      scopeSummary: plan.scopeSummary,
      ...(plan.scopeNotes ? { scopeNotes: plan.scopeNotes } : {}),
      ...(plan.noChangeReason ? { noChangeReason: plan.noChangeReason } : {}),
      ...(plan.cannotVerifyReason ? { cannotVerifyReason: plan.cannotVerifyReason } : {}),
      ...(plan.answerOnlyReason ? { answerOnlyReason: plan.answerOnlyReason } : {}),
    };
  } catch {
    return null;
  }
}

export function formatExecutionPlanForPrompt(plan?: ExecutionPlan | null): string {
  if (!plan) {
    return "";
  }

  const steps = plan.steps
    .map((step, index) => {
      const files = step.filesLikely.length > 0 ? step.filesLikely.join(", ") : "unknown";
      return `${index + 1}. ${step.title}: ${step.description} (files: ${files})`;
    })
    .join("\n");

  const lines = [
    `Objective: ${plan.objective}`,
    "Steps:",
    steps,
    `Scope: ${plan.scopeSummary}`,
  ];
  if (plan.riskHints.length > 0) {
    lines.push("Risks:");
    lines.push(plan.riskHints.map((hint) => `- ${hint}`).join("\n"));
  }
  return lines.join("\n");
}

/**
 * Wraps `formatExecutionPlanForPrompt` with a labeled header/footer for the ONE-TIME
 * injection into the first user message (cache breakpoint #2 territory — never the
 * system prompt, which is built once before the run and cached at breakpoint #1).
 * Shared so the initial injection and any later reference to "the approved plan" use
 * identical framing text.
 */
export function buildApprovedPlanBlock(plan: ExecutionPlan): string {
  return `--- APPROVED PLAN ---\n${formatExecutionPlanForPrompt(plan)}\n--- END APPROVED PLAN ---`;
}

/**
 * A replan mutates `executionPlan` well after the first user message (containing
 * `buildApprovedPlanBlock`'s output) is already part of the cached prefix — that
 * message must never be rewritten. This is the append-only alternative: fresh content
 * for a NEW message at the current cache frontier, never an edit to the original.
 * Shared between both replan sites so the two don't drift in wording.
 */
export function formatPlanRevisedNote(plan: ExecutionPlan): string {
  return `Plan revised — ${plan.steps.length} steps.\n\n${formatExecutionPlanForPrompt(plan)}`;
}

export async function generateExecutionPlan(input: {
  task: string;
  repoSummary: string;
  relevantFiles: string[];
  userApiKey?: string;
  provider?: LLMProvider;
  previousPlan?: ExecutionPlan;
  userFeedback?: string;
  /** Task archetype — tightens the filesLikely rule for refactor/rename tasks. */
  archetype?: string;
  /** Pre-read file bodies for content-aware ("quick") plan seeding. Already
   *  truncated + budget-capped by the caller. Injected as-is into the prompt. */
  seededFileContents?: string;
  /** When true, instructs the model to always produce concrete steps and never
   *  emit noChangeReason/cannotVerifyReason. Throws if the model still returns
   *  no steps, so the caller can fall through to synthesizeMinimalPlan. */
  forceSteps?: boolean;
  /** When provided, aborts the in-flight LLM call. */
  abortSignal?: AbortSignal;
}): Promise<ExecutionPlan> {
  const client = createLLMClient({
    apiKey: input.userApiKey,
    provider: input.provider,
  });
  const ctx = getRequestContext();
  const model = getModelName("standard", client.provider, ctx?.modelOverride);
  const relevantFiles = input.relevantFiles.slice(0, 8).join("\n") || "(none)";

  // When the user has reviewed a previous plan and provided feedback, prepend
  // that context so the LLM treats it as the primary revision directive.
  const feedbackSection =
    input.previousPlan && input.userFeedback
      ? `The user reviewed a previous plan and provided this feedback:\n` +
        `"${input.userFeedback}"\n\n` +
        `Previous plan:\n${JSON.stringify(input.previousPlan, null, 2)}\n\n` +
        `Generate a revised plan that addresses the feedback. Preserve what ` +
        `worked in the previous plan; change only what the feedback requests. ` +
        `Keep the same JSON shape (objective, steps, riskHints, scopeSummary).\n\n`
      : "";

  const seededSection = input.seededFileContents
    ? `SEEDED FILE CONTENTS\n${input.seededFileContents}\n\n`
    : "";

  const seededRule = input.seededFileContents
    ? `- Examine SEEDED FILE CONTENTS above; populate scopeNotes with any ` +
      `observations about what is already implemented, partially done, or out ` +
      `of scope. Keep scopeNotes ≤ 200 chars; omit if nothing notable.\n`
    : "";

  const prompt = `
${feedbackSection}Create a concise execution plan for a code patch.

TASK
${input.task}

REPO SUMMARY
${input.repoSummary}

RELEVANT FILES
${relevantFiles}

${seededSection}Rules:
- Break the task into 3-8 implementation steps.
- Estimate affected files by path/name when possible.
- For \`filesLikely\`, copy paths VERBATIM from the RELEVANT FILES list above when the file is clearly affected by the step. Never alter or guess extensions (.ts vs .tsx, .js vs .jsx, etc.). ${input.archetype === "refactor" || input.archetype === "complex_multi_file" ? "Do NOT estimate or invent paths — if a file is not in RELEVANT FILES, omit it from filesLikely and note the gap in the step description." : "Only estimate a path when no matching file appears in RELEVANT FILES."}
- Identify risks briefly.
- Keep scopeSummary under 160 characters.
- Return JSON only.
${seededRule}
Subagent eligibility (Phase Q.3 / Q.6):
For each step, decide whether it could run as a Task subagent. Mark a step
\`subagentEligible: true\` when it satisfies one of these patterns:
- \`subagentType: "worker"\` — independent multi-file edits, ≥3 files all
  receiving similar transformations (rename across files, repeated find-
  replace, codemods, prop renames). NOT for a single-file edit, even if complex.
- \`subagentType: "explore"\` — pure read-only investigation that doesn't
  depend on parent context ("list every caller of X", "map files matching
  pattern Y", "find all imports of Z"). NOT for trivial lookups the agent can
  do in one read.

Concrete examples — apply these directly:
EXAMPLE A — fanout (mark with worker):
  { "title": "Rename detectFramework to identifyFramework across 5 files",
    "description": "Apply the same identifier change to every site listed below.",
    "filesLikely": ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
    "subagentEligible": true, "subagentType": "worker" }
EXAMPLE B — exploration (mark with explore):
  { "title": "Map every caller of helperX",
    "description": "Read all matching files and produce a usage table.",
    "filesLikely": ["src/**/*.ts"],
    "subagentEligible": true, "subagentType": "explore" }
EXAMPLE C — trivial (omit annotation):
  { "title": "Add JSDoc to function Y",
    "description": "One short doc comment above the existing function.",
    "filesLikely": ["src/y.ts"] }

Rules of thumb:
- filesLikely has ≥3 entries AND the description mentions the same change
  applied to each → worker. Mark it.
- filesLikely is one file OR the description describes orchestration work
  that needs shared state → omit.
- When in doubt about a clearly multi-file fanout, MARK it. The agent
  still decides at runtime whether to dispatch — a marked step that the
  agent declines is free; an unmarked fanout step gets no chance.

JSON shape:
{
  "objective": "string",
  "steps": [
    {
      "title": "string",
      "description": "<short approach: what this step does to which code + the key decision/edit, 1-3 sentences, concrete, not a restatement of the title>",
      "filesLikely": ["string"],
      "subagentEligible": true | false,
      "subagentType": "worker" | "explore"
    }
  ],
  "riskHints": ["string"],
  "scopeSummary": "string",
  "scopeNotes": "string (optional)",
  ${input.forceSteps
    ? `// noChangeReason, cannotVerifyReason, and answerOnlyReason are NOT valid for this task type.`
    : `"noChangeReason": "string (optional — set ONLY when the reproduce command ran and exited 0; steps MUST be []; mutually exclusive with cannotVerifyReason)",
  "cannotVerifyReason": "string (optional — set ONLY when the reproduce command did NOT run (blocked/denied/infra error); steps MUST be []; mutually exclusive with noChangeReason)",
  "answerOnlyReason": "string (optional — set when the task is a question and the investigation found nothing that needs to change; steps MUST be [])"`}
}
${input.forceSteps
    ? `IMPORTANT: This is an additive or creation task. You MUST return at least one concrete implementation step. Do NOT set noChangeReason, cannotVerifyReason, or answerOnlyReason.`
    : `- noChangeReason: if you ran the relevant command and it exited 0, set this and leave steps as []. Do not fabricate steps for a problem you could not reproduce.
- cannotVerifyReason: if the reproduce command did not run even bare, set this and leave steps as []. Do NOT read files to guess a fix.`}
`.trim();

  const response = await client.createChatCompletion(
    {
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      // Bounded: a plan is a few thousand tokens. Without this convertParams injects
      // the model ceiling (up to 128k) onto a held non-streaming connection.
      max_tokens: AUX_CALL_MAX_OUTPUT_TOKENS,
    },
    { signal: input.abortSignal }
  );

  const choice = response.choices[0];
  if (choice?.finish_reason === "content_filter") {
    const refusalText = choice.message.refusal ?? "Request declined by safety classifier.";
    // costUsd:0 — single-call path has no loop cost tracker; minor under-report,
    // session-level cost is still recorded by RecordingLLMClient.
    throw new PlanRefusalError(refusalText, 0);
  }
  const parsed = JSON.parse(
    extractJson(choice?.message?.content ?? "")
  );
  const plan = executionPlanSchema.parse(parsed);

  if (input.forceSteps && plan.steps.length === 0) {
    throw new Error("generateExecutionPlan: no steps returned (forceSteps)");
  }

  const normalizedSteps = normalizeExecutionPlanSteps(plan.steps);

  return {
    objective: plan.objective,
    steps: normalizedSteps,
    riskHints: plan.riskHints,
    scopeSummary: plan.scopeSummary,
    ...(plan.scopeNotes ? { scopeNotes: plan.scopeNotes } : {}),
    ...(plan.noChangeReason ? { noChangeReason: plan.noChangeReason } : {}),
    ...(plan.cannotVerifyReason ? { cannotVerifyReason: plan.cannotVerifyReason } : {}),
    ...(plan.answerOnlyReason ? { answerOnlyReason: plan.answerOnlyReason } : {}),
  };
}

/**
 * Last-resort ExecutionPlan built from the task string alone — no LLM call.
 * Guarantees non-empty steps and validates against executionPlanSchema so
 * callers receive a schema-compliant ExecutionPlan (fails loudly if invariants
 * are violated, future-proofing against schema changes).
 *
 * Emits `[zone-plan-synthesized]` from inside the function rather than from the
 * call site: the output is structurally indistinguishable from a real plan to
 * every downstream consumer — PlanBody renders its one step like any other,
 * hasApprovedSteps computes true from it, and stepCount reports 1 — so a marker
 * at one call site would leave a future second caller silent again, which is the
 * failure being fixed. `log`, not `debugLog`: this has to reach the marker sink.
 */
export function synthesizeMinimalPlan(
  task: string,
  relevantFiles: string[] = [],
  /** Message from the forceSteps regeneration that threw just before this
   *  fallback ran, when there was one. Only the caller has it in scope. */
  forceStepsFailReason?: string,
): ExecutionPlan {
  const pathTokens = [...task.matchAll(/\b[\w./][\w./-]*\.\w{2,5}\b/g)]
    .map(m => m[0]).slice(0, 5);
  const filesLikely = [...new Set([...pathTokens, ...relevantFiles.slice(0, 3)])];
  const raw = {
    objective: task.slice(0, 200),
    steps: [{ title: task.slice(0, 80), description: task, filesLikely }],
    riskHints: [],
    scopeSummary: task.slice(0, 160),
  };
  log("[zone-plan-synthesized]", JSON.stringify({
    taskLength: task.length,
    filesLikelyCount: filesLikely.length,
    forceStepsFailReason: forceStepsFailReason ?? null,
  }));
  return executionPlanSchema.parse(raw);
}
