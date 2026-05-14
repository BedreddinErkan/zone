import { describe, expect, it } from "vitest";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
  assembleAgentSystemPrompt,
  buildOpenAIPromptCacheKey,
  sortToolsForPromptCache,
} from "./agentLoop.js";

function makeTool(name: string): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name,
      strict: true,
      description: `Tool ${name}`,
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  };
}

describe("OpenAI prompt cache stability helpers", () => {
  it("keeps the first 5000 serialized chars byte-identical across simulated iterations", () => {
    const system = assembleAgentSystemPrompt({
      agentIntro: "You are Zone, an AI code agent.",
      frameworkLines: [
        "## Project framework",
        "- Framework: node (typescript)",
        "- Package manager: npm",
        "- Build command: npm run build",
        "- Dev command: none",
        "- Test command: npm test",
        "- Test framework: vitest",
        "- Has runnable tests: true",
        "- Test files detected: true",
      ],
      hasFramework: true,
      projectMemoryBlock: "",
      importContextSummary: "src/a.ts imports src/b.ts",
      baseMaxIterations: 15,
      canRunCommand: true,
      backgroundCommandBlock: "",
      repoPath: "/workspace/project",
    });
    const tools = sortToolsForPromptCache([
      makeTool("zeta"),
      makeTool("alpha"),
      makeTool("middle"),
    ]);
    const serialize = (iter: number) =>
      JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: "Implement the task" },
          { role: "assistant", content: `dynamic iteration ${iter}` },
          { role: "tool", tool_call_id: `call-${iter}`, content: `result ${Date.now()}` },
        ],
        tools,
      }).slice(0, 5000);

    expect(serialize(1)).toBe(serialize(2));
    expect(serialize(2)).toBe(serialize(3));
  });

  it("serializes tools deterministically by function name", () => {
    const sorted = sortToolsForPromptCache([
      makeTool("read_file"),
      makeTool("apply_patch"),
      makeTool("run_command"),
    ]);

    expect(sorted.map((tool) => tool.function.name)).toEqual([
      "apply_patch",
      "read_file",
      "run_command",
    ]);
  });

  it("includes explicit Task subagent usage discipline in the system prompt", () => {
    const system = assembleAgentSystemPrompt({
      agentIntro: "You are Zone, an AI code agent.",
      frameworkLines: [],
      hasFramework: false,
      projectMemoryBlock: "",
      baseMaxIterations: 15,
      canRunCommand: false,
      backgroundCommandBlock: "",
      repoPath: "/workspace/project",
    });

    expect(system).toContain("TASK SUBAGENTS (Task) — when to dispatch:");
    expect(system).toContain("Default is single-thread.");
    expect(system).toContain("GOOD signals (DO dispatch):");
    expect(system).toContain("BAD signals (DON'T dispatch):");
    expect(system).toContain("READ_FILE ECONOMY:");
    expect(system).toContain("VISUAL VERIFICATION (verify_visual):");
  });

  it("documents the J.4 APPLY_ROLLED_BACK marker convention", () => {
    const system = assembleAgentSystemPrompt({
      agentIntro: "You are Zone, an AI code agent.",
      frameworkLines: [],
      hasFramework: false,
      projectMemoryBlock: "",
      baseMaxIterations: 15,
      canRunCommand: false,
      backgroundCommandBlock: "",
      repoPath: "/workspace/project",
    });

    // Marker name appears, and the agent gets the four pillars of the contract:
    // (1) what the marker means, (2) where to read the restored-file scope,
    // (3) the suggestion hint convention, (4) the shell-hack prohibition.
    expect(system).toContain("APPLY_ROLLED_BACK");
    expect(system).toContain('Files restored to pre-apply state');
    expect(system).toContain('Suggested: ');
    // The shell-hack prohibition is the key dogfood-derived guidance:
    // pre-J.4 the agent escalated to sed/python/cat to defeat rollbacks.
    expect(system).toMatch(/Do NOT use shell commands.*sed.*python/);
    // Coordinated-edit retry path: apply_patch or Task subagent for ≥3 files.
    expect(system).toMatch(/Task subagent dispatch/);
  });

  it("builds a bounded per-run prompt cache key", () => {
    expect(buildOpenAIPromptCacheKey("1234567890abcdef-extra")).toBe(
      "zone-run-1234567890abcdef"
    );
    expect(buildOpenAIPromptCacheKey("")).toBeUndefined();
  });
});
