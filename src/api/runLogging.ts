import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createConversation,
  getConversationById,
  getUserQuota,
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
  tokensUsed?: number;
  routeName?: string;
};

function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function normalizeSubscriptionStatus(value: unknown): "free" | "pro" {
  return typeof value === "string" && value.trim().toLowerCase() === "pro"
    ? "pro"
    : "free";
}

function logBillingDebug(message: string, details?: Record<string, unknown>): void {
  if (details && Object.keys(details).length > 0) {
    console.log(`[zone-billing-debug] ${message}`, details);
    return;
  }

  console.log(`[zone-billing-debug] ${message}`);
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

  logBillingDebug("logRun start", {
    routeName: input.routeName ?? "unknown",
    userId: effectiveUserId,
    billingMode: input.billingMode ?? null,
    decisionMode: input.decisionMode,
  });

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
logBillingDebug("run log insert completed", {
  routeName: input.routeName ?? "unknown",
  userId: effectiveUserId,
});
  const billingMode: ConversationBillingMode = "hosted";
let profileResult: {
  data: { subscription_status?: string | null } | null;
  error?: unknown;
} = { data: null, error: null };
let userQuota = {
  runsUsedThisMonth: 0,
  credits: Number.MAX_SAFE_INTEGER,
  subscriptionStatus: "free",
  tokenCreditsUsed: 0,
  tokenCreditsLimit: 500000,
};

try {
  profileResult = await supabase
    .from("profiles")
    .select("subscription_status")
    .eq("clerk_user_id", effectiveUserId)
    .maybeSingle();
} catch (error) {
  logBillingDebug("profile lookup failed", {
    routeName: input.routeName ?? "unknown",
    userId: effectiveUserId,
    error: error instanceof Error ? error.message : String(error),
  });
}
try {
  userQuota = await getUserQuota(supabase, effectiveUserId);
} catch (error) {
  logBillingDebug("quota lookup failed", {
    routeName: input.routeName ?? "unknown",
    userId: effectiveUserId,
    error: error instanceof Error ? error.message : String(error),
  });
}
const hasPaidAccess =
  normalizeSubscriptionStatus(profileResult.data?.subscription_status) === "pro";
const normalizedSubscriptionStatus = normalizeSubscriptionStatus(
  profileResult.data?.subscription_status ?? userQuota.subscriptionStatus
);
logBillingDebug("billing inputs before resolver", {
  routeName: input.routeName ?? "unknown",
  userId: effectiveUserId,
  billingMode,
  subscriptionStatus: normalizedSubscriptionStatus,
  hasPaidAccess,
});
  let conversation = null;
  try {
    conversation =
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
  } catch (error) {
    logBillingDebug("conversation persistence failed", {
      routeName: input.routeName ?? "unknown",
      userId: effectiveUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const billingAction = resolveBillingAction({
    mode: billingMode,
    hasPaidAccess,
    runsUsedThisMonth: userQuota.runsUsedThisMonth,
    credits: userQuota.credits,
    tokenCreditsUsed: userQuota.tokenCreditsUsed,
    tokenCreditsLimit: userQuota.tokenCreditsLimit,
  });

  logBillingDebug("billing action resolved", {
    routeName: input.routeName ?? "unknown",
    userId: effectiveUserId,
    effectiveBillingMode: billingMode,
    subscriptionStatus: normalizedSubscriptionStatus,
    hasPaidAccess,
    billingAction,
  });

  if (billingAction === "FREE") {
    logBillingDebug("deduction skipped", {
      routeName: input.routeName ?? "unknown",
      userId: effectiveUserId,
      reason: "billing_action_free",
    });
  return conversation?.id ?? null;
  }

  logBillingDebug("deduction rpc start", {
    routeName: input.routeName ?? "unknown",
    userId: effectiveUserId,
    credits: 1,
  });
  const tokensToDeduct = typeof input.tokensUsed === "number" && input.tokensUsed > 0
    ? input.tokensUsed
    : 50000;
  const rpcResult = await supabase.rpc("deduct_tokens", {
    p_user_id: effectiveUserId,
    p_tokens: tokensToDeduct,
  });

  if (rpcResult?.error) {
    logBillingDebug("deduction rpc error", {
      routeName: input.routeName ?? "unknown",
      userId: effectiveUserId,
      error:
        rpcResult.error instanceof Error
          ? rpcResult.error.message
          : String(rpcResult.error),
    });
    return null;
  }

  logBillingDebug("deduction rpc success", {
    routeName: input.routeName ?? "unknown",
    userId: effectiveUserId,
  });

  if (conversation) {
    try {
      await updateConversation(supabase, conversation.id, {
        chargedRunCount: conversation.chargedRunCount + 1,
      });
    } catch (error) {
      logBillingDebug("conversation update failed after deduction", {
        routeName: input.routeName ?? "unknown",
        userId: effectiveUserId,
        conversationId: conversation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return conversation?.id ?? null;
}

export function queueRunLog(input: RunLogInput): void {
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  if (!userId) return;
  void logRun(input).catch(() => undefined);
}
