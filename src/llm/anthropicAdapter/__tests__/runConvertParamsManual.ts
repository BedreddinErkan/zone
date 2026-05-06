/**
 * Manual fixture test for convertParams.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/llm/anthropicAdapter/__tests__/runConvertParamsManual.ts
 */
const { convertParams } = await import(
  "../../../../dist/llm/anthropicAdapter/convertParams.js"
);
type ChatCompletionCreateParams =
  import("openai/resources/chat/completions").ChatCompletionCreateParams;

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];

function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

const baseModel = "claude-haiku-4-5";

// 1. Plain user message
{
  const out = convertParams({
    model: baseModel,
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 100,
  } as ChatCompletionCreateParams);
  check(
    "plain user message",
    out.params.messages.length === 1 &&
      out.params.messages[0].role === "user" &&
      out.params.messages[0].content === "hello" &&
      out.params.max_tokens === 100 &&
      out.params.system === undefined,
    { messages: out.params.messages, max_tokens: out.params.max_tokens }
  );
}

// 2. System + user
{
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: "You are a helper." },
      { role: "user", content: "hi" },
    ],
  } as ChatCompletionCreateParams);
  check(
    "system + user → system param + user message",
    out.params.system === "You are a helper." &&
      out.params.messages.length === 1 &&
      out.params.messages[0].role === "user",
    { system: out.params.system, count: out.params.messages.length }
  );
  check(
    "default max_tokens applied when missing",
    out.params.max_tokens === 4096,
    { max_tokens: out.params.max_tokens }
  );
}

// 3. Multi-turn user/assistant text
{
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "user", content: "1+1?" },
      { role: "assistant", content: "2" },
      { role: "user", content: "and 2+2?" },
    ],
  } as ChatCompletionCreateParams);
  check(
    "multi-turn alternation preserved",
    out.params.messages.length === 3 &&
      out.params.messages[0].role === "user" &&
      out.params.messages[1].role === "assistant" &&
      out.params.messages[1].content === "2" &&
      out.params.messages[2].role === "user",
    out.params.messages
  );
}

// 4. Assistant with tool_calls + tool result follow-up
{
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "user", content: "weather in Paris?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Paris"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "sunny, 25C",
      },
    ],
  } as ChatCompletionCreateParams);

  const assistantMsg = out.params.messages[1];
  const userToolMsg = out.params.messages[2];
  const blocks = Array.isArray(assistantMsg.content)
    ? assistantMsg.content
    : [];
  const toolUse = blocks.find(
    (b) => (b as { type?: unknown }).type === "tool_use"
  ) as { id: string; name: string; input: unknown } | undefined;
  const toolResultBlock =
    Array.isArray(userToolMsg.content) && userToolMsg.content[0];

  check(
    "assistant tool_calls become tool_use blocks",
    !!toolUse &&
      toolUse.id === "call_1" &&
      toolUse.name === "get_weather" &&
      JSON.stringify(toolUse.input) === '{"city":"Paris"}',
    toolUse
  );
  check(
    "tool result becomes user message with tool_result block",
    userToolMsg.role === "user" &&
      typeof toolResultBlock === "object" &&
      toolResultBlock !== null &&
      (toolResultBlock as { type?: unknown }).type === "tool_result" &&
      (toolResultBlock as { tool_use_id?: unknown }).tool_use_id === "call_1" &&
      (toolResultBlock as { content?: unknown }).content === "sunny, 25C",
    toolResultBlock
  );
}

// 5. Multiple consecutive tool messages → batched into single user message
{
  const out = convertParams({
    model: baseModel,
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "f", arguments: "{}" },
          },
          {
            id: "c2",
            type: "function",
            function: { name: "g", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "r1" },
      { role: "tool", tool_call_id: "c2", content: "r2" },
    ],
  } as ChatCompletionCreateParams);

  const lastUser = out.params.messages[out.params.messages.length - 1];
  const blocks = Array.isArray(lastUser.content) ? lastUser.content : [];
  check(
    "consecutive tool messages batched as one user message with multiple tool_result blocks",
    out.params.messages.length === 2 &&
      lastUser.role === "user" &&
      blocks.length === 2 &&
      blocks.every(
        (b) => (b as { type?: unknown }).type === "tool_result"
      ),
    { lastUserBlocks: blocks }
  );
}

// 6. Tools array translation
{
  const out = convertParams({
    model: baseModel,
    messages: [{ role: "user", content: "ok" }],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_files",
          description: "list dir",
          parameters: {
            type: "object",
            properties: { dir: { type: "string" } },
          },
        },
      },
    ],
  } as ChatCompletionCreateParams);
  const tools = out.params.tools;
  check(
    "tools converted to anthropic shape",
    Array.isArray(tools) &&
      tools.length === 2 &&
      tools[0].name === "read_file" &&
      tools[0].description === "read a file" &&
      typeof tools[0].input_schema === "object" &&
      tools[1].name === "list_files",
    tools
  );
}

