/**
 * Gap 6 — Capability registry unit tests.
 * TDD: these were written before implementation (RED phase).
 *
 * Each test verifies resolveToolList output matches the byte-identical set that
 * the current allowedTools constants produce, so migration is provably safe.
 */
import { describe, expect, it } from "vitest";
import type { Capability, CapabilityFilter } from "./capabilities.js";
import { resolveToolList } from "./toolRegistry.js";
import { allowedToolsToFilter } from "./capabilityCompat.js";
import { BUILTIN_TOOL_CAPS } from "./builtinCapabilities.js";
import { ZONE_TOOLS } from "./toolDefinitions.js";
import {
  EXPLORE_ALLOWED_TOOLS,
  AUDIT_ALLOWED_TOOLS,
  WORKER_ALLOWED_TOOLS,
} from "../llm/subagents.js";
import { READ_ONLY_TOOLS, CHAT_TOOLS } from "./toolDefinitions.js";

function names(tools: { name: string }[]): Set<string> {
  return new Set(tools.map((t) => t.name));
}

describe("resolveToolList", () => {
  it("T1: undefined filter returns all 18 registered tools", () => {
    const result = resolveToolList(undefined);
    expect(result).toHaveLength(18);
  });

  it("T2: {allow: fs.read} returns exactly READ_ONLY_TOOLS", () => {
    const filter: CapabilityFilter = { allow: new Set<Capability>(["fs.read"]) };
    const result = names(resolveToolList(filter));
    expect(result).toEqual(new Set(READ_ONLY_TOOLS));
  });

  it("T3: allowToolNames=EXPLORE_ALLOWED_TOOLS returns exactly those tools", () => {
    const filter = allowedToolsToFilter(EXPLORE_ALLOWED_TOOLS);
    const result = names(resolveToolList(filter));
    expect(result).toEqual(new Set([...EXPLORE_ALLOWED_TOOLS]));
  });

  it("T4: allowToolNames=AUDIT_ALLOWED_TOOLS returns exactly those tools", () => {
    const filter = allowedToolsToFilter(AUDIT_ALLOWED_TOOLS);
    const result = names(resolveToolList(filter));
    expect(result).toEqual(new Set([...AUDIT_ALLOWED_TOOLS]));
  });

  it("T5: allowToolNames=WORKER_ALLOWED_TOOLS returns exactly those tools", () => {
    const filter = allowedToolsToFilter(WORKER_ALLOWED_TOOLS);
    const result = names(resolveToolList(filter));
    expect(result).toEqual(new Set([...WORKER_ALLOWED_TOOLS]));
  });

  it("T6: allowToolNames=CHAT_TOOLS returns exactly those tools", () => {
    const filter = allowedToolsToFilter(new Set(CHAT_TOOLS));
    const result = names(resolveToolList(filter));
    expect(result).toEqual(new Set(CHAT_TOOLS));
  });

  it("T7: excludeToolNames wins over allowToolNames", () => {
    const filter: CapabilityFilter = {
      allowToolNames: new Set(["read_file", "write_file"]),
      excludeToolNames: new Set(["write_file"]),
    };
    const result = names(resolveToolList(filter));
    expect(result).toEqual(new Set(["read_file"]));
  });

  it("T8: exclude capability wins over allow capability (deny always wins)", () => {
    const filter: CapabilityFilter = {
      allow: new Set<Capability>(["fs.read"]),
      exclude: new Set<Capability>(["fs.read"]),
    };
    const result = resolveToolList(filter);
    expect(result).toHaveLength(0);
  });

  it("T9: {allow: fs.read, fs.write} grants multi-cap tools but not shell-only tools", () => {
    const filter: CapabilityFilter = {
      allow: new Set<Capability>(["fs.read", "fs.write"]),
    };
    const result = names(resolveToolList(filter));
    // apply_patch and write_file need fs.read + fs.write — granted
    expect(result.has("apply_patch")).toBe(true);
    expect(result.has("write_file")).toBe(true);
    // find_references needs only fs.read — granted (subset of allow is fine)
    expect(result.has("find_references")).toBe(true);
    // run_command needs fs.read + fs.write + shell.exec — NOT granted (shell.exec not in allow)
    expect(result.has("run_command")).toBe(false);
    // run_command_readonly needs fs.read + shell.exec — NOT granted
    expect(result.has("run_command_readonly")).toBe(false);
    // Task needs agent.spawn — NOT granted
    expect(result.has("Task")).toBe(false);
    // update_memory needs memory.update — NOT granted
    expect(result.has("update_memory")).toBe(false);
  });

  it("T10: agent.control capability grants TodoWrite, suggest_scope_change, revert_patch", () => {
    const filter: CapabilityFilter = { allow: new Set<Capability>(["agent.control"]) };
    const result = names(resolveToolList(filter));
    expect(result.has("TodoWrite")).toBe(true);
    expect(result.has("suggest_scope_change")).toBe(true);
    expect(result.has("revert_patch")).toBe(true);
    // fs.read tools not granted
    expect(result.has("read_file")).toBe(false);
  });

  it("T11: allowToolNames escape hatch grants named tool even without matching capability", () => {
    // run_command_readonly requires shell.exec, but named escape hatch overrides
    const filter: CapabilityFilter = {
      allow: new Set<Capability>(["fs.read"]),
      allowToolNames: new Set(["run_command_readonly"]),
    };
    const result = names(resolveToolList(filter));
    expect(result.has("run_command_readonly")).toBe(true);
    expect(result.has("read_file")).toBe(true);
  });

  it("T12: excludeToolNames beats allowToolNames for same tool", () => {
    const filter: CapabilityFilter = {
      allowToolNames: new Set(["read_file", "run_command_readonly"]),
      excludeToolNames: new Set(["run_command_readonly"]),
    };
    const result = names(resolveToolList(filter));
    expect(result.has("read_file")).toBe(true);
    expect(result.has("run_command_readonly")).toBe(false);
  });
});

describe("BUILTIN_TOOL_CAPS coverage guard", () => {
  it("T10: every ZONE_TOOLS entry has a capability mapping", () => {
    const missing: string[] = [];
    for (const tool of ZONE_TOOLS) {
      const name = tool.function?.name;
      if (!(name in BUILTIN_TOOL_CAPS)) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every BUILTIN_TOOL_CAPS entry references a known ZONE_TOOLS name", () => {
    const knownNames = new Set(ZONE_TOOLS.map((t) => t.function?.name));
    const extra = Object.keys(BUILTIN_TOOL_CAPS).filter((n) => !knownNames.has(n));
    expect(extra).toEqual([]);
  });
});

describe("allowedToolsToFilter (capabilityCompat)", () => {
  it("wraps a set as allowToolNames", () => {
    const set = new Set(["read_file", "write_file"]);
    const filter = allowedToolsToFilter(set);
    expect(filter.allowToolNames).toBe(set);
    expect(filter.allow).toBeUndefined();
    expect(filter.exclude).toBeUndefined();
    expect(filter.excludeToolNames).toBeUndefined();
  });
});
