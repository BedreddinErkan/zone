/**
 * Manual fixture test for convertStream.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/llm/anthropicAdapter/__tests__/runConvertStreamManual.ts
 */
const { convertStream } = await import(
  "../../../../dist/llm/anthropicAdapter/convertStream.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];

function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

async function* fromArray(events: any[]) {
  for (const e of events) yield e;
}

async function collect(events: any[]): Promise<any[]> {
  const out: any[] = [];
  for await (const c of convertStream(fromArray(events))) out.push(c);
  return out;
}

function buildMessageStart(id = "msg_x", model = "claude-haiku-4-5"): any {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

// 1. Pure text stream
{
  const events = [
    buildMessageStart(),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  const chunks = await collect(events);
  const initial = chunks[0];
  const deltas = chunks.slice(1, -1);
  const final = chunks[chunks.length - 1];
  const text = deltas.map((c) => c.choices[0].delta.content ?? "").join("");

  check(
    "first chunk has role:assistant",
    initial.choices[0].delta.role === "assistant",
    initial.choices[0].delta
  );
  check("text deltas concatenate to 'Hello world'", text === "Hello world", text);
  check(
    "final chunk has finish_reason 'stop' and empty delta",
    final.choices[0].finish_reason === "stop" &&
      Object.keys(final.choices[0].delta).length === 0,
    final.choices[0]
  );
  check(
    "all chunks share id and model",
    chunks.every(
      (c) => c.id === "msg_x" && c.model === "claude-haiku-4-5"
    ),
    { sample: chunks[0] }
  );
}

// 2. Single tool_use stream
{
  const events = [
    buildMessageStart("msg_t"),
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_a",
        name: "get_weather",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"city":' },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"Paris"}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 6 },
    },
    { type: "message_stop" },
  ];
  const chunks = await collect(events);
  const startChunk = chunks.find(
    (c) =>
      Array.isArray(c.choices[0].delta.tool_calls) &&
      c.choices[0].delta.tool_calls[0].id === "toolu_a"
  );
  const argChunks = chunks.filter(
    (c) =>
      Array.isArray(c.choices[0].delta.tool_calls) &&
      typeof c.choices[0].delta.tool_calls[0].function?.arguments ===
        "string" &&
      !c.choices[0].delta.tool_calls[0].id
  );
  const argsConcat = argChunks
    .map((c) => c.choices[0].delta.tool_calls[0].function.arguments)
    .join("");
  const final = chunks[chunks.length - 1];
  check(
    "tool_use start emits chunk with tool_calls[index=0,id,name,empty arguments]",
    !!startChunk &&
      startChunk.choices[0].delta.tool_calls[0].index === 0 &&
      startChunk.choices[0].delta.tool_calls[0].function.name === "get_weather" &&
      startChunk.choices[0].delta.tool_calls[0].function.arguments === "",
    startChunk?.choices[0].delta.tool_calls[0]
  );
  check(
    "tool argument deltas concatenate to full JSON",
    argsConcat === '{"city":"Paris"}',
    argsConcat
  );
  check(
    "final finish_reason for tool_use is 'tool_calls'",
    final.choices[0].finish_reason === "tool_calls",
    final.choices[0]
  );
}

// 3. Mixed text + tool_use stream
{
  const events = [
    buildMessageStart("msg_m"),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Sure, " },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "checking." },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_m1",
        name: "lookup",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"x":1}' },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
  const chunks = await collect(events);
  const text = chunks
    .map((c) => c.choices[0].delta.content ?? "")
    .join("");
  const toolStarts = chunks.filter(
    (c) =>
      Array.isArray(c.choices[0].delta.tool_calls) &&
      c.choices[0].delta.tool_calls[0].id === "toolu_m1"
  );
  check(
    "text streamed before tool",
    text === "Sure, checking.",
    text
  );
  check(
    "tool_use after text uses next tool_index (0 since first tool overall)",
    toolStarts.length === 1 &&
      toolStarts[0].choices[0].delta.tool_calls[0].index === 0,
    toolStarts[0]?.choices[0].delta.tool_calls[0]
  );
}

// 4. Multiple parallel tool_use blocks → tool indices 0,1
{
  const events = [
    buildMessageStart("msg_p"),
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tA",
        name: "a",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{}" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "tB",
        name: "b",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{}" },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  const chunks = await collect(events);
  const allToolIndices: number[] = [];
  for (const c of chunks) {
    const tc = c.choices[0].delta.tool_calls;
    if (Array.isArray(tc) && typeof tc[0]?.id === "string") {
      allToolIndices.push(tc[0].index);
    }
  }
  check(
    "parallel tool_use blocks get distinct indices 0,1",
    JSON.stringify(allToolIndices) === "[0,1]",
    allToolIndices
  );
}

// 5. Empty content_block edge case (block start with no deltas)
{
  const events = [
    buildMessageStart("msg_e"),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 0 },
    },
    { type: "message_stop" },
  ];
  const chunks = await collect(events);
  // Should still emit initial role chunk + final stop chunk; no content deltas in between.
  const finals = chunks.filter((c) => c.choices[0].finish_reason !== null);
  check(
    "empty block: initial role + final stop chunks produced",
    chunks.length >= 2 &&
      chunks[0].choices[0].delta.role === "assistant" &&
      finals.length === 1 &&
      finals[0].choices[0].finish_reason === "stop",
    {
      count: chunks.length,
      first: chunks[0].choices[0].delta,
      final: finals[0].choices[0],
    }
  );
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[convert-stream-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
