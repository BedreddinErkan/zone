import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConversationBillingMode } from "../types/conversation.js";

export type DeveloperPatchJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type DeveloperPatchJobRequestPayload = {
  task: string;
  repoPath: string;
  userId: string;
  conversationId?: string;
  billingMode?: ConversationBillingMode;
  hostedContext?: unknown;
  userOpenAiKey?: string;
  isByok?: boolean;
};

export type DeveloperPatchJobRecord = {
  id: string;
  user_id: string;
  role: string;
  task: string;
  repo_path: string;
  status: DeveloperPatchJobStatus;
  progress_stage: string | null;
  request_payload: DeveloperPatchJobRequestPayload | null;
  result_payload: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const TABLE_NAME = "developer_patch_jobs";
const JOB_COLUMNS =
  "id,user_id,role,task,repo_path,status,progress_stage,request_payload,result_payload,error_message,created_at,started_at,finished_at";

export async function createDeveloperPatchJob(
  supabase: SupabaseClient,
  input: {
    userId: string;
    task: string;
    repoPath: string;
    requestPayload: DeveloperPatchJobRequestPayload;
  }
): Promise<DeveloperPatchJobRecord> {
  const id = randomUUID();
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .insert({
      id,
      user_id: input.userId,
      role: "developer",
      task: input.task,
      repo_path: input.repoPath,
      status: "queued",
      progress_stage: "Queued",
      request_payload: input.requestPayload,
    })
    .select(JOB_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to create developer patch job");
  }

  return data as DeveloperPatchJobRecord;
}

export async function getDeveloperPatchJob(
  supabase: SupabaseClient,
  runId: string
): Promise<DeveloperPatchJobRecord | null> {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select(JOB_COLUMNS)
    .eq("id", runId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load developer patch job");
  }

  return (data as DeveloperPatchJobRecord | null) ?? null;
}

export async function claimNextQueuedDeveloperPatchJob(
  supabase: SupabaseClient
): Promise<DeveloperPatchJobRecord | null> {
  const { data, error } = await supabase.rpc("claim_next_developer_patch_job");
  if (error) {
    throw new Error(error.message || "Failed to claim developer patch job");
  }

  if (!data) return null;

  const claimed = Array.isArray(data) ? data[0] : data;
  return (claimed as DeveloperPatchJobRecord | null) ?? null;
}

export async function updateDeveloperPatchJobProgress(
  supabase: SupabaseClient,
  runId: string,
  progressStage: string
): Promise<void> {
  const { error } = await supabase
    .from(TABLE_NAME)
    .update({
      progress_stage: progressStage,
    })
    .eq("id", runId);

  if (error) {
    throw new Error(error.message || "Failed to update developer patch job progress");
  }
}

export async function markDeveloperPatchJobRunning(
  supabase: SupabaseClient,
  runId: string,
  progressStage = "Running"
): Promise<void> {
  const { error } = await supabase
    .from(TABLE_NAME)
    .update({
      status: "running",
      progress_stage: progressStage,
      started_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) {
    throw new Error(error.message || "Failed to mark developer patch job running");
  }
}

export async function markDeveloperPatchJobCompleted(
  supabase: SupabaseClient,
  runId: string,
  resultPayload: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase
    .from(TABLE_NAME)
    .update({
      status: "completed",
      progress_stage: "Ready",
      result_payload: resultPayload,
      error_message: null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) {
    throw new Error(error.message || "Failed to complete developer patch job");
  }
}

export async function markDeveloperPatchJobFailed(
  supabase: SupabaseClient,
  runId: string,
  errorMessage: string
): Promise<void> {
  const { error } = await supabase
    .from(TABLE_NAME)
    .update({
      status: "failed",
      progress_stage: "Ready",
      error_message: errorMessage,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);

  if (error) {
    throw new Error(error.message || "Failed to fail developer patch job");
  }
}
