import { describe, it, expect } from "vitest";
import { toolCallIdentifyingArg } from "./toolCallIdentifyingArg.js";
import { ZONE_TOOLS } from "../tools/toolDefinitions.js";

// Confirmed by reading agentLoop.ts's control flow: every branch for these
// three tool names ends in `continue` before reaching
// `input.onToolCall?.(name, parsedArgs)` (:4513) — TodoWrite (:4187-4230),
// ask_user (:4233-~4360), revert_patch (:~4480-4510). They never reach this
// function in a real run, so they're deliberately absent from the fixture
// table below rather than missing by oversight.
const NEVER_REACHES_ON_TOOL_CALL = new Set(["TodoWrite", "ask_user", "revert_patch"]);

// One schema-correct args fixture per tool that actually reaches onToolCall.
const FIXTURES: Record<string, Record<string, unknown>> = {
  run_command: { command: "npm test", cwd: null },
  run_command_background: { command: "npm run dev", cwd: null, label: "dev" },
  run_command_readonly: { command: "git status" },
  read_file: { filePath: "src/index.ts", lineRange: null },
  apply_patch: {
    filePath: "src/index.ts",
    patch: "--- FIND ---\nold\n--- REPLACE ---\nnew",
    intent: null,
    scope: null,
  },
  write_file: { filePath: "src/new.ts", content: "export {};" },
  list_files: { dirPath: "src", pattern: null, include_ignored: null },
  search_in_files: { pattern: "foo", fileGlob: null },
  find_references: { sourceFile: "src/index.ts", symbolName: "foo" },
  Task: { subagent_type: "explore", description: "investigate the bug" },
  suggest_scope_change: { reason: "need another file", type: "under_scope", revised_plan_summary: "add file X" },
  kill_background: { handle: "h1", signal: null },
  read_background_output: { handle: "h1", since_offset: null, max_bytes: null },
  multi_edit: { files: ["a.ts"], find: "old", replace: "new", wholeWord: null },
  list_background: {},
  update_memory: { entry: "API routes live in src/api/server.ts", reason: "not obvious from structure" },
  fetch_url: { url: "https://example.com/docs" },
};

describe("toolCallIdentifyingArg — completeness against the full ZONE_TOOLS roster", () => {
  for (const tool of ZONE_TOOLS) {
    const name = tool.function.name;
    if (NEVER_REACHES_ON_TOOL_CALL.has(name)) continue;

    it(`produces the expected arg for "${name}"`, () => {
      const fixture = FIXTURES[name];
      expect(fixture, `no fixture registered for tool "${name}" — add one`).toBeDefined();
      const result = toolCallIdentifyingArg(name, fixture!);
      if (name === "list_background") {
        // Genuinely argument-less schema — "" is the correct output, not a gap.
        expect(result).toBe("");
      } else {
        expect(result).not.toBe("");
      }
    });
  }

  it("covers every ZONE_TOOLS name exactly once, split between fixtures and the intercepted set", () => {
    const allNames = ZONE_TOOLS.map((t) => t.function.name);
    for (const name of allNames) {
      const inFixtures = name in FIXTURES;
      const intercepted = NEVER_REACHES_ON_TOOL_CALL.has(name);
      expect(inFixtures || intercepted, `"${name}" is neither fixtured nor confirmed intercepted`).toBe(true);
      expect(inFixtures && intercepted, `"${name}" is both fixtured and marked intercepted`).toBe(false);
    }
  });
});

describe("toolCallIdentifyingArg — list_files dirPath fallback", () => {
  it("falls back to '.' for an empty dirPath", () => {
    expect(toolCallIdentifyingArg("list_files", { dirPath: "", pattern: null, include_ignored: null })).toBe(".");
  });

  it("falls back to '.' when dirPath is omitted entirely", () => {
    expect(toolCallIdentifyingArg("list_files", { pattern: null, include_ignored: null })).toBe(".");
  });

  it("passes through a real dirPath unchanged", () => {
    expect(
      toolCallIdentifyingArg("list_files", { dirPath: "src/tools", pattern: null, include_ignored: null })
    ).toBe("src/tools");
  });
});

describe("toolCallIdentifyingArg — search_in_files' legitimate empty case", () => {
  it("returns empty when the model omits pattern — strict:false means the API never blocks this", () => {
    expect(toolCallIdentifyingArg("search_in_files", { fileGlob: "**/*.ts" })).toBe("");
  });
});

describe("toolCallIdentifyingArg — unrecognized tool", () => {
  it("returns empty for a tool name the switch doesn't recognize", () => {
    expect(toolCallIdentifyingArg("totally_unknown_tool", {})).toBe("");
  });
});
