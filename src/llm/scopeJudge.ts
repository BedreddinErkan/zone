/**
 * Phase AS: LLM judge that analyzes investigation findings and determines
 * whether the approved plan is correctly scoped.
 *
 * Single prompt call — same model as parent run (no downgrade).
 * Returns strict JSON; prose preamble is stripped before parsing.
 */

import { createLLMClient } from "./factory.js";
import { getModelName } from "./openaiClient.js";
import { getRequestContext } from "./openaiContext.js";
import type { TaskClassification } from "./taskClassifier.js";
import type { ExecutionPlan } from "./executionPlan.js";
import { debugLog, log } from "../utils/logger.js";

export type ScopeMismatchType = "under_scope" | "over_scope" | "mixed" | "none";

export interface ScopeJudgement {
  mismatch: boolean;
  type: ScopeMismatchType;
  reason: string;
  /** Y.0: impact severity when mismatch=true. Fail-safe: missing severity on a
   *  mismatch defaults to "major" to prevent silent under-interruption. */
  severity: "none" | "minor" | "major";
  revisedPlan?: string;
  missingFiles?: string[];
  unnecessaryFiles?: string[];
}

const JUDGE_SYSTEM_PROMPT = `You are a scope auditor for code-editing tasks. Given an approved execution plan and investigation findings, determine whether the plan is correctly scoped.

Decision rubric:
- "under_scope": findings show files/modules the plan omits but are clearly required for the change to work
- "over_scope": findings show the plan lists files that are uninvolved based on actual code structure
- "mixed": both under and over scope issues found
- "none": plan aligns with investigation findings — no revision needed

Severity rubric (applies when mismatch=true):
- "minor": ≤2 files are missing or unnecessary; the omission or inclusion is low-disruption
- "major": ≥3 files are missing or unnecessary; OR the qualitative impact is high even with fewer files
  (e.g. a missing auth guard or a core data-model change). Escalation minor→major is allowed based
  on qualitative assessment; never downgrade major→minor based on file count alone.
- "none": always use when mismatch=false

Respond ONLY with valid JSON matching this schema exactly (no prose before or after):
{
  "mismatch": boolean,
  "type": "under_scope" | "over_scope" | "mixed" | "none",
  "severity": "none" | "minor" | "major",
  "reason": "1-3 sentences grounded in specific findings",
  "revisedPlan": "Short revised plan text if mismatch=true, omit if false",
  "missingFiles": ["path/to/file.ts"],
  "unnecessaryFiles": ["path/to/file.ts"]
}

Only populate missingFiles for under_scope/mixed. Only populate unnecessaryFiles for over_scope/mixed. Omit empty arrays.`;

function buildJudgeUserPrompt(
  originalPlan: ExecutionPlan,
  findings: string,
  taskClassification?: TaskClassification | null,
): string {
  const planText = [
    `Objective: ${originalPlan.objective}`,
    `Scope: ${originalPlan.scopeSummary}`,
    `Steps:`,
    ...originalPlan.steps.map((s, i) =>
      `  ${i + 1}. ${s.title} — files: ${s.filesLikely.join(", ") || "(none listed)"}`
    ),
    originalPlan.riskHints.length ? `Risks: ${originalPlan.riskHints.join("; ")}` : "",
  ].filter(Boolean).join("\n");

  const tierLine = taskClassification ? `Task tier: ${taskClassification.tier}` : "";

  return [
    "## Approved Execution Plan",
    planText,
    tierLine,
    "",
    "## Investigation Findings",
    findings,
  ].filter(Boolean).join("\n");
}

function stripProseAndParseJson(raw: string): unknown {
  const text = raw.trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found in response");
  return JSON.parse(text.slice(firstBrace, lastBrace + 1));
}

function validateJudgement(raw: unknown): ScopeJudgement {
  if (!raw || typeof raw !== "object") throw new Error("Judgement is not an object");
  const j = raw as Record<string, unknown>;
  const validTypes: ScopeMismatchType[] = ["under_scope", "over_scope", "mixed", "none"];
  const type = j["type"] as ScopeMismatchType;
  if (!validTypes.includes(type)) throw new Error(`Invalid mismatch type: ${type}`);
  const mismatch = Boolean(j["mismatch"]);
  const rawSeverity = j["severity"];
  const validSeverities = ["none", "minor", "major"] as const;
  const severity: "none" | "minor" | "major" =
    validSeverities.includes(rawSeverity as "none" | "minor" | "major")
      ? (rawSeverity as "none" | "minor" | "major")
      : mismatch
        ? "major" // fail-safe: missing severity on a real mismatch → assume worst case
        : "none";
  return {
    mismatch,
    type,
    reason: String(j["reason"] || ""),
    severity,
    ...(typeof j["revisedPlan"] === "string" ? { revisedPlan: j["revisedPlan"] } : {}),
    ...(Array.isArray(j["missingFiles"]) && (j["missingFiles"] as unknown[]).length
      ? { missingFiles: (j["missingFiles"] as unknown[]).map(String) }
      : {}),
    ...(Array.isArray(j["unnecessaryFiles"]) && (j["unnecessaryFiles"] as unknown[]).length
      ? { unnecessaryFiles: (j["unnecessaryFiles"] as unknown[]).map(String) }
      : {}),
  };
}

export async function runScopeJudge(input: {
  originalPlan: ExecutionPlan;
  findings: string;
  taskClassification?: TaskClassification | null;
  runId?: string;
  userApiKey?: string;
}): Promise<ScopeJudgement> {
  const { originalPlan, findings, taskClassification, runId, userApiKey } = input;
  const startMs = Date.now();

  try {
    const client = createLLMClient({ apiKey: userApiKey });
    const ctx = getRequestContext();
    const model = getModelName("high", client.provider, ctx?.modelOverride);
    const userPrompt = buildJudgeUserPrompt(originalPlan, findings, taskClassification);

    const response = await client.createChatCompletion({
      model,
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
    });

    const content = response.choices?.[0]?.message?.content ?? "";
    const parsed = stripProseAndParseJson(content);
    const judgement = validateJudgement(parsed);

    debugLog("[zone-scope-judge]", JSON.stringify({
      runId: runId || null,
      mismatch: judgement.mismatch,
      type: judgement.type,
      latencyMs: Date.now() - startMs,
      ts: new Date().toISOString(),
    }));

    return judgement;
  } catch (err) {
    log("[zone-scope-judge-failed]", JSON.stringify({
      runId: runId || null,
      error: err instanceof Error ? err.message : String(err),
      ts: new Date().toISOString(),
    }));
    // Graceful fallback: no mismatch (proceed with original plan)
    return { mismatch: false, type: "none", severity: "none", reason: "Judge unavailable — proceeding with original plan." };
  }
}
