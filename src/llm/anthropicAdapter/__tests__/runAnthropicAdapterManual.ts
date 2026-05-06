/**
 * Manual integration test for AnthropicAdapter wiring.
 * Uses a mock SDK (no network).
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/llm/anthropicAdapter/__tests__/runAnthropicAdapterManual.ts
 */
const { AnthropicAdapter } = await import(
  "../../../../dist/llm/anthropicAdapter.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];

function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

const fakeAnthropicMessage = {
  id: "msg_fake",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  model: "claude-haiku-4-5",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 4,
    output_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

// Stub the SDK by mutating the adapter instance after construction.
const adapter = new AnthropicAdapter("sk-ant-fake-test");
let lastCallParams: any = null;
(adapter as any).sdk = {
  messages: {
    create: async (params: any) => {
      lastCallParams = params;
      return fakeAnthropicMessage;
    },
    stream: (params: any) => {
      lastCallParams = params;
      return (async function* () {
        yield {
          type: "message_start",
          message: { ...fakeAnthropicMessage, content: [] },
        };
        yield {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "stream" },
        };
        yield { type: "content_block_stop", index: 0 };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1 },
        };
        yield { type: "message_stop" };
      })();
    },
  },
};

// 1. createChatCompletion happy path
{
  const r = await adapter.createChatCompletion({
    model: "claude-haiku-4-5",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi?" },
    ],
    max_tokens: 50,
  });
  check(
    "adapter delegates to sdk.messages.create",
    lastCallParams !== null && lastCallParams.system === "be brief",
    {
      system: lastCallParams?.system,
      stream: lastCallParams?.stream,
    }
  );
  check(
    "adapter returns OpenAI-shaped ChatCompletion",
    r.choices?.[0]?.message?.content === "hi" &&
      r.choices[0].finish_reason === "stop" &&
      r.id === "msg_fake",
    r.choices?.[0]
  );
  check(
    "adapter forwards stream:false to SDK",
    lastCallParams?.stream === false,
    lastCallParams?.stream
  );
}

// 2. createChatCompletionStream happy path
{
  const stream = await adapter.createChatCompletionStream({
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 100,
    stream: true,
  });
  const text: string[] = [];
  let final: any = null;
  for await (const chunk of stream) {
    if (typeof chunk.choices[0].delta.content === "string") {
      text.push(chunk.choices[0].delta.content);
    }
    if (chunk.choices[0].finish_reason !== null) final = chunk;
  }
  check(
    "stream surface emits OpenAI-shaped chunks",
    text.includes("stream") && final !== null && final.choices[0].finish_reason === "stop",
    { text: text.join(""), final: final?.choices[0] }
  );
}

// 3. createEmbedding throws explicit error
{
  let caught: Error | null = null;
  try {
    await adapter.createEmbedding({
      model: "text-embedding-3-small",
      input: "hi",
    });
  } catch (err) {
    caught = err as Error;
  }
  check(
    "createEmbedding throws explicit anthropic-not-supported error",
    caught !== null &&
      caught.message.includes("not supported by the Anthropic provider") &&
      caught.message.includes("OPENAI_API_KEY"),
    caught?.message
  );
}

// 4. provider field
{
  check("provider is 'anthropic'", adapter.provider === "anthropic", adapter.provider);
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[anthropic-adapter-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
