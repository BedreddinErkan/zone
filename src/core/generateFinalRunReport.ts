import { z } from "zod";
import { createOpenAIClient, getModelName } from "../llm/openaiClient.js";

export type FinalRunReportVerificationStatus = "passed" | "failed" | "tooling_issue" | "not_run";

export type FinalRunReport = {
  title: string;
  statusSummary: string;
  intentUnderstood: string;
  filesInspected: Array<{ path: string; reason: string }>;
  filesChanged: Array<{ path: string; added?: number; removed?: number }>;
  changesMade: string[];
  verificationSummary: {
    command?: string;
    status: FinalRunReportVerificationStatus;
    message: string;
  };
  safetySummary: string[];
  nextStep: string;
};

export type GenerateFinalRunReportPatchSource =
  | "llm_patch"
  | "llm_patch_recovered"
  | "ast_fallback"
  | "deterministic_fallback"
  | "agent_loop"
  | "no_patch";

export type GenerateFinalRunReportInput = {
  task: string;
  contextFilesMeta: Array<{ path: string; reason: string }>;
  planObjective?: string | null;
  planScopeSummary?: string | null;
  patchSource: GenerateFinalRunReportPatchSource;
  fileDiffs: Array<{ filePath: string; addedLines: number; removedLines: number }>;
  patchScope: {
    changedFileCount: number;
    totalAddedLines: number;
    totalRemovedLines: number;
    totalChangedLines: number;
    rewriteLikeSuspicion?: boolean;
    cssRewriteSuspicion?: boolean;
  };
  decisionMode: "preview_only" | "safe_to_apply" | "blocked";
  finalState?: "preview_only" | "safe_to_apply" | "blocked";
  warnings: string[];
  correctness: {
    status: "passed" | "skipped" | "rejected_all";
    summary: string;
  };
  verificationCommandsLabel: string | null;
  runtimeVerificationSummary: string | null;
  runtimeVerificationFailedCommand?: string | null;
  verificationStatus?: "passed" | "skipped" | "tooling_issue" | "code_failed" | "timeout";
  finalExecutionOutcome: string;
  developerConfidence?: number;
  /** When set, deterministic report uses a fixed narrative (AI final report is skipped). */
  terminalAbort?: {
    code: "explicit_target_not_found";
    missingPath: string;
  };
};

const finalRunReportSchema = z.object({
  title: z.string().min(1).max(200),
  statusSummary: z.string().min(1).max(800),
  intentUnderstood: z.string().min(1).max(600),
  filesInspected: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
    })
  ),
  filesChanged: z.array(
    z.object({
      path: z.string(),
      added: z.number().optional(),
      removed: z.number().optional(),
    })
  ),
  changesMade: z.array(z.string()),
  verificationSummary: z.object({
    command: z.string().optional(),
    status: z.enum(["passed", "failed", "tooling_issue", "not_run"]),
    message: z.string().min(1).max(800),
  }),
  safetySummary: z.array(z.string()),
  nextStep: z.string().min(1).max(500),
});

function isAiFinalReportEnabled(): boolean {
  return String(process.env.ZONE_AI_FINAL_REPORT || "").trim().toLowerCase() === "true";
}

