import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../utils/logger.js";

const TABLE_NAME = "zone_active_runs";
const ACTIVE_RUN_COLUMNS =
  "run_id,user_id,thread_id,conversation_id,repo_path,task,status,started_at,completed_at,last_changed_files,last_added_functions";

export type ActiveRunStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "interrupted";

type ActiveRunRow = {
  run_id: string;
  user_id: string;
  thread_id: string;
  conversation_id: string;
  repo_path: string;
  task: string;
  status: ActiveRunStatus;
  started_at: string;
  completed_at: string | null;
  last_changed_files: unknown;
  last_added_functions: unknown;
};

export type PersistedActiveRun = {
  runId: string;
  userId: string;
  threadId: string;
  conversationId: string;
  repoPath: string;
  task: string;
  status: ActiveRunStatus;
  startedAt: string;
  completedAt: string | null;
  lastChangedFiles: unknown[] | null;
  lastAddedFunctions: unknown[] | null;
};

export type UpsertActiveRunInput = {
  userId: string;
  threadId: string;
  conversationId: string;
  repoPath: string;
  task: string;
  status: ActiveRunStatus;
  lastChangedFiles?: unknown[] | null;
  lastAddedFunctions?: unknown[] | null;
};

function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function normalizeJsonArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function mapActiveRunRow(row: ActiveRunRow): PersistedActiveRun {
  return {
    runId: row.run_id,
    userId: row.user_id,
    threadId: row.thread_id,
    conversationId: row.conversation_id,
    repoPath: row.repo_path,
    task: row.task,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastChangedFiles: normalizeJsonArray(row.last_changed_files),
    lastAddedFunctions: normalizeJsonArray(row.last_added_functions),
  };
}

export async function upsertActiveRun(
  runId: string,
  input: UpsertActiveRunInput
): Promise<PersistedActiveRun | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .upsert(
      {
        run_id: runId,
        user_id: input.userId,
        thread_id: input.threadId,
        conversation_id: input.conversationId,
        repo_path: input.repoPath,
        task: input.task,
        status: input.status,
        last_changed_files: Array.isArray(input.lastChangedFiles)
          ? input.lastChangedFiles
          : null,
        last_added_functions: Array.isArray(input.lastAddedFunctions)
          ? input.lastAddedFunctions
          : null,
        ...(input.status === "completed" || input.status === "cancelled"
          ? { completed_at: new Date().toISOString() }
          : {}),
      },
      { onConflict: "run_id" }
    )
    .select(ACTIVE_RUN_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to upsert active run");
  }

  return mapActiveRunRow(data as ActiveRunRow);
}

export async function completeActiveRun(
  runId: string,
  status: "completed" | "cancelled"
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const { error } = await supabase
    .from(TABLE_NAME)
    .update({
      status,
      completed_at: new Date().toISOString(),
    })
    .eq("run_id", runId);

  if (error) {
    throw new Error(error.message || "Failed to complete active run");
  }
}

export async function getActiveRunsByUser(
  userId: string
): Promise<PersistedActiveRun[]> {
  const supabase = getSupabaseClient();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select(ACTIVE_RUN_COLUMNS)
    .eq("user_id", userId)
    .in("status", ["running", "interrupted"])
    .order("started_at", { ascending: false });

  if (error) {
    throw new Error(error.message || "Failed to load active runs");
  }

  const runs = Array.isArray(data)
    ? data.map((row) => mapActiveRunRow(row as ActiveRunRow))
    : [];
  logger.info(
    "[active-runs] repository fetch userId=%s count=%d staleCount=%d",
    userId,
    runs.length,
    runs.filter((run) => run.status !== "running").length
  );
  return runs;
}

export async function getActiveRun(
  runId: string
): Promise<PersistedActiveRun | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select(ACTIVE_RUN_COLUMNS)
    .eq("run_id", runId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load active run");
  }

  return data ? mapActiveRunRow(data as ActiveRunRow) : null;
}

export async function markAllRunningAsInterrupted(): Promise<number> {
  const supabase = getSupabaseClient();
  if (!supabase) return 0;

  const { count, error: countError } = await supabase
    .from(TABLE_NAME)
    .select("run_id", { count: "exact", head: true })
    .eq("status", "running");

  if (countError) {
    throw new Error(
      countError.message || "Failed to count running active runs"
    );
  }

  const { error } = await supabase
    .from(TABLE_NAME)
    .update({ status: "interrupted" })
    .eq("status", "running");

  if (error) {
    throw new Error(error.message || "Failed to mark running runs as interrupted");
  }

  return Number(count || 0);
}
