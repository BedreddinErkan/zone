import type { ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";
import type { RemoteControlFrame } from "./controlServer.js";
import { log } from "../utils/logger.js";

/** Event types already reported as unmapped — the warning is per type, not per event. */
const unmappedWarned = new Set<string>();

/** Test-only: clear the once-per-type unmapped-event dedupe. */
export function _resetUnmappedWarnedForTest(): void {
  unmappedWarned.clear();
}

/**
 * Maximum byte length for string fields that may contain large content
 * (detail, responseText, stagedVerificationSummary). Fields exceeding this
 * are sliced and suffixed with a truncation marker.
 */
export const WIRE_BYTE_CAP = 8 * 1024;

/**
 * Event types that are internal-only noise and must not cross the wire.
 * Callers receive null for these and should skip them.
 */
const NOISE_TYPES = new Set<ZoneStructuredProgressEvent["type"]>([
  "loop_warning_emitted",
  "compaction_started",
  "compaction_status",
  "compaction_exhausted",
  "compaction_overflow_warning",
  "iter_cost_update",
]);

function truncate(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.length > WIRE_BYTE_CAP ? s.slice(0, WIRE_BYTE_CAP) + "…[truncated]" : s;
}

/**
 * Project a ZoneStructuredProgressEvent onto a RemoteControlFrame using an
 * explicit allowlist. This is the security boundary between the agent's
 * internal event stream and the WS wire:
 *
 * - metadata is never forwarded (freeform bag; may contain screenshotPath
 *   and other arbitrary internal data).
 * - patch bodies are never forwarded; filePath is included instead.
 * - detail, responseText, stagedVerificationSummary are truncated to WIRE_BYTE_CAP.
 * - responseHtml is never forwarded.
 * - stagedFilesJson is never forwarded (raw staged file content).
 * - planStepsJson is never forwarded (can be large; planObjective is included).
 *
 * Subagent runId rewrite: ZoneStructuredProgressEvent already carries parentRunId
 * and subagentId on subagent events. When both are present, the wire frame uses
 * parentRunId so the client sees a consistent top-level runId throughout.
 *
 * Returns null for noise events (NOISE_TYPES); callers should skip null results.
 */
export function toWireFrame(evt: ZoneStructuredProgressEvent): RemoteControlFrame | null {
  if (NOISE_TYPES.has(evt.type)) return null;

  // Subagent runId rewrite — pure, no AsyncLocalStorage needed.
  const wireRunId =
    evt.parentRunId && evt.subagentId ? evt.parentRunId : evt.runId;

  const base: RemoteControlFrame = {
    type: evt.type,
    runId: wireRunId,
    ts: evt.ts,
    title: evt.title,
    ...(evt.status !== undefined && { status: evt.status }),
  };

  switch (evt.type) {
    // Output chunks: text/delta content only.
    case "narration":
    case "thinking":
    case "chat_chunk":
    case "patch_stream_delta":
    case "tool_input_delta":
      return {
        ...base,
        ...(evt.text !== undefined && { text: evt.text }),
        ...(evt.delta !== undefined && { delta: evt.delta }),
        ...(evt.blockId !== undefined && { blockId: evt.blockId }),
        ...(evt.isFirstDelta !== undefined && { isFirstDelta: evt.isFirstDelta }),
      };

    // Tool events: path + command + truncated detail. Patch body and metadata dropped.
    case "tool_call":
    case "tool_result":
      return {
        ...base,
        ...(evt.toolName !== undefined && { toolName: evt.toolName }),
        ...(evt.filePath !== undefined && { filePath: evt.filePath }),
        ...(evt.command !== undefined && { command: evt.command }),
        ...(evt.detail !== undefined && { detail: truncate(evt.detail) }),
        ...(evt.iter !== undefined && { iter: evt.iter }),
      };

    // Terminal: stream tag + exit code + truncated output text (in detail).
    case "terminal_output":
    case "terminal_done":
      return {
        ...base,
        ...(evt.stream !== undefined && { stream: evt.stream }),
        ...(evt.exitCode !== undefined && { exitCode: evt.exitCode }),
        ...(evt.detail !== undefined && { detail: truncate(evt.detail) }),
      };

    // Command/edit/trust approvals: approvalId + command/path MUST cross the wire
    // so the operator can make an informed decision and echo approvalId back.
    case "command_approval_required":
    case "edit_approval_required":
    case "trust_approval_required":
      return {
        ...base,
        ...(evt.approvalId !== undefined && { approvalId: evt.approvalId }),
        ...(evt.command !== undefined && { command: evt.command }),
        ...(evt.projectPath !== undefined && { projectPath: evt.projectPath }),
      };

    // Plan approval: planId + objective. planStepsJson dropped (can be large).
    case "plan_ready_for_approval":
      return {
        ...base,
        ...(evt.approvalId !== undefined && { approvalId: evt.approvalId }),
        ...(evt.planId !== undefined && { planId: evt.planId }),
        ...(evt.planObjective !== undefined && { planObjective: evt.planObjective }),
        ...(evt.planScopeNotes !== undefined && { planScopeNotes: evt.planScopeNotes }),
        ...(evt.planNoChangeReason !== undefined && { planNoChangeReason: evt.planNoChangeReason }),
        ...(evt.planCannotVerifyReason !== undefined && { planCannotVerifyReason: evt.planCannotVerifyReason }),
        ...(evt.planRiskHints !== undefined && { planRiskHints: evt.planRiskHints }),
        ...(evt.planScopeSummary !== undefined && { planScopeSummary: evt.planScopeSummary }),
      };

    // Staged diff approval: approvalId + summary. stagedFilesJson dropped (raw file content).
    case "staged_diffs_ready_for_approval":
      return {
        ...base,
        ...(evt.approvalId !== undefined && { approvalId: evt.approvalId }),
        ...(evt.stagedVerificationSummary !== undefined && {
          stagedVerificationSummary: truncate(evt.stagedVerificationSummary),
        }),
      };

    // The agent's question MUST cross with its body: a question without its text
    // is an unanswerable prompt, and questionId is the handle a reply carries
    // back. No truncation — a question long enough to hit the cap is a bug in
    // the asking, not a payload to trim.
    //
    // @unverified-probe(remote:ask-user-unwired) — the frame is correct; no
    // remote client renders it or routes an answer back, and the loop refuses to
    // park for any channel but the TUI. Wiring it needs BOTH a client and an
    // allowlist entry; the allowlist is the safety property, do not relax it to
    // make a client appear to work.
    case "user_question_required":
      return {
        ...base,
        ...(evt.questionId !== undefined && { questionId: evt.questionId }),
        ...(evt.question !== undefined && { question: evt.question }),
      };

    // Scope revision: revision metadata only.
    case "scope_revision_proposed":
    case "scope_revision_resolved":
      return {
        ...base,
        ...(evt.revisionId !== undefined && { revisionId: evt.revisionId }),
        ...(evt.revisionType !== undefined && { revisionType: evt.revisionType }),
        ...(evt.revisionReason !== undefined && { revisionReason: evt.revisionReason }),
      };

    // Lifecycle / completion / error.
    case "agent_loop_start":
    case "agent_loop_complete":
    case "run_summary":
    case "run_failed":
      return {
        ...base,
        ...(evt.detail !== undefined && { detail: truncate(evt.detail) }),
        ...(evt.responseText !== undefined && { responseText: truncate(evt.responseText) }),
        // responseHtml and metadata dropped.
        ...(evt.filesChanged !== undefined && { filesChanged: evt.filesChanged }),
        ...(evt.verification !== undefined && { verification: evt.verification }),
        ...(evt.cost !== undefined && { cost: evt.cost }),
        ...(evt.userMessage !== undefined && { userMessage: evt.userMessage }),
        ...(evt.errorKind !== undefined && { errorKind: evt.errorKind }),
        ...(evt.iter !== undefined && { iter: evt.iter }),
        ...(evt.totalIter !== undefined && { totalIter: evt.totalIter }),
      };

    // Task classification.
    case "task_classified":
    case "tier_constraints_applied":
      return {
        ...base,
        ...(evt.tier !== undefined && { tier: evt.tier }),
        ...(evt.confidence !== undefined && { confidence: evt.confidence }),
        ...(evt.estimatedFiles !== undefined && { estimatedFiles: evt.estimatedFiles }),
        ...(evt.estimatedIterations !== undefined && { estimatedIterations: evt.estimatedIterations }),
      };

    // Genuinely base-only: these carry nothing beyond runId/ts/type/title/status.
    // Membership is asserted, not assumed — see the default arm below.
    case "command_auto_approved":
    case "command_trusted":
    case "plan_generation_started":
    case "llm_retry_in_progress":
      return base;

    // Everything else reaching here is UNMAPPED, not base-only.
    //
    // The default arm used to swallow every event-specific field in silence,
    // which is the failure mode where a remote feature looks wired because
    // frames arrive, while the payload that makes them useful — a question's
    // text, an approval's id — was dropped on the way out. Same shape as
    // costFor's cache_write fallthrough: an unknown input reaching a plausible
    // default instead of an error.
    //
    // Once per type, because the alternative is a per-event flood on a hot path.
    default: {
      if (!unmappedWarned.has(evt.type)) {
        unmappedWarned.add(evt.type);
        log("[zone-wire-frame-unmapped]", JSON.stringify({
          event: "wire_frame_unmapped",
          eventType: evt.type,
          droppedFields: Object.keys(evt).filter((k) => !(k in base)).sort(),
        }));
      }
      return base;
    }
  }
}
