"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logRun = logRun;
exports.queueRunLog = queueRunLog;
const supabase_js_1 = require("@supabase/supabase-js");
const conversationRepository_js_1 = require("../billing/conversationRepository.js");
const resolveBillingAction_js_1 = require("../billing/resolveBillingAction.js");
function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key)
        return null;
    return (0, supabase_js_1.createClient)(url, key);
}
function resolveBillingMode(input) {
    if (input.billingMode === "hosted" || input.billingMode === "byok") {
        return input.billingMode;
    }
    return input.isByok ? "byok" : "hosted";
}
function normalizeSubscriptionStatus(value) {
    return typeof value === "string" && value.trim().toLowerCase() === "pro"
        ? "pro"
        : "free";
}
function logBillingDebug(message, details) {
    if (details && Object.keys(details).length > 0) {
        console.log(`[zone-billing-debug] ${message}`, details);
        return;
    }
    console.log(`[zone-billing-debug] ${message}`);
}
async function logRun(input) {
    const supabase = getSupabaseClient();
    if (!supabase)
        return null;
    const effectiveUserId = typeof input.userId === "string" ? input.userId.trim() : "";
    const userEmail = typeof process.env.ZONE_USER_EMAIL === "string"
        ? process.env.ZONE_USER_EMAIL.trim()
        : "";
    if (!effectiveUserId) {
        return null;
    }
    logBillingDebug("logRun start", {
        routeName: input.routeName ?? "unknown",
        userId: effectiveUserId,
        billingMode: input.billingMode ?? null,
        isByok: Boolean(input.isByok),
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
    const billingMode = resolveBillingMode(input);
    let profileResult = { data: null, error: null };
    try {
        profileResult = await supabase
            .from("profiles")
            .select("subscription_status")
            .eq("clerk_user_id", effectiveUserId)
            .maybeSingle();
    }
    catch (error) {
        logBillingDebug("profile lookup failed", {
            routeName: input.routeName ?? "unknown",
            userId: effectiveUserId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    const hasPaidAccess = normalizeSubscriptionStatus(profileResult.data?.subscription_status) === "pro";
    const normalizedSubscriptionStatus = normalizeSubscriptionStatus(profileResult.data?.subscription_status);
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
                ? await (0, conversationRepository_js_1.getConversationById)(supabase, input.conversationId.trim())
                : null;
        if (conversation &&
            (conversation.repoPath !== input.repoPath || conversation.role !== input.role)) {
            conversation = null;
        }
        if (!conversation) {
            conversation = await (0, conversationRepository_js_1.createConversation)(supabase, {
                userId: effectiveUserId,
                mode: billingMode,
                repoPath: input.repoPath,
                role: input.role,
            });
        }
    }
    catch (error) {
        logBillingDebug("conversation persistence failed", {
            routeName: input.routeName ?? "unknown",
            userId: effectiveUserId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    const billingAction = (0, resolveBillingAction_js_1.resolveBillingAction)({
        mode: billingMode,
        hasPaidAccess,
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
    const rpcResult = await supabase.rpc("deduct_credits_and_increment_runs", {
        p_user_id: effectiveUserId,
        p_credits: 1,
    });
    if (rpcResult?.error) {
        logBillingDebug("deduction rpc error", {
            routeName: input.routeName ?? "unknown",
            userId: effectiveUserId,
            error: rpcResult.error instanceof Error
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
            await (0, conversationRepository_js_1.updateConversation)(supabase, conversation.id, {
                chargedRunCount: conversation.chargedRunCount + 1,
            });
        }
        catch (error) {
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
function queueRunLog(input) {
    const userId = typeof input.userId === "string" ? input.userId.trim() : "";
    if (!userId)
        return;
    void logRun(input).catch(() => undefined);
}
//# sourceMappingURL=runLogging.js.map