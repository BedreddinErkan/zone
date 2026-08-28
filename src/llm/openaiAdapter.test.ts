import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
  assembleAgentSystemPrompt,
  buildOpenAIPromptCacheKey,
  sortToolsForPromptCache,
} from "./agentLoop.js";

// ─── Adapter completion-parity tests ─────────────────────────────────────────
// Regression guard for the HTTP 400 "unsupported_parameter" bug:
// Some OpenAI models reject `max_tokens`; the adapter translates it to
// `max_completion_tokens` before hitting the SDK — on BOTH sync and stream.

const sdkCreateMock = vi.fn();
vi.mock("openai", () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: sdkCreateMock } };
  },
}));
vi.mock("./withExponentialBackoff.js", () => ({
  withExponentialBackoff: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock("./modelRegistry.js", () => ({
  supportsEffort: vi.fn().mockReturnValue(false),
  resolveEffortForModel: vi.fn().mockReturnValue(undefined),
  normalizeModelId: vi.fn((id: string) => id),
}));

import { OpenAIAdapter } from "./openaiAdapter.js";

const FAKE_COMPLETION = {
  id: "chatcmpl-test", model: "gpt-4o",
  choices: [{ message: { content: "hi", tool_calls: null }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};
const FAKE_STREAM: AsyncIterable<unknown> = {
  [Symbol.asyncIterator]: async function* () {
    yield { choices: [], model: "gpt-5.4", usage: null };
  },
};

describe("OpenAIAdapter — normalizeTokenParam (sync path)", () => {
  beforeEach(() => { sdkCreateMock.mockReset(); });

  it("max_tokens → max_completion_tokens when max_completion_tokens absent", async () => {
    sdkCreateMock.mockResolvedValueOnce(FAKE_COMPLETION);
    await new OpenAIAdapter("sk-test").createChatCompletion({
      model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_tokens: 16384,
    });
    const [p] = sdkCreateMock.mock.calls[0] as [Record<string, unknown>];
    expect(p["max_completion_tokens"]).toBe(16384);
    expect("max_tokens" in p).toBe(false);
  });

  it("max_completion_tokens already set → passes through, no duplication", async () => {
    sdkCreateMock.mockResolvedValueOnce(FAKE_COMPLETION);
    await new OpenAIAdapter("sk-test").createChatCompletion({
      model: "gpt-4o", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 512,
    });
    const [p] = sdkCreateMock.mock.calls[0] as [Record<string, unknown>];
    expect(p["max_completion_tokens"]).toBe(512);
    expect("max_tokens" in p).toBe(false);
  });

  it("no token param → passes through without adding either field", async () => {
    sdkCreateMock.mockResolvedValueOnce(FAKE_COMPLETION);
    await new OpenAIAdapter("sk-test").createChatCompletion({
      model: "gpt-4o", messages: [{ role: "user", content: "hi" }],
    });
    const [p] = sdkCreateMock.mock.calls[0] as [Record<string, unknown>];
    expect("max_tokens" in p).toBe(false);
    expect("max_completion_tokens" in p).toBe(false);
  });
});

// Diagnosability marker for the gateway-live-defects investigation: on this path (an
// OpenAI-compatible gateway using the plain, non-gpt-5 route), there is no streaming and no
// progress callback — this marker is the only signal, before this pass, that a request was ever
// issued at all.
describe("OpenAIAdapter — [zone-openai-request-issued] diagnosability marker", () => {
  it("fires before the SDK call, carrying model/hasTools/provider", async () => {
    const logSpy = vi.fn();
    vi.doMock("../utils/logger.js", () => ({ log: logSpy, debugLog: vi.fn() }));
    vi.resetModules();
    const { OpenAIAdapter: FreshAdapter } = await import("./openaiAdapter.js");

    sdkCreateMock.mockResolvedValueOnce(FAKE_COMPLETION);
    await new FreshAdapter("sk-test").createChatCompletion({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file", parameters: {} } }] as ChatCompletionTool[],
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [marker, payload] = logSpy.mock.calls[0] as [string, string];
    expect(marker).toBe("[zone-openai-request-issued]");
    expect(JSON.parse(payload)).toEqual({
      runId: null,
      model: "gpt-4o",
      hasTools: true,
      provider: "openai",
    });
    // Fired strictly before the SDK call — otherwise a hang inside the SDK call would leave no
    // trace that the request was ever attempted, which is the exact gap this marker exists to close.
    const logOrder = logSpy.mock.invocationCallOrder[0]!;
    const sdkOrder = sdkCreateMock.mock.invocationCallOrder[0]!;
    expect(logOrder).toBeLessThan(sdkOrder);

    vi.doUnmock("../utils/logger.js");
    vi.resetModules();
  });

  it("hasTools is false when no tools are offered", async () => {
    const logSpy = vi.fn();
    vi.doMock("../utils/logger.js", () => ({ log: logSpy, debugLog: vi.fn() }));
    vi.resetModules();
    const { OpenAIAdapter: FreshAdapter } = await import("./openaiAdapter.js");

    sdkCreateMock.mockResolvedValueOnce(FAKE_COMPLETION);
    await new FreshAdapter("sk-test").createChatCompletion({
      model: "gpt-4o", messages: [{ role: "user", content: "hi" }],
    });

    const [, payload] = logSpy.mock.calls[0] as [string, string];
    expect(JSON.parse(payload).hasTools).toBe(false);

    vi.doUnmock("../utils/logger.js");
    vi.resetModules();
  });
});

describe("OpenAIAdapter — normalizeTokenParam (stream path)", () => {
  beforeEach(() => { sdkCreateMock.mockReset(); });

  it("max_tokens → max_completion_tokens on the streaming path", async () => {
    sdkCreateMock.mockResolvedValueOnce(FAKE_STREAM);
    await new OpenAIAdapter("sk-test").createChatCompletionStream({
      model: "gpt-4o", messages: [{ role: "user", content: "hi" }],
      stream: true, max_tokens: 8192,
    });
    const [p] = sdkCreateMock.mock.calls[0] as [Record<string, unknown>];
    expect(p["max_completion_tokens"]).toBe(8192);
    expect("max_tokens" in p).toBe(false);
  });

  it("streaming: max_completion_tokens already set → passes through unchanged", async () => {
    sdkCreateMock.mockResolvedValueOnce(FAKE_STREAM);
    await new OpenAIAdapter("sk-test").createChatCompletionStream({
      model: "gpt-4o", messages: [{ role: "user", content: "hi" }],
      stream: true, max_completion_tokens: 256,
    });
    const [p] = sdkCreateMock.mock.calls[0] as [Record<string, unknown>];
    expect(p["max_completion_tokens"]).toBe(256);
    expect("max_tokens" in p).toBe(false);
  });
});

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

    expect(system).toContain("TASK SUBAGENTS");
    expect(system).toContain("GOOD signals");
    expect(system).toContain("BAD signals");
    expect(system).toContain("READ_FILE ECONOMY:");
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
    expect(system).toMatch(/Do NOT use shell commands/);
    // Coordinated-edit retry path: apply_patch or Task for ≥3-file edits.
    expect(system).toMatch(/apply_patch or Task/);
  });

  it("builds a bounded per-run prompt cache key", () => {
    expect(buildOpenAIPromptCacheKey("1234567890abcdef-extra")).toBe(
      "zone-run-1234567890abcdef"
    );
    expect(buildOpenAIPromptCacheKey("")).toBeUndefined();
  });

  it("prefers conversationId over runId when provided (Phase X.0 C3)", () => {
    expect(buildOpenAIPromptCacheKey("run-ignored", "AAAAAAAAAAAAAAAA")).toBe(
      "zone-thread-AAAAAAAAAAAAAAAA"
    );
    expect(buildOpenAIPromptCacheKey("run-ignored", "BBBBBBBBBBBBBBBB-extra")).toBe(
      "zone-thread-BBBBBBBBBBBBBBBB"
    );
  });

  it("falls back to runId when conversationId is empty or missing", () => {
    expect(buildOpenAIPromptCacheKey("run-abc", "")).toBe("zone-run-run-abc");
    expect(buildOpenAIPromptCacheKey("run-abc", undefined)).toBe("zone-run-run-abc");
  });
});

describe("OpenAIAdapter — provider constructor default (gateway-support-investigation.md §2.4 site 8; characterization, not endorsement)", () => {
  it("constructing with apiKey only (no baseUrl, no provider) defaults .provider to \"openai\"", () => {
    const adapter = new OpenAIAdapter("sk-test");
    expect(adapter.provider).toBe("openai");
  });
});
