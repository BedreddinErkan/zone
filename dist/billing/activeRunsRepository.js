"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertActiveRun = upsertActiveRun;
exports.completeActiveRun = completeActiveRun;
exports.getActiveRunsByUser = getActiveRunsByUser;
exports.getActiveRun = getActiveRun;
exports.markAllRunningAsInterrupted = markAllRunningAsInterrupted;
const supabase_js_1 = require("@supabase/supabase-js");
const logger_js_1 = require("../utils/logger.js");
const TABLE_NAME = "zone_active_runs";
const ACTIVE_RUN_COLUMNS = "run_id,user_id,thread_id,conversation_id,repo_path,task,status,started_at,completed_at,last_changed_files,last_added_functions";
function getSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key)
        return null;
    return (0, supabase_js_1.createClient)(url, key);
}
function normalizeJsonArray(value) {
    return Array.isArray(value) ? value : null;
}
function mapActiveRunRow(row) {
    return {
        runId: row.run_id,
        userId: row.user_id,
        threadId: row.thread_id,
        conversationId: row.conversation_id,
        repoPath: row.repo_path,
        task: row.task,
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        lastChangedFiles: normalizeJsonArray(row.last_changed_files),
        lastAddedFunctions: normalizeJsonArray(row.last_added_functions),
    };
}
async function upsertActiveRun(runId, input) {
    const supabase = getSupabaseClient();
    if (!supabase)
        return null;
    const { data, error } = await supabase
        .from(TABLE_NAME)
        .upsert({
        run_id: runId,
        user_id: input.userId,
        thread_id: input.threadId,
        conversation_id: input.conversationId,
        repo_path: input.repoPath,
        task: input.task,
        status: input.status,
        last_changed_files: Array.isArray(input.lastChangedFiles)
            ? input.lastChangedFiles
            : null,
        last_added_functions: Array.isArray(input.lastAddedFunctions)
            ? input.lastAddedFunctions
            : null,
        ...(input.status === "completed" || input.status === "cancelled"
            ? { completed_at: new Date().toISOString() }
            : {}),
    }, { onConflict: "run_id" })
        .select(ACTIVE_RUN_COLUMNS)
        .single();
    if (error || !data) {
        throw new Error(error?.message || "Failed to upsert active run");
    }
    return mapActiveRunRow(data);
}
async function completeActiveRun(runId, status) {
    const supabase = getSupabaseClient();
    if (!supabase)
        return;
    const { error } = await supabase
        .from(TABLE_NAME)
        .update({
        status,
        completed_at: new Date().toISOString(),
    })
        .eq("run_id", runId);
    if (error) {
        throw new Error(error.message || "Failed to complete active run");
    }
}
async function getActiveRunsByUser(userId) {
    const supabase = getSupabaseClient();
    if (!supabase)
        return [];
    const { data, error } = await supabase
        .from(TABLE_NAME)
        .select(ACTIVE_RUN_COLUMNS)
        .eq("user_id", userId)
        .in("status", ["running", "interrupted"])
        .order("started_at", { ascending: false });
    if (error) {
        throw new Error(error.message || "Failed to load active runs");
    }
    const runs = Array.isArray(data)
        ? data.map((row) => mapActiveRunRow(row))
        : [];
    logger_js_1.logger.info("[active-runs] repository fetch userId=%s count=%d staleCount=%d", userId, runs.length, runs.filter((run) => run.status !== "running").length);
    return runs;
}
async function getActiveRun(runId) {
    const supabase = getSupabaseClient();
    if (!supabase)
        return null;
    const { data, error } = await supabase
        .from(TABLE_NAME)
        .select(ACTIVE_RUN_COLUMNS)
        .eq("run_id", runId)
        .maybeSingle();
    if (error) {
        throw new Error(error.message || "Failed to load active run");
    }
    return data ? mapActiveRunRow(data) : null;
}
async function markAllRunningAsInterrupted() {
    const supabase = getSupabaseClient();
    if (!supabase)
        return 0;
    const { count, error: countError } = await supabase
        .from(TABLE_NAME)
        .select("run_id", { count: "exact", head: true })
        .eq("status", "running");
    if (countError) {
        throw new Error(countError.message || "Failed to count running active runs");
    }
    const { error } = await supabase
        .from(TABLE_NAME)
        .update({ status: "interrupted" })
        .eq("status", "running");
    if (error) {
        throw new Error(error.message || "Failed to mark running runs as interrupted");
    }
    return Number(count || 0);
}
//# sourceMappingURL=activeRunsRepository.js.map