// 7. tool_choice variants
{
  const variants: Array<{
    name: string;
    input: ChatCompletionCreateParams["tool_choice"];
    expected: object | undefined;
  }> = [
    { name: "auto", input: "auto", expected: { type: "auto" } },
    { name: "none", input: "none", expected: { type: "none" } },
    { name: "required", input: "required", expected: { type: "any" } },
    {
      name: "named function",
      input: { type: "function", function: { name: "x" } },
      expected: { type: "tool", name: "x" },
    },
    { name: "undefined", input: undefined, expected: undefined },
  ];

  for (const variant of variants) {
    const out = convertParams({
      model: baseModel,
      messages: [{ role: "user", content: "ok" }],
      tool_choice: variant.input,
    } as ChatCompletionCreateParams);
    check(
      `tool_choice ${variant.name}`,
      JSON.stringify(out.params.tool_choice) === JSON.stringify(variant.expected),
      out.params.tool_choice
    );
  }
}

// 8. response_format json_object → system prompt prefix
{
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: "You speak French." },
      { role: "user", content: "ok" },
    ],
    response_format: { type: "json_object" },
  } as ChatCompletionCreateParams);
  check(
    "json_object prepends instruction to system",
    typeof out.params.system === "string" &&
      out.params.system!.startsWith(
        "You must respond with a single valid JSON object only."
      ) &&
      out.params.system!.includes("You speak French."),
    { system: out.params.system?.slice(0, 100) }
  );
  check(
    "tightened JSON instruction includes anti-fence guidance",
    typeof out.params.system === "string" &&
      out.params.system!.includes("DO NOT wrap") &&
      out.params.system!.includes("MUST start directly with {"),
    { system: out.params.system?.slice(0, 200) }
  );
}

// 9. response_format json_object with no system → injects instruction-only system
{
  const out = convertParams({
    model: baseModel,
    messages: [{ role: "user", content: "ok" }],
    response_format: { type: "json_object" },
  } as ChatCompletionCreateParams);
  check(
    "json_object without system creates system",
    typeof out.params.system === "string" &&
      out.params.system!.includes(
        "single valid JSON object only"
      ),
    { system: out.params.system?.slice(0, 100) }
  );
}

// 10. Streaming params identical (stream flag itself is dropped — handled by which method is called)
{
  const out = convertParams({
    model: baseModel,
    messages: [{ role: "user", content: "ok" }],
    stream: true,
    temperature: 0.5,
  } as ChatCompletionCreateParams);
  check(
    "stream flag not in params",
    !("stream" in out.params),
    Object.keys(out.params)
  );
}

// 11. temperature clamped to [0,1]
{
  const out = convertParams({
    model: baseModel,
    messages: [{ role: "user", content: "ok" }],
    temperature: 1.5,
  } as ChatCompletionCreateParams);
  check("temperature clamped to 1", out.params.temperature === 1, {
    temperature: out.params.temperature,
  });

  const out2 = convertParams({
    model: baseModel,
    messages: [{ role: "user", content: "ok" }],
    temperature: -0.5,
  } as ChatCompletionCreateParams);
  check("temperature clamped to 0", out2.params.temperature === 0, {
    temperature: out2.params.temperature,
  });
}

// 12. stop sequences
{
  const a = convertParams({
    model: baseModel,
    messages: [{ role: "user", content: "ok" }],
    stop: "END",
  } as ChatCompletionCreateParams);
  const b = convertParams({
    model: baseModel,
    messages: [{ role: "user", content: "ok" }],
    stop: ["X", "Y"],
  } as ChatCompletionCreateParams);
  check(
    "stop string normalised to array",
    JSON.stringify(a.params.stop_sequences) === '["END"]',
    a.params.stop_sequences
  );
  check(
    "stop array preserved",
    JSON.stringify(b.params.stop_sequences) === '["X","Y"]',
    b.params.stop_sequences
  );
}

// 13. Unsupported params surfaced as warnings
{
  const out = convertParams({
    model: baseModel,
    messages: [{ role: "user", content: "ok" }],
    frequency_penalty: 0.5,
    presence_penalty: 0.2,
    seed: 12,
  } as ChatCompletionCreateParams);
  check(
    "unsupported params produce warnings",
    out.warnings.some((w) => w.includes("frequency_penalty")) &&
      out.warnings.some((w) => w.includes("presence_penalty")) &&
      out.warnings.some((w) => w.includes("seed")),
    out.warnings
  );
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[convert-params-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
