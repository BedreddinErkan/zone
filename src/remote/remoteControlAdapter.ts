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
} from "../api/commandApprovals.js";
import { rejectPendingRevisionsForRun } from "../llm/revisionApprovals.js";
import { ApiKeyError, ProviderRequestError } from "../llm/factory.js";

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

    resolveApproval(_msg: {
      kind: string;
      approvalId: string;
      approved: boolean;
      trust?: boolean;
    }): { ok: boolean; message?: string } {
      return { ok: false, message: "approval routing not enabled (Inc-1b-in-2)" };
    },

    abort(): void {
      const ac = currentAc;
      if (ac === null) return;
      ac.abort();
    },
  };
}
