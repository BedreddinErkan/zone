import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFsConversationEvents } from "../core/conversationFilesystemStore.js";
import { costLogDir as defaultCostLogDir } from "../usage/costLogger.js";

export interface BuildFeedbackReportOpts {
  repoPath: string;
  sessionId: string;
  runId: string;
  userMessage: string;
  version: string;
  platform: string;
  repoSlug: string;
  costLogDir?: string;
}

export interface FeedbackReport {
  markdown: string;
  githubIssueUrl: string;
  mailtoUrl: string;
}

interface TurnData {
  userPrompt?: string;
  summary?: string;
  outcome?: string;
  changedFiles?: string[];
}

interface CostData {
  model?: string;
  finalIter?: number;
  totalCostUsd?: number;
  runHitRatio?: number;
}

const URL_TOTAL_CAP = 7500;
const TRUNCATION_SUFFIX = "\n...(truncated)";

function redactHome(s: string): string {
  const home = os.homedir();
  if (!home) return s;
  return s.split(home).join("~");
}

function findTurn(repoPath: string, sessionId: string, runId: string): TurnData {
  try {
    const events = readFsConversationEvents({ repoPath, threadId: sessionId });
    const turns = events.filter((e) => e.type === "turn");
    if (turns.length === 0) return {};
    const matching = turns.find((e) => e.runId === runId);
    const turn = matching ?? turns[turns.length - 1];
    return {
      userPrompt: typeof turn.userPrompt === "string" ? turn.userPrompt : undefined,
      summary: typeof turn.summary === "string" ? turn.summary : undefined,
      outcome: typeof turn.outcome === "string" ? turn.outcome : undefined,
      changedFiles: Array.isArray(turn.changedFiles)
        ? (turn.changedFiles as unknown[]).filter((f): f is string => typeof f === "string")
        : undefined,
    };
  } catch {
    return {};
  }
}

function findCostData(logDir: string, runId: string): CostData {
  try {
    const prefix = runId.slice(0, 8);
    const files = fs.readdirSync(logDir);
    const match = files.find((f) => f.endsWith(`-${prefix}.jsonl`));
    if (!match) return {};
    const raw = fs.readFileSync(path.join(logDir, match), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const parsed = JSON.parse(t) as Record<string, unknown>;
        if (parsed && parsed.type === "run_summary") {
          return {
            model: typeof parsed.model === "string" ? parsed.model : undefined,
            finalIter: typeof parsed.finalIter === "number" ? parsed.finalIter : undefined,
            totalCostUsd: typeof parsed.totalCostUsd === "number" ? parsed.totalCostUsd : undefined,
            runHitRatio: typeof parsed.runHitRatio === "number" ? parsed.runHitRatio : undefined,
          };
        }
      } catch {
        // skip malformed line
      }
    }
    return {};
  } catch {
    return {};
  }
}

// Walk raw string char-by-char counting encoded length; return safe prefix within budget.
function truncateToEncodedBudget(raw: string, budget: number): string {
  let count = 0;
  let i = 0;
  for (; i < raw.length; i++) {
    count += encodeURIComponent(raw[i]).length;
    if (count > budget) break;
  }
  return raw.slice(0, i);
}

function fitToUrlBudget(raw: string, urlOverhead: number): string {
  const bodyBudget = URL_TOTAL_CAP - urlOverhead;
  const encoded = encodeURIComponent(raw);
  if (encoded.length <= bodyBudget) return raw;
  const suffixEncLen = encodeURIComponent(TRUNCATION_SUFFIX).length;
  const safeBudget = bodyBudget - suffixEncLen;
  if (safeBudget <= 0) return TRUNCATION_SUFFIX;
  return truncateToEncodedBudget(raw, safeBudget) + TRUNCATION_SUFFIX;
}

function buildConciseBody(
  userMessage: string,
  turn: TurnData,
  cost: CostData,
  version: string,
  platform: string,
  runId: string,
): string {
  const diag: string[] = [];
  if (turn.summary) diag.push(`Summary: ${redactHome(turn.summary)}`);
  if (turn.outcome) diag.push(`Outcome: ${turn.outcome}`);
  if (cost.model) diag.push(`Model: ${cost.model}`);
  if (cost.totalCostUsd !== undefined) diag.push(`Cost: $${cost.totalCostUsd.toFixed(4)}`);
  if (cost.finalIter !== undefined) diag.push(`Iterations: ${cost.finalIter}`);
  diag.push(`Version: ${version}`);
  diag.push(`Platform: ${platform}`);
  diag.push(`Run ID: ${runId}`);
  return [userMessage, "", diag.join("\n")].join("\n");
}

export async function buildFeedbackReport(opts: BuildFeedbackReportOpts): Promise<FeedbackReport> {
  const { repoPath, sessionId, runId, userMessage, version, platform, repoSlug } = opts;
  const logDir = opts.costLogDir ?? defaultCostLogDir();

  const turn = findTurn(repoPath, sessionId, runId);
  const cost = findCostData(logDir, runId);

  // Full markdown report
  const mdLines: string[] = ["## Feedback", "", userMessage, "", "## Diagnostics", ""];
  if (turn.userPrompt) mdLines.push(`**Prompt:** ${redactHome(turn.userPrompt)}`);
  if (turn.summary) mdLines.push(`**Summary:** ${redactHome(turn.summary)}`);
  if (turn.outcome) mdLines.push(`**Outcome:** ${turn.outcome}`);
  if (turn.changedFiles && turn.changedFiles.length > 0) {
    mdLines.push(`**Changed files:** ${turn.changedFiles.map(redactHome).join(", ")}`);
  }
  if (cost.model) mdLines.push(`**Model:** ${cost.model}`);
  if (cost.totalCostUsd !== undefined) mdLines.push(`**Cost:** $${cost.totalCostUsd.toFixed(4)}`);
  if (cost.finalIter !== undefined) mdLines.push(`**Iterations:** ${cost.finalIter}`);
  if (cost.runHitRatio !== undefined) {
    mdLines.push(`**Cache hit:** ${(cost.runHitRatio * 100).toFixed(1)}%`);
  }
  mdLines.push(`**Version:** ${version}`);
  mdLines.push(`**Platform:** ${platform}`);
  mdLines.push(`**Run ID:** ${runId}`);
  const markdown = mdLines.join("\n");

  // Title: first line of userMessage capped at 60 chars
  const firstLine = (userMessage.split(/\r?\n/)[0] ?? "").slice(0, 49);
  const title = `[feedback] ${firstLine}`;
  const titleEnc = encodeURIComponent(title);

  const rawConcise = buildConciseBody(userMessage, turn, cost, version, platform, runId);

  // GitHub issue URL
  const ghBase = `https://github.com/${repoSlug}/issues/new`;
  const ghOverhead =
    ghBase.length + "?title=".length + titleEnc.length + "&body=".length;
  const ghBody = fitToUrlBudget(rawConcise, ghOverhead);
  const githubIssueUrl = `${ghBase}?title=${titleEnc}&body=${encodeURIComponent(ghBody)}`;

  // Mailto URL
  const mailBase = "mailto:feedback@zonecli.dev";
  const mailSubjectEnc = encodeURIComponent("Zone feedback");
  const mailOverhead =
    mailBase.length + "?subject=".length + mailSubjectEnc.length + "&body=".length;
  const mailBody = fitToUrlBudget(rawConcise, mailOverhead);
  const mailtoUrl = `${mailBase}?subject=${mailSubjectEnc}&body=${encodeURIComponent(mailBody)}`;

  return { markdown, githubIssueUrl, mailtoUrl };
}
