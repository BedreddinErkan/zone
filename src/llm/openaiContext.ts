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
  /** Reserved for subagent attribution in follow-up PRs. */
  subagentId?: string;
  subagentType?: "worker" | "explore" | "verifier";
  parentRunId?: string;
}

export const zoneRequestContext = new AsyncLocalStorage<ZoneRequestContext>();

export function getRequestUserApiKey(): string | undefined {
  return zoneRequestContext.getStore()?.userApiKey;
}

export function getRequestContext(): ZoneRequestContext | undefined {
  return zoneRequestContext.getStore();
}

export function attachRunIdentity(input: { userId?: string; runId?: string }): void {
  // Deprecated legacy helper. New code should use withRequestContext(...) so
  // context changes are scoped to the callback instead of mutating the current
  // AsyncLocalStorage store in place. Kept for existing route/flow callers.
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
  return withRequestContext({ userApiKey }, fn);
}

/**
 * Runs `fn` with the given context fields shallow-merged into the current
 * AsyncLocalStorage store. The previous store is restored automatically when
 * `fn` resolves or rejects.
 */
export function withRequestContext<T>(
  patch: Partial<ZoneRequestContext>,
  fn: () => Promise<T>,
): Promise<T> {
  const current = getRequestContext() ?? {};
  const next: ZoneRequestContext = { ...current, ...patch };
  return zoneRequestContext.run(next, fn);
}
