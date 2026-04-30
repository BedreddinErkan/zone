"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_LIFECYCLE_EVENT_TYPES = void 0;
exports.createAgentLifecycleEvent = createAgentLifecycleEvent;
exports.AGENT_LIFECYCLE_EVENT_TYPES = [
    "run_started",
    "intent_understood",
    "repo_explored",
    "relevant_files_ranked",
    "plan_created",
    "patch_preview_empty_fallback_target_selected",
    "file_context_loaded",
    "patch_generation_started",
    "patch_generated",
    "patch_generation_failed",
    "patch_correctness_checked",
    "verification_planned",
    "verification_started",
    "verification_passed",
    "verification_failed",
    "tooling_issue",
    "run_completed",
    "run_cancelled",
];
function createAgentLifecycleEvent(input) {
    return {
        ...input,
        timestamp: input.timestamp ?? new Date().toISOString(),
    };
}
//# sourceMappingURL=agentLifecycleEvents.js.map