/**
 * Manual fixture test for convertResponse.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/llm/anthropicAdapter/__tests__/runConvertResponseManual.ts
 */
const { convertResponse, convertStopReason, stripJsonFences } = await import(
  "../../../../dist/llm/anthropicAdapter/convertResponse.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];

function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

function buildMsg(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    content: [],
    ...over,
  };
}

// 1. Text-only response
{
  const r = convertResponse(
    buildMsg({
      content: [{ type: "text", text: "hello world" }],
    })
  );
  check(
    "text-only response → message.content string + stop reason 'stop'",
    r.choices[0].message.content === "hello world" &&
      r.choices[0].finish_reason === "stop" &&
      r.choices[0].message.tool_calls === undefined,
    r.choices[0]
  );
  check(
    "usage forwarded",
    r.usage?.prompt_tokens === 10 &&
      r.usage?.completion_tokens === 5 &&
      r.usage?.total_tokens === 15,
    r.usage
  );
}

// 2. Single tool_use response (no text)
{
  const r = convertResponse(
    buildMsg({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "get_weather",
          input: { city: "Paris" },
        },
      ],
    })
  );
  check(
    "tool_use only → content null, finish_reason tool_calls",
    r.choices[0].message.content === null &&
      r.choices[0].finish_reason === "tool_calls" &&
      Array.isArray(r.choices[0].message.tool_calls) &&
      r.choices[0].message.tool_calls?.length === 1,
    r.choices[0].message
  );
  check(
    "tool_call shape",
    r.choices[0].message.tool_calls?.[0].id === "toolu_1" &&
      r.choices[0].message.tool_calls?.[0].function.name === "get_weather" &&
      r.choices[0].message.tool_calls?.[0].function.arguments ===
        '{"city":"Paris"}',
    r.choices[0].message.tool_calls?.[0]
  );
}

// 3. Mixed text + tool_use
{
  const r = convertResponse(
    buildMsg({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Let me check that." },
        {
          type: "tool_use",
          id: "toolu_2",
          name: "lookup",
          input: { id: 7 },
        },
      ],
    })
  );
  check(
    "mixed text + tool_use → content has text and tool_calls populated",
    r.choices[0].message.content === "Let me check that." &&
      r.choices[0].message.tool_calls?.length === 1 &&
      r.choices[0].finish_reason === "tool_calls",
    r.choices[0].message
  );
}

// 4. Multiple parallel tool_use
{
  const r = convertResponse(
    buildMsg({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "a",
          name: "x",
          input: { v: 1 },
        },
        {
          type: "tool_use",
          id: "b",
          name: "y",
          input: { v: 2 },
        },
      ],
    })
  );
  check(
    "parallel tool calls preserved",
    r.choices[0].message.tool_calls?.length === 2 &&
      r.choices[0].message.tool_calls?.[0].id === "a" &&
      r.choices[0].message.tool_calls?.[1].id === "b",
    r.choices[0].message.tool_calls
  );
}

// 5. Each stop_reason variant maps correctly
{
  const cases: Array<{ in: string; out: string }> = [
    { in: "end_turn", out: "stop" },
    { in: "max_tokens", out: "length" },
    { in: "stop_sequence", out: "stop" },
    { in: "tool_use", out: "tool_calls" },
    { in: "pause_turn", out: "stop" },
    { in: "refusal", out: "content_filter" },
  ];
  for (const c of cases) {
    const got = convertStopReason(c.in);
    check(`stop_reason ${c.in} → ${c.out}`, got === c.out, got);
  }
  check(
    "null stop_reason defaults to stop",
    convertStopReason(null) === "stop",
    convertStopReason(null)
  );
}

// 6. JSON mode + clean JSON content → passes through unchanged
{
  const r = convertResponse(
    buildMsg({
      content: [{ type: "text", text: '{"city":"Paris","tempC":20}' }],
    }),
    { wasJsonMode: true }
  );
  check(
    "json mode + clean JSON: content unchanged",
    r.choices[0].message.content === '{"city":"Paris","tempC":20}',
    r.choices[0].message.content
  );
}

// 7. JSON mode + ```json fenced content → fences stripped
{
  const fenced = '```json\n{\n  "city": "Paris",\n  "tempC": 20\n}\n```';
  const r = convertResponse(
    buildMsg({
      content: [{ type: "text", text: fenced }],
    }),
    { wasJsonMode: true }
  );
  const content = r.choices[0].message.content;
  let parsed: unknown = null;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(content as string);
  } catch (e) {
    parseError = String(e);
  }
  check(
    "json mode + ```json fenced: fences stripped, JSON parseable",
    typeof content === "string" &&
      !content.includes("```") &&
      parseError === null &&
      (parsed as { city: string }).city === "Paris" &&
      (parsed as { tempC: number }).tempC === 20,
    { content, parsed, parseError }
  );
}

// 8. JSON mode + ``` (no language tag) fenced content → fences stripped
{
  const fenced = '```\n{"a":1}\n```';
  const r = convertResponse(
    buildMsg({
      content: [{ type: "text", text: fenced }],
    }),
    { wasJsonMode: true }
  );
  check(
    "json mode + ``` (no lang) fenced: fences stripped",
    r.choices[0].message.content === '{"a":1}',
    r.choices[0].message.content
  );
}

// 9. NOT JSON mode + content that contains ```json markers → no false positives
{
  const text = '```json\n{"a":1}\n```';
  const r = convertResponse(
    buildMsg({
      content: [{ type: "text", text }],
    }),
    { wasJsonMode: false }
  );
  check(
    "non-json mode: ```json content passes through unchanged",
    r.choices[0].message.content === text,
    r.choices[0].message.content
  );

  // Also verify default options (no wasJsonMode passed) preserves content.
  const r2 = convertResponse(
    buildMsg({
      content: [{ type: "text", text }],
    })
  );
  check(
    "no options: ```json content passes through unchanged",
    r2.choices[0].message.content === text,
    r2.choices[0].message.content
  );
}

// 10. stripJsonFences direct unit checks (idempotency)
{
  check(
    "stripJsonFences idempotent on plain JSON",
    stripJsonFences('{"x":1}') === '{"x":1}',
    stripJsonFences('{"x":1}')
  );
  check(
    "stripJsonFences trims surrounding whitespace inside fences",
    stripJsonFences('   ```json\n  {"x":1}  \n```   ') === '{"x":1}',
    stripJsonFences('   ```json\n  {"x":1}  \n```   ')
  );
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[convert-response-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
