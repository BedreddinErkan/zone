import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type RunLogInput = {
  userId: string;
  role: string;
  task: string;
  repoPath: string;
  decisionMode: string;
  confidence: number;
  creditsUsed: number;
  isByok?: boolean;
};

function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function normalizeSubscriptionStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasPaidAccess(subscriptionStatus: unknown): boolean {
  return normalizeSubscriptionStatus(subscriptionStatus) === "pro";
}

async function logRun(input: RunLogInput): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  const effectiveUserId =
    typeof input.userId === "string" ? input.userId.trim() : "";

  const userEmail =
    typeof process.env.ZONE_USER_EMAIL === "string"
      ? process.env.ZONE_USER_EMAIL.trim()
      : "";

  if (!effectiveUserId) {
    return;
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

  let normalizedStatus: string | null = null;
  try {
    const profileResult = await supabase
      .from("profiles")
      .select("subscription_status")
      .eq("clerk_user_id", effectiveUserId)
      .maybeSingle();

    normalizedStatus = profileResult?.data
      ? normalizeSubscriptionStatus(profileResult.data.subscription_status)
      : null;
  } catch {
    normalizedStatus = null;
  }

  if (input.isByok && hasPaidAccess(normalizedStatus)) {
    return;
  }

  await supabase.rpc("deduct_credits_and_increment_runs", {
    p_user_id: effectiveUserId,
    p_credits: 1,
  });
}

export function queueRunLog(input: RunLogInput): void {
  const userId = typeof input.userId === "string" ? input.userId.trim() : "";
  if (!userId) return;
  void logRun(input).catch(() => undefined);
}
