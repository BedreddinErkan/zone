"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserQuota = getUserQuota;
exports.createConversation = createConversation;
exports.getConversationById = getConversationById;
exports.updateConversation = updateConversation;
const node_crypto_1 = require("node:crypto");
const TABLE_NAME = "conversations";
const CONVERSATION_COLUMNS = "id,user_id,mode,repo_path,role,charged_run_count,refinement_count,has_free_refinement_been_used,created_at,updated_at";
function mapConversationRow(row) {
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
async function getUserQuota(supabase, userId) {
    const { data, error } = await supabase
        .from("profiles")
        .select("runs_used_this_month,credits,subscription_status")
        .eq("clerk_user_id", userId)
        .maybeSingle();
    if (error || !data) {
        throw new Error(error?.message || "Failed to load user quota");
    }
    const row = data;
    return {
        runsUsedThisMonth: row.runs_used_this_month ?? 0,
        credits: row.credits ?? 0,
        subscriptionStatus: row.subscription_status ?? "",
    };
}
async function createConversation(supabase, input) {
    const id = (0, node_crypto_1.randomUUID)();
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
    return mapConversationRow(data);
}
async function getConversationById(supabase, id) {
    const { data, error } = await supabase
        .from(TABLE_NAME)
        .select(CONVERSATION_COLUMNS)
        .eq("id", id)
        .maybeSingle();
    if (error) {
        throw new Error(error.message || "Failed to load conversation");
    }
    return data ? mapConversationRow(data) : null;
}
async function updateConversation(supabase, id, patch) {
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
    return mapConversationRow(data);
}
//# sourceMappingURL=conversationRepository.js.map