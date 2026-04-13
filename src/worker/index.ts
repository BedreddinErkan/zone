import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runLlmPatchFlow } from "../core/runLlmPatchFlow.js";
import { validateLlmOutput } from "../core/validateLlmOutput.js";
import {
  claimNextQueuedDeveloperPatchJob,
  markDeveloperPatchJobCompleted,
  markDeveloperPatchJobFailed,
  updateDeveloperPatchJobProgress,
  type DeveloperPatchJobRecord,
} from "../jobs/developerPatchJobs.js";
import { logRun } from "../api/runLogging.js";

const IDLE_DELAY_MS = 1500;

function getWorkerSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDeveloperDecisionModeFromResult(
  result: Record<string, unknown>,
  confidence: number
): string {
  const decisionMode = result.decisionMode;
  if (typeof decisionMode === "string" && decisionMode.length > 0) {
    return decisionMode;
  }
  return confidence < 70 ? "preview_only" : "safe_to_apply";
}

async function processDeveloperPatchJob(
  supabase: SupabaseClient,
  job: DeveloperPatchJobRecord
): Promise<void> {
  const requestPayload = job.request_payload;
  if (!requestPayload) {
    await markDeveloperPatchJobFailed(
      supabase,
      job.id,
      "Missing developer patch job payload."
    );
    return;
  }

  try {
    const result = await runLlmPatchFlow({
      task: requestPayload.task,
      repoPath: requestPayload.repoPath,
      hostedContext: requestPayload.hostedContext as
        | Parameters<typeof runLlmPatchFlow>[0]["hostedContext"]
        | undefined,
      userOpenAiKey: requestPayload.userOpenAiKey,
      onProgress: async (stage) => {
        await updateDeveloperPatchJobProgress(supabase, job.id, stage);
      },
    });

    if (result.ok && result.applyPatches.length > 0) {
      const validation = validateLlmOutput(
        "developer",
        result.applyPatches.map((patch) => ({
          filePath: patch.filePath,
          content: patch.fullContent,
        }))
      );

      if (validation.verdict === "block") {
        await markDeveloperPatchJobFailed(
          supabase,
          job.id,
          "Output validation failed — patch blocked."
        );
        return;
      }

      if (validation.issues.length > 0) {
        (result as Record<string, unknown>).validationIssues = validation.issues;
        (result as Record<string, unknown>).validationVerdict = validation.verdict;
      }
    }

    if (!result.ok) {
      await markDeveloperPatchJobFailed(
        supabase,
        job.id,
        result.reason || "Developer patch job failed."
      );
      return;
    }

    const confidence =
      typeof result.developerConfidence === "number"
        ? result.developerConfidence
        : 0;

    const conversationId = await logRun({
      userId: requestPayload.userId,
      role: "developer",
      task: requestPayload.task,
      repoPath: requestPayload.repoPath,
      decisionMode: getDeveloperDecisionModeFromResult(
        result as unknown as Record<string, unknown>,
        confidence
      ),
      confidence,
      creditsUsed: 1,
      conversationId: requestPayload.conversationId,
      billingMode: requestPayload.billingMode,
      isByok: requestPayload.isByok,
    }).catch(() => null);

    if (conversationId) {
      (result as Record<string, unknown>).conversationId = conversationId;
    }

    await markDeveloperPatchJobCompleted(
      supabase,
      job.id,
      result as unknown as Record<string, unknown>
    );
  } catch (error) {
    await markDeveloperPatchJobFailed(
      supabase,
      job.id,
      error instanceof Error ? error.message : "Unknown worker error"
    );
  }
}

export async function processNextDeveloperPatchJob(): Promise<boolean> {
  const supabase = getWorkerSupabaseClient();
  if (!supabase) {
    return false;
  }

  const job = await claimNextQueuedDeveloperPatchJob(supabase);
  if (!job) {
    return false;
  }

  await processDeveloperPatchJob(supabase, job);
  return true;
}

export async function runDeveloperPatchWorker(): Promise<void> {
  for (;;) {
    const processed = await processNextDeveloperPatchJob();
    if (!processed) {
      await sleep(IDLE_DELAY_MS);
    }
  }
}

if (process.env.VITEST !== "true") {
  void runDeveloperPatchWorker();
}
