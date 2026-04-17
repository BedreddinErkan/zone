import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ConversationBillingMode,
  ConversationRecord,
  ConversationRole,
} from "../types/conversation.js";

type ConversationRow = {
  id: string;
  user_id: string;
  mode: ConversationBillingMode;
  repo_path: string;
  role: ConversationRole;
  charged_run_count: number;
  refinement_count: number;
  has_free_refinement_been_used: boolean;
  created_at: string;
  updated_at: string;
};

type UserQuotaRow = {
  runs_used_this_month: number | null;
  credits: number | null;
  subscription_status: string | null;
};

export interface CreateConversationInput {
  userId: string;
  mode: ConversationBillingMode;
  repoPath: string;
  role: ConversationRole;
}

export interface UpdateConversationInput {
  mode?: ConversationBillingMode;
  repoPath?: string;
  role?: ConversationRole;
  chargedRunCount?: number;
  refinementCount?: number;
  hasFreeRefinementBeenUsed?: boolean;
}

const TABLE_NAME = "conversations";
const CONVERSATION_COLUMNS =
  "id,user_id,mode,repo_path,role,charged_run_count,refinement_count,has_free_refinement_been_used,created_at,updated_at";

function mapConversationRow(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode,
    repoPath: row.repo_path,
    role: row.role,
    chargedRunCount: row.charged_run_count,
    refinementCount: row.refinement_count,
    hasFreeRefinementBeenUsed: row.has_free_refinement_been_used,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getUserQuota(
  supabase: SupabaseClient,
  userId: string
): Promise<{
  runsUsedThisMonth: number;
  credits: number;
  subscriptionStatus: string;
}> {
  const { data, error } = await supabase
    .from("profiles")
    .select("runs_used_this_month,credits,subscription_status")
    .eq("clerk_user_id", userId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(error?.message || "Failed to load user quota");
  }

  const row = data as UserQuotaRow;

  return {
    runsUsedThisMonth: row.runs_used_this_month ?? 0,
    credits: row.credits ?? 0,
    subscriptionStatus: row.subscription_status ?? "",
  };
}

export async function createConversation(
  supabase: SupabaseClient,
  input: CreateConversationInput
): Promise<ConversationRecord> {
  const id = randomUUID();
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .insert({
      id,
      user_id: input.userId,
      mode: input.mode,
      repo_path: input.repoPath,
      role: input.role,
      charged_run_count: 0,
      refinement_count: 0,
      has_free_refinement_been_used: false,
    })
    .select(CONVERSATION_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to create conversation");
  }

  return mapConversationRow(data as ConversationRow);
}

export async function getConversationById(
  supabase: SupabaseClient,
  id: string
): Promise<ConversationRecord | null> {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select(CONVERSATION_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load conversation");
  }

  return data ? mapConversationRow(data as ConversationRow) : null;
}

export async function updateConversation(
  supabase: SupabaseClient,
  id: string,
  patch: UpdateConversationInput
): Promise<ConversationRecord> {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .update({
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.repoPath !== undefined ? { repo_path: patch.repoPath } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.chargedRunCount !== undefined
        ? { charged_run_count: patch.chargedRunCount }
        : {}),
      ...(patch.refinementCount !== undefined
        ? { refinement_count: patch.refinementCount }
        : {}),
      ...(patch.hasFreeRefinementBeenUsed !== undefined
        ? {
            has_free_refinement_been_used: patch.hasFreeRefinementBeenUsed,
          }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select(CONVERSATION_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to update conversation");
  }

  return mapConversationRow(data as ConversationRow);
}
