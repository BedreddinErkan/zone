import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createConversation,
  getConversationById,
  updateConversation,
} from "../billing/conversationRepository.js";
import { resolveBillingAction } from "../billing/resolveBillingAction.js";
import type {
  ConversationBillingMode,
  ConversationRole,
} from "../types/conversation.js";

export type RunLogInput = {
  userId: string;
  role: ConversationRole;
  task: string;
  repoPath: string;
  decisionMode: string;
  confidence: number;
  creditsUsed: number;
  conversationId?: string;
  billingMode?: ConversationBillingMode;
  isByok?: boolean;
};

function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function resolveBillingMode(input: RunLogInput): ConversationBillingMode {
  if (input.billingMode === "hosted" || input.billingMode === "byok") {
    return input.billingMode;
  }

  return input.isByok ? "byok" : "hosted";
}

function normalizeSubscriptionStatus(value: unknown): "free" | "pro" {
  return typeof value === "string" && value.trim().toLowerCase() === "pro"
    ? "pro"
    : "free";
}

export async function logRun(input: RunLogInput): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const effectiveUserId =
    typeof input.userId === "string" ? input.userId.trim() : "";

  const userEmail =
    typeof process.env.ZONE_USER_EMAIL === "string"
      ? process.env.ZONE_USER_EMAIL.trim()
      : "";

  if (!effectiveUserId) {
    return null;
  }

  await supabase.from("run_logs").insert({
    user_id: effectiveUserId,
    ...(userEmail ? { user_email: userEmail } : {}),
    role: input.role,
    task: input.task,
    repo_path: input.repoPath,
    decision: input.decisionMode,
    confidence: input.confidence,
    credits_used: input.creditsUsed,
  });

  const billingMode = resolveBillingMode(input);
  const profilesTable = supabase.from("profiles") as unknown as {
    select?: (
      columns: string
    ) => {
      eq?: (column: string, value: string) => {
        maybeSingle?: () => Promise<{
          data: { subscription_status?: string | null } | null;
          error?: unknown;
        }>;
      };
    };
  };
  const profileQuery = profilesTable
    .select?.("subscription_status")
    ?.eq?.("clerk_user_id", effectiveUserId);
  const profileResult =
    profileQuery && typeof profileQuery.maybeSingle === "function"
      ? await profileQuery.maybeSingle().catch(() => ({ data: null, error: null }))
      : { data: null, error: null };
  const hasPaidAccess =
    normalizeSubscriptionStatus(profileResult.data?.subscription_status) === "pro";
  let conversation =
    typeof input.conversationId === "string" && input.conversationId.trim()
      ? await getConversationById(supabase, input.conversationId.trim())
      : null;

  if (
    conversation &&
    (conversation.repoPath !== input.repoPath || conversation.role !== input.role)
  ) {
    conversation = null;
  }

  if (!conversation) {
    conversation = await createConversation(supabase, {
      userId: effectiveUserId,
      mode: billingMode,
      repoPath: input.repoPath,
      role: input.role,
    });
  }

  const billingAction = resolveBillingAction({
    mode: billingMode,
    hasPaidAccess,
  });

  if (billingAction === "FREE") {
    return conversation.id;
  }

  const rpcResult = await supabase.rpc("deduct_credits_and_increment_runs", {
    p_user_id: effectiveUserId,
    p_credits: 1,
  });

  if (rpcResult?.error) {
    return null;
  }

  await updateConversation(supabase, conversation.id, {
    chargedRunCount: conversation.chargedRunCount + 1,
  });

  return conversation.id;
}

export function queueRunLog(input: RunLogInput): void {
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  if (!userId) return;
  void logRun(input).catch(() => undefined);
}
