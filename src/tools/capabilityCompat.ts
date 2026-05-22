/**
 * Gap 6 — Backward-compat shim: translates legacy allowedTools set to CapabilityFilter.
 *
 * Use during migration from allowedTools→capabilityFilter at call sites.
 * Once all spawn sites are migrated, this file can be deleted.
 */
import type { CapabilityFilter } from "./capabilities.js";

export function allowedToolsToFilter(allowedTools: ReadonlySet<string>): CapabilityFilter {
  return { allowToolNames: allowedTools };
}
