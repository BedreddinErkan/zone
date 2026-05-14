import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getUserQuota,
  appendConversationMessages,
} from "../billing/conversationRepository.js";
import { resolveBillingAction } from "../billing/resolveBillingAction.js";
import type {
  ConversationBillingMode,
  ConversationRole,
} from "../types/conversation.js";
import { randomUUID } from "node:crypto";

export type RunLogInput = {
  userId: string;
  role: ConversationRole;
  task: string;
  repoPath: string;
  decisionMode: string;
  confidence: number;
  creditsUsed: number;
  executionId?: string;
  conversationId?: string;
  changedFiles?: string[];
  billingMode?: ConversationBillingMode;
  tokensUsed?: number;
  routeName?: string;
  /**
   * J.5: the agent's final summary string from the just-completed run.
   * When present and the run rolled back (decisionMode === "rolled_back"),
   * we persist a compact {type:"agent_summary"} event into the conversation
   * so the next run can thread it back into runAgentLoop as priorRunSummary.
   * Skipped for non-rollback runs to keep the conversation lean.
   */
  agentSummary?: string;
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
    const threadId =
      typeof input.conversationId === "string" && input.conversationId.trim()
        ? input.conversationId.trim()
        : randomUUID();

    const now = Date.now();
    const appendMessages: unknown[] = [
      {
        type: "user",
        text: input.task,
        ts: now,
        role: input.role,
        changedFiles: Array.isArray(input.changedFiles)
          ? input.changedFiles.filter((x) => typeof x === "string" && x.trim()).slice(0, 20)
          : undefined,
      },
      {
        type: "run",
        ts: now,
        decisionMode: input.decisionMode,
        confidence: input.confidence,
        creditsUsed: input.creditsUsed,
        executionId: input.executionId ?? null,
      },
    ];
    // J.5: persist the agent's summary on rollback so the next run can
    // thread it back into runAgentLoop. Capped + marker-preserving to
    // keep the conversation row size bounded.
    if (
      input.decisionMode === "rolled_back" &&
      typeof input.agentSummary === "string" &&
      input.agentSummary.trim()
    ) {
      const { truncatePriorRunSummary } = await import(
        "../llm/applyRollbackFeedback.js"
      );
      appendMessages.push({
        type: "agent_summary",
        ts: now,
        decisionMode: input.decisionMode,
        text: truncatePriorRunSummary(input.agentSummary),
      });
    }

    conversation = await appendConversationMessages(supabase, {
      userId: effectiveUserId,
      threadId,
      repoPath: input.repoPath,
      appendMessages,
    });
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
    return conversation?.threadId ?? null;
  }

  logBillingDebug("deduction rpc start", {
    routeName: input.routeName ?? "unknown",
    userId: effectiveUserId,
    credits: 1,
  });
  const tokensToDeduct = typeof input.tokensUsed === "number" && input.tokensUsed > 0
    ? input.tokensUsed
    : 50000;
  const executionId =
    typeof input.executionId === "string" && input.executionId.trim()
      ? input.executionId.trim()
      : conversation?.id ?? "";
  const rpcResult = await supabase.rpc("deduct_tokens_idempotent", {
    p_user_id: effectiveUserId,
    p_execution_id: executionId,
    p_tokens: tokensToDeduct,
    p_billing_mode: billingMode,
  });

  if (rpcResult?.error) {
    const rpcError = rpcResult.error as
      | {
          message?: unknown;
          code?: unknown;
          details?: unknown;
          hint?: unknown;
        }
      | null
      | undefined;
    logBillingDebug("deduction rpc error", {
      routeName: input.routeName ?? "unknown",
      userId: effectiveUserId,
      error:
        typeof rpcError?.message === "string" && rpcError.message.trim()
          ? rpcError.message
          : String(rpcResult.error),
      code: rpcError?.code,
      details: rpcError?.details,
      hint: rpcError?.hint,
      raw: JSON.stringify(
        rpcResult.error,
        Object.getOwnPropertyNames(rpcResult.error ?? {})
      ),
    });
    return null;
  }

  logBillingDebug("deduction rpc success", {
    routeName: input.routeName ?? "unknown",
    userId: effectiveUserId,
  });

  if (conversation) {
    // No-op: conversation persistence is message-based now; billing is enforced via profile quota + RPC.
  }

  return conversation?.threadId ?? null;
}

export function queueRunLog(input: RunLogInput): void {
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  if (!userId) return;
  void logRun(input).catch(() => undefined);
}
