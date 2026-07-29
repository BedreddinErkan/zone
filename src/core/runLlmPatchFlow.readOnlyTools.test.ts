import { describe, expect, it } from "vitest";
import { resolveToolList, registerTool } from "../tools/toolRegistry.js";
import type { CapabilityFilter } from "../tools/capabilities.js";
import { BUILTIN_TOOL_CAPS } from "../tools/builtinCapabilities.js";
import {
  buildDispatcherCapabilityFilter,
  QUESTION_PIPELINE,
  REFACTOR_PIPELINE,
  type PipelineConfig,
} from "../llm/archetypeDispatcher.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * A read-only run was offered `multi_edit`, `run_command` and
 * `run_command_background` — three ways to write — and denied
 * `search_in_files`, `list_files` and `find_references`.
 *
 * The write leak and the search denial are different defects. The search names
 * were written into the denylist deliberately: QUESTION runs at iterCap 3, one
 * command and one summary, and exploration is not wanted. That was coherent
 * until `investigation` inherited the same pipeline. The write tools were never
 * written anywhere — they arrived because a denylist grants what it forgets.
 *
 * These tests pin the resolved sets, and the mutations pin the property that
 * makes the fix durable: under a capability allow-set a new tool is denied by
 * default rather than granted by default.
 */

/**
 * Calls the production filter — never a copy of it. A test that re-implemented
 * this logic would keep passing while `runLlmPatchFlow` regressed, which is the
 * failure mode the mutations at the bottom exist to rule out.
 */
function readOnlyFilter(opts: { allowExploration: boolean }): CapabilityFilter {
  const cfg: PipelineConfig = { ...QUESTION_PIPELINE, allowExploration: opts.allowExploration };
  return buildDispatcherCapabilityFilter(cfg)!;
}

const names = (f: CapabilityFilter | undefined): string[] =>
  resolveToolList(f).map((t) => t.name).sort();

const QUESTION_TOOLS = names(readOnlyFilter({ allowExploration: false }));
const INVESTIGATION_TOOLS_RESOLVED = names(readOnlyFilter({ allowExploration: true }));

describe("what a read-only pipeline actually offers", () => {
  it("question gets one reader and one safe shell — its original intent, now explicit", () => {
    expect(QUESTION_TOOLS).toEqual(["read_file", "run_command_readonly"]);
  });

  it("investigation gets the search tools question deliberately denies", () => {
    expect(INVESTIGATION_TOOLS_RESOLVED).toEqual([
      "find_references",
      "list_files",
      "read_file",
      "run_command_readonly",
      "search_in_files",
    ]);
  });

  it("neither can write, by capability rather than by list", () => {
    // The three that leaked through the denylist, named explicitly so a
    // regression reads as the original bug rather than as a count change.
    for (const set of [QUESTION_TOOLS, INVESTIGATION_TOOLS_RESOLVED]) {
      expect(set).not.toContain("multi_edit");
      expect(set).not.toContain("run_command");
      expect(set).not.toContain("run_command_background");
      expect(set).not.toContain("apply_patch");
      expect(set).not.toContain("write_file");
    }
  });

  it("no tool declaring fs.write survives either filter", () => {
    // The general form of the assertion above: it holds for every tool in the
    // registry, not just the five that happen to exist today.
    for (const set of [QUESTION_TOOLS, INVESTIGATION_TOOLS_RESOLVED]) {
      for (const name of set) {
        expect(BUILTIN_TOOL_CAPS[name] ?? []).not.toContain("fs.write");
      }
    }
  });

  it("drops the background tools that cannot work without a way to start a process", () => {
    // They pass the capability rule (shell.exec) but `run_command_background`
    // declares fs.write and is denied, so they are inert. Offering them invites
    // a call whose precondition can never be met.
    for (const set of [QUESTION_TOOLS, INVESTIGATION_TOOLS_RESOLVED]) {
      expect(set).not.toContain("list_background");
      expect(set).not.toContain("read_background_output");
      expect(set).not.toContain("kill_background");
    }
  });

  it("run_command_readonly is the shell path, and it is reachable", () => {
    // Excluding unqualified run_command costs builds (`npm run build` writes
    // dist/) and nothing else: the readonly whitelist covers tests,
    // `tsc --noEmit`, lint, and read-only git.
    expect(INVESTIGATION_TOOLS_RESOLVED).toContain("run_command_readonly");
    expect(BUILTIN_TOOL_CAPS["run_command_readonly"]).not.toContain("fs.write");
    expect(BUILTIN_TOOL_CAPS["run_command"]).toContain("fs.write");
  });
});

describe("a new tool cannot reach a read-only run by being forgotten", () => {
  const stub = (name: string, capabilities: string[]): void => {
    registerTool({
      name,
      capabilities: capabilities as never,
      definition: {
        type: "function",
        function: { name, description: "test stub", parameters: { type: "object", properties: {} } },
      } as ChatCompletionTool,
    });
  };

  it("a tool declaring fs.write is denied without anyone editing a list", () => {
    // Under the old denylist this tool would have been GRANTED: it is not one
    // of the seven names that list happened to contain. That is exactly how
    // multi_edit got in.
    stub("zz_test_write_tool", ["fs.read", "fs.write"]);

    expect(names(readOnlyFilter({ allowExploration: true }))).not.toContain("zz_test_write_tool");
    expect(names(readOnlyFilter({ allowExploration: false }))).not.toContain("zz_test_write_tool");
  });

  it("a tool with no capability mapping at all is denied too", () => {
    // What a forgotten BUILTIN_TOOL_CAPS entry produces: toolRegistry registers
    // it with `[]`, and resolveToolList requires capabilities.length > 0. The
    // load-time guard in builtinCapabilities.ts should catch this first, but the
    // filter must not depend on that guard having run.
    stub("zz_test_uncapped_tool", []);

    expect(names(readOnlyFilter({ allowExploration: true }))).not.toContain("zz_test_uncapped_tool");
  });

  it("a genuinely read-only tool IS granted — the rule is not just deny-everything", () => {
    stub("zz_test_reader_tool", ["fs.read"]);

    expect(names(readOnlyFilter({ allowExploration: true }))).toContain("zz_test_reader_tool");
  });
});

describe("non-read-only pipelines are untouched", () => {
  it("still filters by name only, granting everything else", () => {
    // The change is scoped to readOnlyPipeline. A patch pipeline must keep the
    // permissive default, or every archetype loses its write tools at once.
    const filter = buildDispatcherCapabilityFilter(REFACTOR_PIPELINE);
    const resolved = names(filter);

    expect(filter?.allow).toBeUndefined();
    expect(resolved).toContain("apply_patch");
    expect(resolved).toContain("multi_edit");
    expect(resolved).toContain("run_command");
    expect(resolved).toContain("search_in_files");
  });

  it("returns undefined when a pipeline restricts nothing", () => {
    const cfg: PipelineConfig = {
      ...REFACTOR_PIPELINE,
      allowSubagentDispatch: true,
      allowScopeRevision: true,
    };
    expect(buildDispatcherCapabilityFilter(cfg)).toBeUndefined();
  });

  it("returns undefined when no pipeline applied at all", () => {
    expect(buildDispatcherCapabilityFilter(null)).toBeUndefined();
  });
});
