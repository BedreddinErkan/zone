"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserQuota = getUserQuota;
exports.createConversation = createConversation;
exports.getConversationByThreadId = getConversationByThreadId;
exports.upsertConversation = upsertConversation;
exports.appendConversationMessages = appendConversationMessages;
const TABLE_NAME = "conversations";
const CONVERSATION_COLUMNS = "id,user_id,thread_id,repo_path,messages,created_at,updated_at";
function normalizeMessages(value) {
    return Array.isArray(value) ? value : [];
}
function mapConversationRow(row) {
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
async function getUserQuota(supabase, userId) {
    const { data, error } = await supabase
        .from("profiles")
        .select("runs_used_this_month,credits,subscription_status,token_credits_used,token_credits_limit")
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
        tokenCreditsUsed: row.token_credits_used ?? 0,
        tokenCreditsLimit: row.token_credits_limit ?? 500000,
    };
}
async function createConversation(supabase, input) {
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
    return mapConversationRow(data);
}
async function getConversationByThreadId(supabase, input) {
    const { data, error } = await supabase
        .from(TABLE_NAME)
        .select(CONVERSATION_COLUMNS)
        .eq("user_id", input.userId)
        .eq("thread_id", input.threadId)
        .maybeSingle();
    if (error) {
        throw new Error(error.message || "Failed to load conversation");
    }
    return data ? mapConversationRow(data) : null;
}
async function upsertConversation(supabase, input) {
    const { data, error } = await supabase
        .from(TABLE_NAME)
        .upsert({
        user_id: input.userId,
        thread_id: input.threadId,
        repo_path: input.repoPath ?? null,
        messages: Array.isArray(input.messages) ? input.messages : [],
        updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,thread_id" })
        .select(CONVERSATION_COLUMNS)
        .single();
    if (error || !data) {
        throw new Error(error?.message || "Failed to upsert conversation");
    }
    return mapConversationRow(data);
}
async function appendConversationMessages(supabase, input) {
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
//# sourceMappingURL=conversationRepository.js.map