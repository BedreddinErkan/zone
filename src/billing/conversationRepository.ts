import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ConversationBillingMode,
  ConversationRole,
} from "../types/conversation.js";

type ConversationRow = {
  id: string;
  user_id: string;
  thread_id: string;
  repo_path: string | null;
  messages: unknown;
  created_at: string;
  updated_at: string;
};

type UserQuotaRow = {
  runs_used_this_month: number | null;
  credits: number | null;
  subscription_status: string | null;
  token_credits_used: number | null;
  token_credits_limit: number | null;
};

export interface CreateConversationInput {
  userId: string;
  threadId: string;
  repoPath?: string | null;
  messages?: unknown[];
  // kept for backwards-compat callers; not stored in table
  mode?: ConversationBillingMode;
  role?: ConversationRole;
}

export interface AppendConversationMessagesInput {
  userId: string;
  threadId: string;
  repoPath?: string | null;
  appendMessages: unknown[];
}

const TABLE_NAME = "conversations";
const CONVERSATION_COLUMNS =
  "id,user_id,thread_id,repo_path,messages,created_at,updated_at";

export type PersistedConversation = {
  id: string;
  userId: string;
  threadId: string;
  repoPath: string | null;
  messages: unknown[];
  createdAt: string;
  updatedAt: string;
};

function normalizeMessages(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mapConversationRow(row: ConversationRow): PersistedConversation {
  return {
    id: row.id,
    userId: row.user_id,
    threadId: row.thread_id,
    repoPath: row.repo_path,
    messages: normalizeMessages(row.messages),
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
  tokenCreditsUsed: number;
  tokenCreditsLimit: number;
}> {
  const { data, error } = await supabase
    .from("profiles")
    .select("runs_used_this_month,credits,subscription_status,token_credits_used,token_credits_limit")
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
    tokenCreditsUsed: row.token_credits_used ?? 0,
    tokenCreditsLimit: row.token_credits_limit ?? 500000,
  };
}

export async function createConversation(
  supabase: SupabaseClient,
  input: CreateConversationInput
): Promise<PersistedConversation> {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .insert({
      user_id: input.userId,
      thread_id: input.threadId,
      repo_path: input.repoPath ?? null,
      messages: Array.isArray(input.messages) ? input.messages : [],
    })
    .select(CONVERSATION_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to create conversation");
  }

  return mapConversationRow(data as ConversationRow);
}

export async function getConversationByThreadId(
  supabase: SupabaseClient,
  input: { userId: string; threadId: string }
): Promise<PersistedConversation | null> {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select(CONVERSATION_COLUMNS)
    .eq("user_id", input.userId)
    .eq("thread_id", input.threadId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load conversation");
  }

  return data ? mapConversationRow(data as ConversationRow) : null;
}

export async function upsertConversation(
  supabase: SupabaseClient,
  input: {
    userId: string;
    threadId: string;
    repoPath?: string | null;
    messages: unknown[];
  }
): Promise<PersistedConversation> {
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .upsert(
      {
        user_id: input.userId,
        thread_id: input.threadId,
        repo_path: input.repoPath ?? null,
        messages: Array.isArray(input.messages) ? input.messages : [],
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,thread_id" }
    )
    .select(CONVERSATION_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to upsert conversation");
  }

  return mapConversationRow(data as ConversationRow);
}

export async function appendConversationMessages(
  supabase: SupabaseClient,
  input: AppendConversationMessagesInput
): Promise<PersistedConversation> {
  const existing = await getConversationByThreadId(supabase, {
    userId: input.userId,
    threadId: input.threadId,
  });

  const mergedMessages = [
    ...normalizeMessages(existing?.messages),
    ...(Array.isArray(input.appendMessages) ? input.appendMessages : []),
  ];

  return await upsertConversation(supabase, {
    userId: input.userId,
    threadId: input.threadId,
    repoPath: input.repoPath ?? existing?.repoPath ?? null,
    messages: mergedMessages,
  });
}
