import type { Response } from "express";
import type { AgentLifecycleEvent, ZoneStructuredProgressEvent } from "./agentLifecycleEvents.js";

export type DeveloperPatchProgressPayload = {
  stage: string;
  lifecycle?: AgentLifecycleEvent;
  progress?: ZoneStructuredProgressEvent;
};

const progressStreams = new Map<string, Set<Response>>();

export type RunEventBuffer = {
  runId: string;
  startedAt: number;
  completedAt?: number;
  status: "running" | "completed" | "cancelled";
  task?: string;
  events: Array<{ ts: number; payload: DeveloperPatchProgressPayload }>;
  maxEvents: number;
};

const runBuffers = new Map<string, RunEventBuffer>();
const COMPLETED_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_EVENTS = 5000;

function cleanupExpiredBuffers(now = Date.now()): void {
  for (const [runId, buf] of runBuffers.entries()) {
    if ((buf.status === "completed" || buf.status === "cancelled") && buf.completedAt) {
      if (now - buf.completedAt > COMPLETED_TTL_MS) {
        runBuffers.delete(runId);
      }
    }
  }
}

export function registerRunStart(runId: string, input?: { task?: string }): void {
  const rid = String(runId || "").trim();
  if (!rid) return;
  cleanupExpiredBuffers();
  const existing = runBuffers.get(rid);
  if (existing && existing.status === "running") {
    if (input?.task && !existing.task) existing.task = input.task;
    return;
  }
  runBuffers.set(rid, {
    runId: rid,
    startedAt: Date.now(),
    status: "running",
    task: input?.task,
    events: [],
    maxEvents: DEFAULT_MAX_EVENTS,
  });
}

export function registerRunComplete(
  runId: string,
  status: "completed" | "cancelled"
): void {
  const rid = String(runId || "").trim();
  if (!rid) return;
  cleanupExpiredBuffers();
  const buf = runBuffers.get(rid);
  const now = Date.now();
  if (buf) {
    buf.status = status;
    buf.completedAt = now;
    return;
  }
  runBuffers.set(rid, {
    runId: rid,
    startedAt: now,
    completedAt: now,
    status,
    events: [],
    maxEvents: DEFAULT_MAX_EVENTS,
  });
}

export function getRunBuffer(runId: string): RunEventBuffer | null {
  const rid = String(runId || "").trim();
  if (!rid) return null;
  cleanupExpiredBuffers();
  return runBuffers.get(rid) ?? null;
}

function pushRunEvent(runId: string, payload: DeveloperPatchProgressPayload): void {
  const rid = String(runId || "").trim();
  if (!rid) return;
  cleanupExpiredBuffers();
  let buf = runBuffers.get(rid);
  if (!buf) {
    buf = {
      runId: rid,
      startedAt: Date.now(),
      status: "running",
      events: [],
      maxEvents: DEFAULT_MAX_EVENTS,
    };
    runBuffers.set(rid, buf);
  }
  buf.events.push({ ts: Date.now(), payload });
  if (buf.events.length > buf.maxEvents) {
    buf.events.splice(0, buf.events.length - buf.maxEvents);
  }
}

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
  pushRunEvent(runId, payload);
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

/** End all SSE connections for a run (e.g. user cancel). */
export function closeDeveloperPatchProgressSseForRun(runId: string): void {
  const listeners = progressStreams.get(runId);
  if (!listeners) return;
  for (const client of listeners) {
    try {
      client.end();
    } catch {
      // ignore
    }
  }
  progressStreams.delete(runId);
}
