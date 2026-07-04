export type RemoteMode = "normal" | "autoAccept" | "plan";

/**
 * Thin contract between the WS transport (controlServer.ts) and the agent.
 * The transport depends only on this interface — it never imports runOneShotInner,
 * ZoneStructuredProgressEvent, or any resolve* function directly.
 *
 * Inc-1b-in provides the concrete implementation; Inc-1b-out only needs the type.
 */
export interface RemoteControlBackend {
  /**
   * Start a one-shot agent run. Progress is delivered internally (e.g. via broadcast)
   * rather than via a callback — the transport never touches the raw event union.
   * Resolves when the run completes or is aborted.
   */
  startRun(task: string, opts?: { mode?: RemoteMode }): Promise<void>;

  /**
   * Settle a pending approval gate. kind identifies the approval module
   * (e.g. "command", "edit", "trust", "plan", "staged", "revision").
   * id echoes the approvalId/planId/revisionId from the outbound approval-required frame
   * (for "trust" the id is unused — the registry key is runId).
   */
  resolveApproval(msg: {
    kind: "command" | "edit" | "trust" | "plan" | "staged" | "revision";
    id: string;          // approvalId | planId | revisionId per kind; unused for trust
    approved?: boolean;  // command / edit / trust
    decision?: string;   // plan / staged / revision (validated per-kind in the adapter)
    feedback?: string;   // plan / staged
    trust?: boolean;     // command only — record in per-run prefix set
  }): { ok: boolean; message?: string };

  /** Abort the currently running task, if any. */
  abort(): void;
}
