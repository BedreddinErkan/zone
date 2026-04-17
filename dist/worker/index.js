"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processNextDeveloperPatchJob = processNextDeveloperPatchJob;
exports.runDeveloperPatchWorker = runDeveloperPatchWorker;
require("dotenv/config");
const supabase_js_1 = require("@supabase/supabase-js");
const runLlmPatchFlow_js_1 = require("../core/runLlmPatchFlow.js");
const validateLlmOutput_js_1 = require("../core/validateLlmOutput.js");
const developerPatchJobs_js_1 = require("../jobs/developerPatchJobs.js");
const runLogging_js_1 = require("../api/runLogging.js");
const IDLE_DELAY_MS = 1500;
function getWorkerSupabaseClient() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key)
        return null;
    return (0, supabase_js_1.createClient)(url, key);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function getDeveloperDecisionModeFromResult(result, confidence) {
    const decisionMode = result.decisionMode;
    if (typeof decisionMode === "string" && decisionMode.length > 0) {
        return decisionMode;
    }
    return confidence < 70 ? "preview_only" : "safe_to_apply";
}
async function processDeveloperPatchJob(supabase, job) {
    const requestPayload = job.request_payload;
    if (!requestPayload) {
        await (0, developerPatchJobs_js_1.markDeveloperPatchJobFailed)(supabase, job.id, "Missing developer patch job payload.");
        return;
    }
    try {
        const result = await (0, runLlmPatchFlow_js_1.runLlmPatchFlow)({
            task: requestPayload.task,
            repoPath: requestPayload.repoPath,
            hostedContext: requestPayload.hostedContext,
            userOpenAiKey: requestPayload.userOpenAiKey,
            onProgress: async (stage) => {
                await (0, developerPatchJobs_js_1.updateDeveloperPatchJobProgress)(supabase, job.id, stage);
            },
        });
        if (result.ok && result.applyPatches.length > 0) {
            const validation = (0, validateLlmOutput_js_1.validateLlmOutput)("developer", result.applyPatches.map((patch) => ({
                filePath: patch.filePath,
                content: patch.fullContent,
            })));
            if (validation.verdict === "block") {
                await (0, developerPatchJobs_js_1.markDeveloperPatchJobFailed)(supabase, job.id, "Output validation failed — patch blocked.");
                return;
            }
            if (validation.issues.length > 0) {
                result.validationIssues = validation.issues;
                result.validationVerdict = validation.verdict;
            }
        }
        if (!result.ok) {
            await (0, developerPatchJobs_js_1.markDeveloperPatchJobFailed)(supabase, job.id, result.reason || "Developer patch job failed.");
            return;
        }
        const confidence = typeof result.developerConfidence === "number"
            ? result.developerConfidence
            : 0;
        console.log("[zone-billing-debug] execution success reached", {
            routeName: "/api/patch/jobs worker",
            userId: requestPayload.userId,
            billingMode: requestPayload.billingMode ?? null,
            isByok: Boolean(requestPayload.isByok),
        });
        const conversationId = await (0, runLogging_js_1.logRun)({
            userId: requestPayload.userId,
            role: "developer",
            task: requestPayload.task,
            repoPath: requestPayload.repoPath,
            decisionMode: getDeveloperDecisionModeFromResult(result, confidence),
            confidence,
            creditsUsed: 1,
            conversationId: requestPayload.conversationId,
            billingMode: requestPayload.billingMode,
            isByok: requestPayload.isByok,
            routeName: "/api/patch/jobs worker",
        }).catch(() => null);
        if (conversationId) {
            result.conversationId = conversationId;
        }
        await (0, developerPatchJobs_js_1.markDeveloperPatchJobCompleted)(supabase, job.id, result);
    }
    catch (error) {
        await (0, developerPatchJobs_js_1.markDeveloperPatchJobFailed)(supabase, job.id, error instanceof Error ? error.message : "Unknown worker error");
    }
}
async function processNextDeveloperPatchJob() {
    const supabase = getWorkerSupabaseClient();
    if (!supabase) {
        return false;
    }
    const job = await (0, developerPatchJobs_js_1.claimNextQueuedDeveloperPatchJob)(supabase);
    if (!job) {
        return false;
    }
    await processDeveloperPatchJob(supabase, job);
    return true;
}
async function runDeveloperPatchWorker() {
    for (;;) {
        const processed = await processNextDeveloperPatchJob();
        if (!processed) {
            await sleep(IDLE_DELAY_MS);
        }
    }
}
if (process.env.VITEST !== "true") {
    void runDeveloperPatchWorker();
}
//# sourceMappingURL=index.js.map