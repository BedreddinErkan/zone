"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDeveloperPatchJob = createDeveloperPatchJob;
exports.getDeveloperPatchJob = getDeveloperPatchJob;
exports.claimNextQueuedDeveloperPatchJob = claimNextQueuedDeveloperPatchJob;
exports.updateDeveloperPatchJobProgress = updateDeveloperPatchJobProgress;
exports.markDeveloperPatchJobRunning = markDeveloperPatchJobRunning;
exports.markDeveloperPatchJobCompleted = markDeveloperPatchJobCompleted;
exports.markDeveloperPatchJobFailed = markDeveloperPatchJobFailed;
const node_crypto_1 = require("node:crypto");
const TABLE_NAME = "developer_patch_jobs";
const JOB_COLUMNS = "id,user_id,role,task,repo_path,status,progress_stage,request_payload,result_payload,error_message,created_at,started_at,finished_at";
async function createDeveloperPatchJob(supabase, input) {
    const id = (0, node_crypto_1.randomUUID)();
    const { data, error } = await supabase
        .from(TABLE_NAME)
        .insert({
        id,
        user_id: input.userId,
        role: "developer",
        task: input.task,
        repo_path: input.repoPath,
        status: "queued",
        progress_stage: "Queued",
        request_payload: input.requestPayload,
    })
        .select(JOB_COLUMNS)
        .single();
    if (error || !data) {
        throw new Error(error?.message || "Failed to create developer patch job");
    }
    return data;
}
async function getDeveloperPatchJob(supabase, runId) {
    const { data, error } = await supabase
        .from(TABLE_NAME)
        .select(JOB_COLUMNS)
        .eq("id", runId)
        .maybeSingle();
    if (error) {
        throw new Error(error.message || "Failed to load developer patch job");
    }
    return data ?? null;
}
async function claimNextQueuedDeveloperPatchJob(supabase) {
    const { data, error } = await supabase.rpc("claim_next_developer_patch_job");
    if (error) {
        throw new Error(error.message || "Failed to claim developer patch job");
    }
    if (!data)
        return null;
    const claimed = Array.isArray(data) ? data[0] : data;
    return claimed ?? null;
}
async function updateDeveloperPatchJobProgress(supabase, runId, progressStage) {
    const { error } = await supabase
        .from(TABLE_NAME)
        .update({
        progress_stage: progressStage,
    })
        .eq("id", runId);
    if (error) {
        throw new Error(error.message || "Failed to update developer patch job progress");
    }
}
async function markDeveloperPatchJobRunning(supabase, runId, progressStage = "Running") {
    const { error } = await supabase
        .from(TABLE_NAME)
        .update({
        status: "running",
        progress_stage: progressStage,
        started_at: new Date().toISOString(),
    })
        .eq("id", runId);
    if (error) {
        throw new Error(error.message || "Failed to mark developer patch job running");
    }
}
async function markDeveloperPatchJobCompleted(supabase, runId, resultPayload) {
    const { error } = await supabase
        .from(TABLE_NAME)
        .update({
        status: "completed",
        progress_stage: "Ready",
        result_payload: resultPayload,
        error_message: null,
        finished_at: new Date().toISOString(),
    })
        .eq("id", runId);
    if (error) {
        throw new Error(error.message || "Failed to complete developer patch job");
    }
}
async function markDeveloperPatchJobFailed(supabase, runId, errorMessage) {
    const { error } = await supabase
        .from(TABLE_NAME)
        .update({
        status: "failed",
        progress_stage: "Ready",
        error_message: errorMessage,
        finished_at: new Date().toISOString(),
    })
        .eq("id", runId);
    if (error) {
        throw new Error(error.message || "Failed to fail developer patch job");
    }
}
//# sourceMappingURL=developerPatchJobs.js.map