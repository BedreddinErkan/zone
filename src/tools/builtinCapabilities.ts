/**
 * Gap 6 — Single source of truth: maps every ZONE_TOOLS name to its capabilities.
 *
 * The IIFE at the bottom verifies at module load that every tool in ZONE_TOOLS
 * has an entry here — missing entries fail-fast instead of silently granting
 * zero capabilities (same pattern as DISPATCHED_TOOLS guard in toolExecutor.ts).
 */
import type { Capability } from "./capabilities.js";

export const BUILTIN_TOOL_CAPS: Record<string, ReadonlyArray<Capability>> = {
  // ── fs.read-only tools ──────────────────────────────────────────────────
  read_file:          ["fs.read"],
  list_files:         ["fs.read"],
  search_in_files:    ["fs.read"],
  find_references:    ["fs.read"],

  // ── fs.read + fs.write tools ────────────────────────────────────────────
  apply_patch:        ["fs.read", "fs.write"],
  multi_edit:         ["fs.read", "fs.write"],
  write_file:         ["fs.read", "fs.write"],

  // ── shell tools (may also read/write via shell) ──────────────────────────
  run_command:          ["fs.read", "fs.write", "shell.exec"],
  run_command_readonly: ["fs.read", "shell.exec"],
  run_command_background: ["fs.read", "fs.write", "shell.exec"],

  // ── background process management (bundled under shell.exec) ────────────
  kill_background:         ["shell.exec"],
  list_background:         ["shell.exec"],
  read_background_output:  ["shell.exec"],

  // ── subagent dispatch ────────────────────────────────────────────────────
  Task: ["agent.spawn"],

  // ── project memory ───────────────────────────────────────────────────────
  // Sandboxed to .zone/memory.md — not declared as fs.write (see design Q5).
  update_memory: ["memory.update"],

  // ── meta-tools (agent.control: talk to harness, no external I/O) ────────
  TodoWrite:            ["agent.control"],
  suggest_scope_change: ["agent.control"],
  revert_patch:         ["agent.control"],
};

// Startup guard: every ZONE_TOOLS entry must have a capability mapping.
{
  let defs: Array<{ function: { name: string } }> | undefined;
  try {
    defs = ((await import("./toolDefinitions.js")) as { ZONE_TOOLS: Array<{ function: { name: string } }> }).ZONE_TOOLS;
  } catch {
    // dist/ not built yet — skip during source-only runs
  }
  if (defs) {
    const missing: string[] = [];
    for (const tool of defs) {
      const name = tool.function?.name;
      if (name && !(name in BUILTIN_TOOL_CAPS)) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `[builtinCapabilities] Missing capability mapping for tool(s): ${missing.join(", ")}. ` +
        `Add an entry to BUILTIN_TOOL_CAPS in src/tools/builtinCapabilities.ts.`
      );
    }
  }
}
