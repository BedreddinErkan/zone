/**
 * Gap 6 — Capability vocabulary for Zone's tool registry.
 *
 * 7 capabilities describe what a tool can do. CapabilityFilter is the
 * declarative form of allowedTools passed to AgentLoopInput.
 *
 * NAMING HAZARD, and this pointer is here because a grep for "capabilities" lands on one of these
 * two modules at random. THIS file is about what a TOOL may do — fs.read, fs.write, shell.exec.
 * `ModelCapabilities` in `src/llm/types.ts` is about what a MODEL supports — context window, output
 * ceiling, effort ladder — and is carried by `ProfileCapabilities` in `src/llm/providerProfile.ts`.
 * Same English word, unrelated concepts; the two never appear in the same expression. Ledger 393.
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

/**
 * What "read-only" means as capabilities, for pipelines that must not write.
 *
 * Derived rather than enumerated, and that is the point. `resolveToolList`
 * grants a tool iff EVERY one of its capabilities is in `allow`, so a tool that
 * declares `fs.write` — today's `apply_patch`, `multi_edit`, `write_file`,
 * `run_command`, `run_command_background`, or anything added tomorrow — is
 * denied without anyone remembering to add it to a list. A tool missing from
 * `BUILTIN_TOOL_CAPS` resolves to zero capabilities and is denied too.
 *
 * This replaced a name denylist that had the opposite failure direction: it
 * granted whatever it forgot, which is how `multi_edit` reached a read-only run.
 *
 * `shell.exec` is included so `run_command_readonly` is reachable — its
 * whitelist covers tests, `tsc --noEmit`, lint and read-only git. Unqualified
 * `run_command` declares `fs.write` and is therefore excluded, which is the
 * distinction `run_command_readonly` exists to make.
 */
export const READ_ONLY_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "fs.read",
  "shell.exec",
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
