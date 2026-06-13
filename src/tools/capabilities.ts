/**
 * Gap 6 — Capability vocabulary for Zone's tool registry.
 *
 * 7 capabilities describe what a tool can do. CapabilityFilter is the
 * declarative form of allowedTools passed to AgentLoopInput.
 */

export type Capability =
  | "fs.read"
  | "fs.write"
  | "shell.exec"
  | "net.fetch"
  | "agent.spawn"
  | "memory.update"
  | "agent.control"
  | "mcp.call";

export const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "fs.read",
  "fs.write",
  "shell.exec",
  "net.fetch",
  "agent.spawn",
  "memory.update",
  "agent.control",
  "mcp.call",
]);

export interface CapabilityFilter {
  /**
   * A tool is granted iff every one of its capabilities is in `allow`.
   * Tools with zero capabilities are NOT granted by `allow` alone — they
   * must appear in `allowToolNames`. Omitted = no capability-level restriction.
   */
  allow?: ReadonlySet<Capability>;

  /**
   * Tools with ANY capability in `exclude` are removed. Deny wins over allow
   * at both capability and name level.
   */
  exclude?: ReadonlySet<Capability>;

  /**
   * Name-level allow. Required to grant zero-capability tools, or as an
   * escape hatch for specific tools regardless of their capability set.
   */
  allowToolNames?: ReadonlySet<string>;

  /**
   * Name-level deny (highest precedence). Replaces AgentLoopInput.excludeTools.
   */
  excludeToolNames?: ReadonlySet<string>;
}
