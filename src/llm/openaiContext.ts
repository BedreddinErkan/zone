import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMProvider } from "./types.js";

export interface ZoneRequestContext {
  userApiKey?: string;
  provider?: LLMProvider;
  model?: string;
  modelOverride?: { high?: string; standard?: string };
}

export const zoneRequestContext = new AsyncLocalStorage<ZoneRequestContext>();

export function getRequestUserApiKey(): string | undefined {
  return zoneRequestContext.getStore()?.userApiKey;
}

export function getRequestContext(): ZoneRequestContext | undefined {
  return zoneRequestContext.getStore();
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
