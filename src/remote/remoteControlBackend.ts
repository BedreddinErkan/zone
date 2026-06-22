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
   * approvalId is echoed from the outbound approval-required frame.
   */
  resolveApproval(msg: {
    kind: string;
    approvalId: string;
    approved: boolean;
    trust?: boolean;
  }): { ok: boolean; message?: string };

  /** Abort the currently running task, if any. */
  abort(): void;
}
