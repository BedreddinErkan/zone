import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMProvider } from "./types.js";

export interface ZoneRequestContext {
  userApiKey?: string;
  provider?: LLMProvider;
  model?: string;
  modelOverride?: { high?: string; standard?: string };
  // Set after route handlers parse runId/userId from the request body.
  // Read by the recording LLM client wrapper to attribute usage records.
  userId?: string;
  runId?: string;
}

export const zoneRequestContext = new AsyncLocalStorage<ZoneRequestContext>();

export function getRequestUserApiKey(): string | undefined {
  return zoneRequestContext.getStore()?.userApiKey;
}

export function getRequestContext(): ZoneRequestContext | undefined {
  return zoneRequestContext.getStore();
}

export function attachRunIdentity(input: { userId?: string; runId?: string }): void {
  const store = zoneRequestContext.getStore();
  if (!store) return;
  if (typeof input.userId === "string" && input.userId.trim()) {
    store.userId = input.userId.trim();
  }
  if (typeof input.runId === "string" && input.runId.trim()) {
    store.runId = input.runId.trim();
  }
}

export function withUserApiKey<T>(
  userApiKey: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return zoneRequestContext.run({ userApiKey }, fn);
}

export function withRequestContext<T>(
  ctx: ZoneRequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  return zoneRequestContext.run(ctx, fn);
}
