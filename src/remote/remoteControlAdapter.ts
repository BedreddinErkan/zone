import { randomUUID } from "node:crypto";
import { runOneShotInner } from "../cli/dispatch.js";
import type { LlmPatchProgressUpdate } from "../core/agentLifecycleEvents.js";
import type { CliConfig } from "../cli/config.js";
import { toWireFrame } from "./toWireFrame.js";
import type { RemoteControlFrame } from "./controlServer.js";
import type { RemoteControlBackend, RemoteMode } from "./remoteControlBackend.js";
import {
  setTrustAllForRun,
  clearTrustedCommandsForRun,
  rejectPendingApprovalsForRun,
  resolveCommandApproval,
} from "../api/commandApprovals.js";
import { resolveEditApproval } from "../api/editApprovals.js";
import { resolveTrustApproval } from "../api/trustApprovals.js";
import { resolvePlanApproval } from "../llm/planApprovals.js";
import type { PlanDecision } from "../llm/planApprovals.js";
import { resolveStagedApproval } from "../api/stagedApprovals.js";
import type { StagedDecision } from "../api/stagedApprovals.js";
import { rejectPendingRevisionsForRun, resolveRevisionApproval } from "../llm/revisionApprovals.js";
import type { RevisionDecision } from "../llm/revisionApprovals.js";
import { ApiKeyError, ProviderRequestError } from "../llm/factory.js";

const VALID_KINDS = new Set(["command", "edit", "trust", "plan", "staged", "revision"]);

const VALID_PLAN_DECISIONS = new Set<string>([
  "accept_all", "manual", "refine", "feedback", "approve_with_feedback", "reject",
]);
const VALID_STAGED_DECISIONS = new Set<string>([
  "approve_all", "manual", "refine", "reject",
]);
const VALID_REVISION_DECISIONS = new Set<string>([
  "approve", "reject", "auto_apply",
]);

export function createRemoteControlAdapter(adapterOpts: {
  config: CliConfig;
  broadcast: (frame: RemoteControlFrame) => void;
  runOneShot?: typeof runOneShotInner;
}): RemoteControlBackend {
  const { config, broadcast, runOneShot = runOneShotInner } = adapterOpts;
  let currentRunId: string | null = null;
  let currentAc: AbortController | null = null;

  return {
    async startRun(task: string, runOpts?: { mode?: RemoteMode }): Promise<void> {
      if (currentAc !== null) {
        broadcast({ type: "error", reason: "run_already_active", ts: Date.now() });
        return;
      }

      const mode: RemoteMode = runOpts?.mode ?? "autoAccept";
      const runId = randomUUID();
      const ownedAc = new AbortController();
      currentRunId = runId;
      currentAc = ownedAc;

      if (mode === "autoAccept") {
        setTrustAllForRun(runId);
      }

      const onProgress = (update: LlmPatchProgressUpdate): void => {
        if (typeof update === "string") return;
        const evt = update.progress;
        if (!evt) return;
        const frame = toWireFrame(evt);
        if (frame) broadcast(frame);
      };

      try {
        const result = await runOneShot(task, config, runId, {
          externalAc: ownedAc,
          onProgress,
          mode,
        });
        if (!result.ok) {
          broadcast({ type: "error", reason: result.reason, runId, ts: Date.now() });
        }
      } catch (err) {
        if (!ownedAc.signal.aborted) {
          if (err instanceof ApiKeyError) {
            broadcast({ type: "run_failed", errorKind: "other", runId, ts: Date.now() });
          } else if (err instanceof ProviderRequestError) {
            broadcast({
              type: "run_failed",
              userMessage: err.userMessage,
              errorKind: err.kind,
              runId,
              ts: Date.now(),
            });
          } else {
            broadcast({ type: "run_failed", errorKind: "other", runId, ts: Date.now() });
          }
        }
      } finally {
        clearTrustedCommandsForRun(runId);
        rejectPendingApprovalsForRun(runId);
        rejectPendingRevisionsForRun(runId);
        currentRunId = null;
        currentAc = null;
      }
    },

    resolveApproval(msg: {
      kind: "command" | "edit" | "trust" | "plan" | "staged" | "revision";
      id: string;
      approved?: boolean;
      decision?: string;
      feedback?: string;
      trust?: boolean;
    }): { ok: boolean; message?: string } {
      // 1. Require an active run — runId is always currentRunId, never from the wire.
      const runId = currentRunId;
      if (!runId) return { ok: false, message: "no_active_run" };

      // 2. Validate kind before id (trust carve-out requires kind to be known first).
      const { kind } = msg;
      if (!VALID_KINDS.has(kind)) return { ok: false, message: "unknown_kind" };

      // 3. Validate id (trust uses runId as its registry key; id is unused).
      const id = msg.id;
      if (kind !== "trust" && (typeof id !== "string" || !id)) {
        return { ok: false, message: "invalid_id" };
      }

      // 4. Validate approved / decision per kind.
      if (kind === "command" || kind === "edit" || kind === "trust") {
        if (typeof msg.approved !== "boolean") return { ok: false, message: "invalid_approved" };
      } else if (kind === "plan") {
        if (!msg.decision || !VALID_PLAN_DECISIONS.has(msg.decision)) {
          return { ok: false, message: "invalid_decision" };
        }
      } else if (kind === "staged") {
        if (!msg.decision || !VALID_STAGED_DECISIONS.has(msg.decision)) {
          return { ok: false, message: "invalid_decision" };
        }
      } else if (kind === "revision") {
        if (!msg.decision || !VALID_REVISION_DECISIONS.has(msg.decision)) {
          return { ok: false, message: "invalid_decision" };
        }
      }

      // 5. Dispatch to the appropriate resolver.
      try {
        switch (kind) {
          case "command":
            return resolveCommandApproval({
              approvalId: id,
              runId,
              approved: msg.approved!,
              trust: msg.trust,
            });

          case "edit":
            return resolveEditApproval({
              approvalId: id,
              runId,
              approved: msg.approved!,
            });

          case "trust": {
            // resolveTrustApproval(runId, ok) is positional; normalize return defensively.
            const r = resolveTrustApproval(runId, msg.approved!);
            return r && typeof r === "object" && "ok" in r ? r : { ok: true };
          }

          case "plan":
            return resolvePlanApproval({
              planId: id,
              runId,
              decision: msg.decision as PlanDecision,
              feedback: msg.feedback,
            });

          case "staged":
            return resolveStagedApproval({
              approvalId: id,
              runId,
              decision: msg.decision as StagedDecision,
              feedback: msg.feedback,
            });

          case "revision":
            return resolveRevisionApproval({
              revisionId: id,
              runId,
              decision: msg.decision as RevisionDecision,
            });
        }
      } catch (err) {
        return { ok: false, message: String(err) };
      }
    },

    abort(): void {
      const ac = currentAc;
      if (ac === null) return;
      ac.abort();
    },
  };
}