function stripMarkdownish(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`+/g, "")
    .replace(/#{1,6}\s*/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function extractJsonObject(raw: string): string {
  const cleaned = stripJsonFences(raw);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("No JSON object found");
  }
  return cleaned.slice(first, last + 1);
}

function mapVerificationSummary(input: GenerateFinalRunReportInput): FinalRunReport["verificationSummary"] {
  const cmd =
    input.runtimeVerificationFailedCommand ?? input.verificationCommandsLabel ?? undefined;
  const vs = input.verificationStatus;
  if (!input.verificationCommandsLabel && !input.runtimeVerificationSummary) {
    return {
      status: "not_run",
      message: "Runtime verification was not run for this execution.",
    };
  }
  if (vs === "passed") {
    return {
      command: cmd,
      status: "passed",
      message: input.runtimeVerificationSummary || "Verification completed successfully.",
    };
  }
  if (vs === "tooling_issue") {
    return {
      command: cmd,
      status: "tooling_issue",
      message:
        input.runtimeVerificationSummary ||
        "Verification could not complete because of environment or tooling.",
    };
  }
  if (vs === "code_failed" || vs === "timeout") {
    return {
      command: cmd,
      status: "failed",
      message: input.runtimeVerificationSummary || "Verification did not pass.",
    };
  }
  return {
    command: cmd,
    status: "not_run",
    message: input.runtimeVerificationSummary || "Verification was skipped or not applicable.",
  };
}

export function buildDeterministicFinalRunReport(
  input: GenerateFinalRunReportInput
): FinalRunReport {
  const taskOneLine = stripMarkdownish(input.task).slice(0, 280);
  const inspected =
    input.contextFilesMeta.length > 0
      ? input.contextFilesMeta.map((f) => ({
          path: f.path,
          reason: stripMarkdownish(f.reason).slice(0, 200),
        }))
      : [{ path: "(none listed)", reason: "No context file list was attached for this run." }];

  if (input.terminalAbort?.code === "explicit_target_not_found") {
    const missing = stripMarkdownish(input.terminalAbort.missingPath).slice(0, 400);
    const warnLine = `[EXPLICIT_TARGET_NOT_FOUND] Target file was not found in the selected repository/context. (${missing})`;
    const safetySummary: string[] = [
      `System decisionMode (authoritative): ${input.decisionMode}.`,
      `System finalState: ${input.finalState ?? input.decisionMode}.`,
      `Execution outcome: ${input.finalExecutionOutcome}.`,
      stripMarkdownish(warnLine).slice(0, 400),
    ];
    if (typeof input.developerConfidence === "number") {
      safetySummary.push(`Developer confidence score: ${input.developerConfidence} (informational only).`);
    }
    safetySummary.push(
      `Correctness checks: ${input.correctness.status} — ${stripMarkdownish(input.correctness.summary).slice(0, 240)}`
    );
    for (const w of input.warnings.slice(0, 6)) {
      const t = stripMarkdownish(w).slice(0, 220);
      if (t) safetySummary.push(t);
    }
    return {
      title: "Patch generation failed",
      statusSummary: stripMarkdownish(
        "Patch generation failed: explicit_target_not_found — the Target file path from the task is not present in the selected repository or hosted context."
      ).slice(0, 800),
      intentUnderstood: taskOneLine,
      filesInspected: inspected,
      filesChanged: [],
      changesMade: [stripMarkdownish("No files changed.").slice(0, 400)],
      verificationSummary: {
        status: "not_run",
        message: stripMarkdownish("Not run — explicit target file was not found.").slice(0, 800),
      },
      safetySummary: safetySummary.map((s) => stripMarkdownish(s).slice(0, 400)),
      nextStep: stripMarkdownish(
        "Confirm the Target file line matches a file path in the selected repository or context, then re-run."
      ).slice(0, 500),
    };
  }

  const changed = input.fileDiffs.map((d) => ({
    path: d.filePath,
    added: d.addedLines,
    removed: d.removedLines,
  }));

  const changesMade: string[] = [];
  if (input.patchSource === "no_patch") {
    changesMade.push(
      "Patch generation did not produce an applyable file change (no_patch). The preview may still describe intended edits."
    );
  } else if (input.patchScope.changedFileCount === 0) {
    changesMade.push("No files were changed in the final apply set.");
  } else {
    changesMade.push(
      `Edited ${input.patchScope.changedFileCount} file(s): +${input.patchScope.totalAddedLines} / -${input.patchScope.totalRemovedLines} lines (total changed lines: ${input.patchScope.totalChangedLines}).`
    );
    if (input.patchSource === "llm_patch_recovered") {
      changesMade.push(
        "Strict patch parsing failed initially; Zone recovered a single validated find/replace from the model output."
      );
    }
    if (input.patchSource === "ast_fallback") {
      changesMade.push(
        "Text patch matching failed; Zone used a safe AST-based fallback for a small, localized JavaScript/JSX repair."
      );
    }
    if (input.patchSource === "deterministic_fallback") {
      changesMade.push("A deterministic fallback patch was used after LLM patch generation did not apply cleanly.");
    }
  }

  let statusSummary: string;
  const effectiveBlock =
    input.finalState === "blocked" || input.decisionMode === "blocked";
  if (effectiveBlock) {
    statusSummary =
      "blocked_for_safety: This run is blocked for safety. Do not auto-apply; follow the warnings and verification guidance before trying again.";
  } else if (input.patchSource === "no_patch") {
    statusSummary =
      "patch_generation_failed: No applyable file patches were produced (no_patch). Review the preview and tighten the task or file scope.";
  } else if (input.decisionMode === "preview_only") {
    statusSummary =
      "needs_review: This run needs review before apply (preview_only). The system kept changes in preview-only mode for safety or quality reasons.";
  } else {
    statusSummary =
      "This run completed with an applyable patch set. Review diffs and verification results before merging.";
  }

  const title = effectiveBlock
    ? "Run blocked for safety"
    : input.patchSource === "no_patch"
      ? "Run finished without applyable patches"
      : input.decisionMode === "preview_only"
        ? "Run complete — needs review"
        : "Run complete";

  const safetySummary: string[] = [
    `System decisionMode (authoritative): ${input.decisionMode}.`,
    `System finalState: ${input.finalState ?? input.decisionMode}.`,
    `Execution outcome: ${input.finalExecutionOutcome}.`,
  ];
  if (typeof input.developerConfidence === "number") {
    safetySummary.push(`Developer confidence score: ${input.developerConfidence} (informational only).`);
  }
  safetySummary.push(`Correctness checks: ${input.correctness.status} — ${stripMarkdownish(input.correctness.summary).slice(0, 240)}`);
  for (const w of input.warnings.slice(0, 6)) {
    const t = stripMarkdownish(w).slice(0, 220);
    if (t) safetySummary.push(t);
  }

  const verificationSummary = mapVerificationSummary(input);

  let nextStep: string;
  if (effectiveBlock) {
    nextStep =
      "Do not apply automatically. Read safetySummary and warnings, fix verification or policy issues, then re-run with a smaller scoped task.";
  } else if (input.patchSource === "no_patch") {
    nextStep =
      "Narrow the task to a specific file and behavior, then re-run. If the preview targets the wrong path, correct it before retrying.";
  } else if (input.decisionMode === "preview_only") {
    nextStep =
      "Review the diff and warnings carefully, then apply manually if appropriate. Consider a follow-up task to address warnings.";
  } else if (verificationSummary.status === "failed") {
    nextStep = "Fix the failing verification issue, then re-run or apply the suggested correction path from warnings.";
  } else if (verificationSummary.status === "tooling_issue") {
    nextStep = "Fix local tooling or CI setup, then re-run verification. The patch may still be worth manual review.";
  } else {
    nextStep = "Review the diff, run your usual PR checks, then merge if everything looks correct.";
  }

  return {
    title: stripMarkdownish(title).slice(0, 200),
    statusSummary: stripMarkdownish(statusSummary).slice(0, 800),
    intentUnderstood: taskOneLine,
    filesInspected: inspected,
    filesChanged: changed,
    changesMade: changesMade.map((s) => stripMarkdownish(s).slice(0, 400)),
    verificationSummary: {
      command: verificationSummary.command,
      status: verificationSummary.status,
      message: stripMarkdownish(verificationSummary.message).slice(0, 800),
    },
    safetySummary: safetySummary.map((s) => stripMarkdownish(s).slice(0, 400)),
    nextStep: stripMarkdownish(nextStep).slice(0, 500),
  };
}

function buildModelPayload(input: GenerateFinalRunReportInput): string {
  return JSON.stringify({
    task: input.task.slice(0, 4000),
    contextFilesMeta: input.contextFilesMeta.slice(0, 12),
    planObjective: input.planObjective ?? null,
    planScopeSummary: input.planScopeSummary ?? null,
    patchSource: input.patchSource,
    fileDiffs: input.fileDiffs.slice(0, 20).map((d) => ({
      path: d.filePath,
      added: d.addedLines,
      removed: d.removedLines,
    })),
    patchScope: input.patchScope,
    decisionMode: input.decisionMode,
    finalState: input.finalState ?? null,
    warnings: input.warnings.slice(0, 12),
    correctness: input.correctness,
    verificationCommandsLabel: input.verificationCommandsLabel,
    runtimeVerificationSummary: input.runtimeVerificationSummary,
    runtimeVerificationFailedCommand: input.runtimeVerificationFailedCommand ?? null,
    verificationStatus: input.verificationStatus ?? null,
    finalExecutionOutcome: input.finalExecutionOutcome,
    developerConfidence: input.developerConfidence ?? null,
  });
}

async function generateAiFinalRunReport(
  input: GenerateFinalRunReportInput
): Promise<FinalRunReport | null> {
  const client = createOpenAIClient();
  const model = getModelName();
  const payload = buildModelPayload(input);

  const prompt = `
You write short, user-facing execution summaries for a developer coding agent called Zone.

You MUST return ONLY a single JSON object (no markdown fences, no commentary) with exactly these keys and types:
- title: string (max 120 chars)
- statusSummary: string (max 400 chars) — plain text, no markdown
- intentUnderstood: string (max 300 chars) — restate user goal in one or two short sentences
- filesInspected: array of { "path": string, "reason": string } (use the provided context file list; if empty use one entry explaining none)
- filesChanged: array of { "path": string, "added"?: number, "removed"?: number } from provided fileDiffs
- changesMade: array of strings (2 to 5 short bullets, plain text, no markdown)
- verificationSummary: { "command"?: string, "status": "passed"|"failed"|"tooling_issue"|"not_run", "message": string }
- safetySummary: array of strings (3 to 8 short bullets). MUST include a bullet that starts with: "System decisionMode (authoritative): " followed EXACTLY by the provided decisionMode string.
- nextStep: string (one short imperative sentence, max 220 chars)

Hard rules:
- Explanatory only. Do NOT recommend overriding or changing the system's decisionMode, finalState, or safety policy.
- Use the provided decisionMode and finalExecutionOutcome verbatim where a field requires the authoritative system value.
- If finalState or decisionMode is "blocked", statusSummary MUST start with "blocked_for_safety:" and clearly say the run is blocked for safety.
- Else if patchSource is "no_patch", statusSummary MUST start with "patch_generation_failed:" and clearly say no applyable patches (no_patch).
- Else if decisionMode is "preview_only", statusSummary MUST start with "needs_review:" and clearly say the run needs review before apply (preview_only).
- No markdown characters in any string: no # headings, no bullet asterisks as line prefixes, no backticks, no code fences.
- Keep all strings concise and UI-ready.

FACTS_JSON:
${payload}
`.trim();

  const response = await client.responses.create({
    model,
    temperature: 0,
    input: prompt,
    text: { format: { type: "json_object" } },
  });

  const rawText = response.output_text || "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(rawText));
  } catch {
    return null;
  }

  const parsedResult = finalRunReportSchema.safeParse(parsed);
  if (!parsedResult.success) {
    return null;
  }

  const v = parsedResult.data;

  const sanitized: FinalRunReport = {
    title: stripMarkdownish(v.title).slice(0, 200),
    statusSummary: stripMarkdownish(v.statusSummary).slice(0, 800),
    intentUnderstood: stripMarkdownish(v.intentUnderstood).slice(0, 600),
    filesInspected: v.filesInspected.map((f) => ({
      path: stripMarkdownish(f.path).slice(0, 400),
      reason: stripMarkdownish(f.reason).slice(0, 400),
    })),
    filesChanged: v.filesChanged.map((f) => ({
      path: stripMarkdownish(f.path).slice(0, 400),
      added: f.added,
      removed: f.removed,
    })),
    changesMade: v.changesMade.map((s) => stripMarkdownish(s).slice(0, 400)),
    verificationSummary: {
      command: v.verificationSummary.command
        ? stripMarkdownish(v.verificationSummary.command).slice(0, 400)
        : undefined,
      status: v.verificationSummary.status,
      message: stripMarkdownish(v.verificationSummary.message).slice(0, 800),
    },
    safetySummary: v.safetySummary.map((s) => stripMarkdownish(s).slice(0, 400)),
    nextStep: stripMarkdownish(v.nextStep).slice(0, 500),
  };

  if (!sanitized.safetySummary.some((s) => s.includes(`System decisionMode (authoritative): ${input.decisionMode}`))) {
    return null;
  }

  return sanitized;
}

export async function generateFinalRunReport(
  input: GenerateFinalRunReportInput
): Promise<FinalRunReport> {
  const fallback = buildDeterministicFinalRunReport(input);
  if (input.terminalAbort?.code === "explicit_target_not_found") {
    return fallback;
  }
  if (!isAiFinalReportEnabled()) {
    return fallback;
  }
  try {
    const ai = await generateAiFinalRunReport(input);
    return ai ?? fallback;
  } catch (err) {
    console.warn(
      `[zone-final-report] AI report skipped: ${err instanceof Error ? err.message : String(err)}`
    );
    return fallback;
  }
}
