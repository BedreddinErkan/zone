/**
 * Gap 6 — Central tool registry and capability-based filter resolution.
 *
 * Tools self-declare capabilities via BUILTIN_TOOL_CAPS. Dispatchers pass a
 * CapabilityFilter; resolveToolList converts it to the concrete tool list.
 * The capability layer terminates here — executeTool still receives a flat
 * ReadonlySet<string> for backward-compat with its enforcement gate.
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Capability, CapabilityFilter } from "./capabilities.js";
import { BUILTIN_TOOL_CAPS } from "./builtinCapabilities.js";
import { ZONE_TOOLS } from "./toolDefinitions.js";

export interface RegisteredTool {
  name: string;
  capabilities: ReadonlyArray<Capability>;
  definition: ChatCompletionTool;
  /** When returns false, tool is excluded from all resolved lists. */
  isEnabled?: () => boolean;
  /** Informational bucket for telemetry/docs. Does not affect filtering. */
  category?: string;
}

const registry = new Map<string, RegisteredTool>();

export function registerTool(tool: RegisteredTool): void {
  registry.set(tool.name, tool);
}

export function getRegisteredTool(name: string): RegisteredTool | undefined {
  return registry.get(name);
}

export function listRegisteredTools(): ReadonlyArray<RegisteredTool> {
  return [...registry.values()];
}

/**
 * Resolves a CapabilityFilter to the concrete list of tools to expose to the LLM.
 *
 * Precedence (deny always beats allow):
 *   excludeToolNames > exclude (capability) > allowToolNames > allow (capability)
 *
 * Zero-capability tools (capabilities.length === 0) are only granted via allowToolNames.
 * With no filter at all (undefined), all enabled tools are returned.
 */
export function resolveToolList(filter: CapabilityFilter | undefined): RegisteredTool[] {
  const allow = filter?.allow;
  const exclude = filter?.exclude ?? new Set<Capability>();
  const allowToolNames = filter?.allowToolNames ?? new Set<string>();
  const excludeToolNames = filter?.excludeToolNames ?? new Set<string>();
  const hasAllowFilter = allow !== undefined || allowToolNames.size > 0;

  const result: RegisteredTool[] = [];
  for (const tool of registry.values()) {
    if (tool.isEnabled?.() === false) continue;

    // Name-level deny (highest precedence)
    if (excludeToolNames.has(tool.name)) continue;

    // Capability-level deny
    if (tool.capabilities.some((c) => exclude.has(c))) continue;

    // No allow filter → grant everything enabled
    if (!hasAllowFilter) {
      result.push(tool);
      continue;
    }

    // Name-level allow (escape hatch; beats capability allow)
    if (allowToolNames.has(tool.name)) {
      result.push(tool);
      continue;
    }

    // Capability-level allow
    if (allow && tool.capabilities.length > 0 && tool.capabilities.every((c) => allow.has(c))) {
      result.push(tool);
      continue;
    }

    // Zero-cap tools not in allowToolNames → excluded
  }
  return result;
}

// Populate registry at module load from ZONE_TOOLS × BUILTIN_TOOL_CAPS.
for (const definition of ZONE_TOOLS) {
  const name = (definition as { function?: { name?: string } }).function?.name;
  if (!name) continue;
  const capabilities = (BUILTIN_TOOL_CAPS[name] ?? []) as ReadonlyArray<Capability>;
  registerTool({ name, capabilities, definition: definition as ChatCompletionTool });
}
