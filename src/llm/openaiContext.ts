import { AsyncLocalStorage } from "node:async_hooks";

interface ZoneRequestContext {
  userApiKey?: string;
}

export const zoneRequestContext = new AsyncLocalStorage<ZoneRequestContext>();

export function getRequestUserApiKey(): string | undefined {
  return zoneRequestContext.getStore()?.userApiKey;
}

export function withUserApiKey<T>(
  userApiKey: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return zoneRequestContext.run({ userApiKey }, fn);
}
