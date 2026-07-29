import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { convertParams } from "./convertParams.js";
import { assembleAgentSystemPrompt, assembleInvestigationSystemPrompt } from "../agentLoop.js";
import { ZONE_TOOLS, INVESTIGATION_TOOLS } from "../../tools/toolDefinitions.js";
import type { ChatCompletionCreateParams } from "openai/resources/chat/completions";

const PROJECT_MEMORY =
  "## Project\nZone is a self-hosted AI coding agent: a TypeScript Node CLI with BYOK access " +
  "to OpenAI and Anthropic providers. Node 22+, npm 10+. Ink-based TUI.\n";

const investigationTools = ZONE_TOOLS.filter((t) =>
  (INVESTIGATION_TOOLS as readonly string[]).includes(t.function.name)
);

function buildParams(system: string, tools: typeof ZONE_TOOLS): ChatCompletionCreateParams {
  return {
    model: "claude-sonnet-5",
    messages: [
      { role: "system", content: system },
      { role: "user", content: "Add a helper function to src/utils/foo.ts" },
    ],
    tools,
  };
}

/**
 * The bytes Anthropic must see byte-identical, up to and including the cache
 * breakpoint, for a cache hit: the system block, and the tools array (whose
 * last element carries the ephemeral marker in the tools-present branch,
 * convertParams.ts:152-156). Serialized (not compared as raw objects) so the
 * assertions below read as a statement about what the provider matches, not
 * about incidental struct fields two unrelated functions happened to produce.
 */
function cachedPrefixOf(params: Anthropic.MessageCreateParams): { system: string; tools: string } {
  return {
    system: JSON.stringify(params.system),
    tools: JSON.stringify(params.tools),
  };
}

describe("convertParams — no prefix continuity across the plan boundary", () => {
  it("investigation and execution produce different cached prefixes, with identical messages", () => {
    // Measured on a real dogfood run: system prompt 8,118 -> 19,260 chars/call, tool
    // descriptions 4,266 -> 8,950 chars/call. Position 0 of the wire prefix (system+tools)
    // changes at the plan->execute boundary, so no downstream cache breakpoint can match no
    // matter how cleanly the conversation is carried across.
    const systemInv = assembleInvestigationSystemPrompt({
      repoPath: "/repo",
      projectMemoryBlock: PROJECT_MEMORY,
      baseMaxIterations: 6,
      commandTool: "run_command",
    });
    const systemExec = assembleAgentSystemPrompt({
      agentIntro: "You are Zone, an AI code agent.",
      frameworkLines: [],
      hasFramework: false,
      projectMemoryBlock: PROJECT_MEMORY,
      baseMaxIterations: 15,
      canRunCommand: true,
      backgroundCommandBlock: "",
      repoPath: "/repo",
      planProgressBlock: "",
      planAnnotationsBlock: "",
      summaryFormat: "compact",
    });

    const { params: invParams } = convertParams(buildParams(systemInv, investigationTools));
    const { params: execParams } = convertParams(buildParams(systemExec, ZONE_TOOLS));

    // The thing that's supposed to be safe (identical messages) really is identical —
    // proving the break below isn't hiding a difference in the conversation itself.
    expect(invParams.messages).toEqual(execParams.messages);

    // Both still get a cache breakpoint — this isn't a "caching was skipped" story, it's a
    // "caching happened, and it doesn't help" story.
    expect(invParams.tools?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(execParams.tools?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });

    // The cached prefix — the bytes that would need to match for a hit — is not the same
    // object, taken as a whole...
    const cachedPrefixInv = cachedPrefixOf(invParams);
    const cachedPrefixExec = cachedPrefixOf(execParams);
    expect(cachedPrefixInv).not.toEqual(cachedPrefixExec);

    // ...and isolated per dimension, so a future change that unifies only one of the two
    // (e.g. sharing a tool subset while system prompts still differ) is still caught.
    expect(cachedPrefixInv.system).not.toBe(cachedPrefixExec.system);
    expect(cachedPrefixInv.tools).not.toBe(cachedPrefixExec.tools);
  });
});
