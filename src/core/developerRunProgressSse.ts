import type { Response } from "express";
import type { AgentLifecycleEvent, ZoneStructuredProgressEvent } from "./agentLifecycleEvents.js";

export type DeveloperPatchProgressPayload = {
  stage: string;
  lifecycle?: AgentLifecycleEvent;
  progress?: ZoneStructuredProgressEvent;
};

const progressStreams = new Map<string, Set<Response>>();

export function attachDeveloperPatchProgressSseClient(
  runId: string,
  res: Response
): void {
  const listeners = progressStreams.get(runId) ?? new Set<Response>();
  listeners.add(res);
  progressStreams.set(runId, listeners);
}

export function detachDeveloperPatchProgressSseClient(
  runId: string,
  res: Response
): void {
  const current = progressStreams.get(runId);
  if (!current) return;
  current.delete(res);
  if (current.size === 0) {
    progressStreams.delete(runId);
  }
}

export function emitDeveloperPatchProgress(
  runId: string | undefined,
  payload: DeveloperPatchProgressPayload
): void {
  if (!runId) return;
  const listeners = progressStreams.get(runId);
  if (!listeners) return;
  const body = JSON.stringify(payload);
  const sse = `data: ${body}\n\n`;
  for (const client of listeners) {
    try {
      client.write(sse);
    } catch {
      // best-effort SSE
    }
  }
}
