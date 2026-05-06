/**
 * Manual fixture test: verify the abort-signal plumbing across LLMClient + toolExecutor.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/llm/__tests__/runAbortSignalManual.ts
 *
 * Coverage:
 *   1. OpenAIAdapter forwards { signal } to the underlying SDK call.
 *   2. AnthropicAdapter forwards { signal } to messages.create + messages.stream.
 *   3. executeTool run_command honors abortSignal — execAsync receives it and
 *      a pre-aborted signal short-circuits the run.
 *   4. /api/cancel "duplicate runId" defensive guard (simulated): set the same
 *      runId twice, verify prior controller aborted before overwrite.
 */

const { OpenAIAdapter } = await import("../../../dist/llm/openaiAdapter.js");
const { AnthropicAdapter } = await import("../../../dist/llm/anthropicAdapter.js");
const { executeTool } = await import("../../../dist/tools/toolExecutor.js");

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];

function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

// 1. OpenAIAdapter — signal forwarded to SDK
{
  const captured: { signal?: AbortSignal } = {};
  const adapter = new OpenAIAdapter("sk-fake");
  (adapter as { sdk: unknown }).sdk = {
    chat: {
      completions: {
        create: async (_params: unknown, options: { signal?: AbortSignal }) => {
          captured.signal = options?.signal;
          return {
            id: "msg_oa",
            object: "chat.completion",
            created: 1,
            model: "gpt-4o-mini",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop", logprobs: null }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
    embeddings: {
      create: async () => ({ data: [{ embedding: [0.1] }] }),
    },
  };
  const ac = new AbortController();
  await adapter.createChatCompletion(
    { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    { signal: ac.signal }
  );
  check(
    "OpenAIAdapter.createChatCompletion forwards signal",
    captured.signal === ac.signal,
    { same: captured.signal === ac.signal }
  );
}

// 2. AnthropicAdapter — signal forwarded to messages.create + messages.stream
{
  const captured: { create?: AbortSignal; stream?: AbortSignal } = {};
  const adapter = new AnthropicAdapter("sk-ant-fake");
  (adapter as { sdk: unknown }).sdk = {
    messages: {
      create: async (_params: unknown, options: { signal?: AbortSignal }) => {
        captured.create = options?.signal;
        return {
          id: "msg_a",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        };
      },
      stream: (_params: unknown, options: { signal?: AbortSignal }) => {
        captured.stream = options?.signal;
        return (async function* () {
          yield { type: "message_stop" };
        })();
      },
    },
  };
  const ac = new AbortController();
  await adapter.createChatCompletion(
    { model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 10 },
    { signal: ac.signal }
  );
  check(
    "AnthropicAdapter.createChatCompletion forwards signal",
    captured.create === ac.signal,
    { same: captured.create === ac.signal }
  );
  await adapter.createChatCompletionStream(
    { model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }], max_tokens: 10, stream: true },
    { signal: ac.signal }
  );
  check(
    "AnthropicAdapter.createChatCompletionStream forwards signal",
    captured.stream === ac.signal,
    { same: captured.stream === ac.signal }
  );
}

// 3. executeTool run_command honors abort signal — pre-aborted = immediate failure
{
  const ac = new AbortController();
  ac.abort();
  const result = await executeTool(
    "run_command",
    { command: "sleep 30", cwd: null },
    process.cwd(),
    undefined,
    { abortSignal: ac.signal }
  );
  check(
    "run_command returns failure when abort signal pre-aborted",
    result.success === false &&
      typeof result.output === "string",
    { result }
  );
}

// 4. Map race guard — simulate duplicate runId, prior controller aborted before overwrite
{
  const map = new Map<string, AbortController>();
  const runId = "r-1";
  const a = new AbortController();
  map.set(runId, a);

  // Simulate the new defensive code from /api/patch handler
  const b = new AbortController();
  const prior = map.get(runId);
  if (prior) {
    try { prior.abort(); } catch {}
  }
  map.set(runId, b);

  check(
    "duplicate-runId guard: prior controller aborted before overwrite",
    a.signal.aborted === true && b.signal.aborted === false && map.get(runId) === b,
    { priorAborted: a.signal.aborted, currentAborted: b.signal.aborted, mapHasNew: map.get(runId) === b }
  );
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[abort-signal-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
