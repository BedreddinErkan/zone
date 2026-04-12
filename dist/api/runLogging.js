"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueRunLog = queueRunLog;
const supabase_js_1 = require("@supabase/supabase-js");
function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key)
        return null;
    return (0, supabase_js_1.createClient)(url, key);
}
function normalizeSubscriptionStatus(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function hasPaidAccess(subscriptionStatus) {
    return normalizeSubscriptionStatus(subscriptionStatus) === "pro";
}
async function logRun(input) {
    const supabase = getSupabaseClient();
    if (!supabase)
        return;
    const effectiveUserId = typeof input.userId === "string" ? input.userId.trim() : "";
    const userEmail = typeof process.env.ZONE_USER_EMAIL === "string"
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
    let normalizedStatus = null;
    try {
        const profileResult = await supabase
            .from("profiles")
            .select("subscription_status")
            .eq("clerk_user_id", effectiveUserId)
            .maybeSingle();
        normalizedStatus = profileResult?.data
            ? normalizeSubscriptionStatus(profileResult.data.subscription_status)
            : null;
    }
    catch {
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
function queueRunLog(input) {
    const userId = typeof input.userId === "string" ? input.userId.trim() : "";
    if (!userId)
        return;
    void logRun(input).catch(() => undefined);
}
//# sourceMappingURL=runLogging.js.map