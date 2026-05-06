/**
 * Manual fixture test for prompt-caching behavior in convertParams.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/llm/anthropicAdapter/__tests__/runCachingManual.ts
 */
const { convertParams } = await import(
  "../../../../dist/llm/anthropicAdapter/convertParams.js"
);
type ChatCompletionCreateParams =
  import("openai/resources/chat/completions").ChatCompletionCreateParams;
type ChatCompletionTool =
  import("openai/resources/chat/completions").ChatCompletionTool;

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];

function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`         got: ${JSON.stringify(got)?.slice(0, 400)}`);
  }
}

const baseModel = "claude-sonnet-4-6";

function makeTool(name: string, descLen: number, schemaPropCount: number): ChatCompletionTool {
  const properties: Record<string, { type: string; description: string }> = {};
  for (let i = 0; i < schemaPropCount; i += 1) {
    properties[`prop${i}`] = {
      type: "string",
      description: "x".repeat(40),
    };
  }
  return {
    type: "function",
    function: {
      name,
      description: "d".repeat(descLen),
      parameters: {
        type: "object",
        properties,
        required: Object.keys(properties),
      },
    },
  };
}

// =====================================================================
// 1. Cache eligible — system 6000 chars + tools array totaling ~4000 chars
// =====================================================================
{
  const sys = "S".repeat(6000);
  const tools: ChatCompletionTool[] = [
    makeTool("alpha", 800, 8),
    makeTool("beta", 800, 8),
    makeTool("gamma", 800, 8),
  ];
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: "hi" },
    ],
    tools,
  } as ChatCompletionCreateParams);

  const sysIsArray = Array.isArray(out.params.system);
  const sysFirst =
    sysIsArray && Array.isArray(out.params.system)
      ? (out.params.system as Array<{ type?: string; text?: string }>)[0]
      : null;
  const toolsArr = (out.params.tools ?? []) as Array<{
    name: string;
    cache_control?: { type: string };
  }>;
  const lastTool = toolsArr[toolsArr.length - 1];
  const earlierTools = toolsArr.slice(0, -1);

  check(
    "case1 system converted to array form",
    sysIsArray &&
      !!sysFirst &&
      sysFirst.type === "text" &&
      sysFirst.text === sys,
    { sysType: typeof out.params.system, sysIsArray, sysFirst }
  );
  check(
    "case1 last tool has cache_control: ephemeral",
    !!lastTool &&
      !!lastTool.cache_control &&
      lastTool.cache_control.type === "ephemeral",
    { lastTool }
  );
  check(
    "case1 earlier tools have NO cache_control",
    earlierTools.every((t) => t.cache_control === undefined),
    earlierTools.map((t) => ({ name: t.name, cache_control: t.cache_control }))
  );
}

// =====================================================================
// 2. Cache ineligible (too small) — system 200 chars + 1 small tool
// =====================================================================
{
  const sys = "S".repeat(200);
  const tools: ChatCompletionTool[] = [makeTool("tiny", 20, 1)];
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: "hi" },
    ],
    tools,
  } as ChatCompletionCreateParams);

  const sysIsString = typeof out.params.system === "string";
  const toolsArr = (out.params.tools ?? []) as Array<{
    cache_control?: unknown;
  }>;

  check(
    "case2 system kept as plain string",
    sysIsString && out.params.system === sys,
    { sysType: typeof out.params.system }
  );
  check(
    "case2 no cache_control on any tool",
    toolsArr.every((t) => t.cache_control === undefined),
    toolsArr
  );
}

// =====================================================================
// 3. No tools — system 10000 chars, undefined tools
// =====================================================================
{
  const sys = "S".repeat(10000);
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: "hi" },
    ],
  } as ChatCompletionCreateParams);

  const sysIsString = typeof out.params.system === "string";

  check(
    "case3 no tools → no caching applied (system stays string)",
    sysIsString && out.params.system === sys,
    { sysType: typeof out.params.system }
  );
  check(
    "case3 no tools field on params",
    out.params.tools === undefined,
    { tools: out.params.tools }
  );
}

// =====================================================================
// 4. Last tool only — verify with 3 tools that ONLY tools[2] has cache_control
// =====================================================================
{
  const sys = "S".repeat(6000);
  const tools: ChatCompletionTool[] = [
    makeTool("first", 800, 8),
    makeTool("second", 800, 8),
    makeTool("third", 800, 8),
  ];
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: "hi" },
    ],
    tools,
  } as ChatCompletionCreateParams);

  const toolsArr = (out.params.tools ?? []) as Array<{
    name: string;
    cache_control?: { type: string };
  }>;

  check(
    "case4 tools[0] has no cache_control",
    toolsArr[0]?.cache_control === undefined,
    { tool0: toolsArr[0] }
  );
  check(
    "case4 tools[1] has no cache_control",
    toolsArr[1]?.cache_control === undefined,
    { tool1: toolsArr[1] }
  );
  check(
    "case4 tools[2] has cache_control: ephemeral",
    !!toolsArr[2]?.cache_control &&
      toolsArr[2].cache_control.type === "ephemeral",
    { tool2: toolsArr[2] }
  );
}

// =====================================================================
// 5. Idempotence — calling convertParams twice with same input → identical output
// =====================================================================
{
  const sys = "S".repeat(6000);
  const tools: ChatCompletionTool[] = [
    makeTool("a", 800, 8),
    makeTool("b", 800, 8),
  ];
  const inputParams = {
    model: baseModel,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: "hi" },
    ],
    tools,
  } as ChatCompletionCreateParams;

  const out1 = convertParams(inputParams);
  const out2 = convertParams(inputParams);

  check(
    "case5 two invocations produce identical params JSON",
    JSON.stringify(out1.params) === JSON.stringify(out2.params),
    {
      a: JSON.stringify(out1.params).length,
      b: JSON.stringify(out2.params).length,
    }
  );

  const toolsA = (out1.params.tools ?? []) as Array<{
    cache_control?: unknown;
  }>;
  const toolsB = (out2.params.tools ?? []) as Array<{
    cache_control?: unknown;
  }>;
  check(
    "case5 each call has exactly one cache_control marker",
    toolsA.filter((t) => t.cache_control !== undefined).length === 1 &&
      toolsB.filter((t) => t.cache_control !== undefined).length === 1,
    {
      aCount: toolsA.filter((t) => t.cache_control !== undefined).length,
      bCount: toolsB.filter((t) => t.cache_control !== undefined).length,
    }
  );
  check(
    "case5 input tools array not mutated by adapter",
    (tools as Array<{ cache_control?: unknown }>).every(
      (t) => t.cache_control === undefined
    ),
    tools.map((t) => ({
      name: t.function.name,
      cache_control: (t as { cache_control?: unknown }).cache_control,
    }))
  );
}

// =====================================================================
// Message-tail breakpoint (default ON; opt out via ZONE_ENABLE_MESSAGE_CACHE=0)
// =====================================================================

function withMessageCacheEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.ZONE_ENABLE_MESSAGE_CACHE;
  if (value === undefined) delete process.env.ZONE_ENABLE_MESSAGE_CACHE;
  else process.env.ZONE_ENABLE_MESSAGE_CACHE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.ZONE_ENABLE_MESSAGE_CACHE;
    else process.env.ZONE_ENABLE_MESSAGE_CACHE = prev;
  }
}

function makeEligibleTools(): ChatCompletionTool[] {
  return [
    makeTool("alpha", 800, 8),
    makeTool("beta", 800, 8),
    makeTool("gamma", 800, 8),
  ];
}

function lastMessageContent(out: { params: { messages: unknown } }): unknown {
  const msgs = out.params.messages as Array<{ role: string; content: unknown }>;
  return msgs[msgs.length - 1]?.content;
}

function findLastUserMessage(
  out: { params: { messages: unknown } }
): { content: unknown } | undefined {
  const msgs = out.params.messages as Array<{ role: string; content: unknown }>;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role === "user") return msgs[i];
  }
  return undefined;
}

function countMessageCacheControls(out: { params: { messages: unknown } }): number {
  const msgs = out.params.messages as Array<{ content: unknown }>;
  let n = 0;
  for (const m of msgs) {
    if (Array.isArray(m.content)) {
      for (const block of m.content as Array<{ cache_control?: unknown }>) {
        if (block && block.cache_control !== undefined) n += 1;
      }
    }
  }
  return n;
}

// =====================================================================
// 6. Flag OFF (default) — eligible system+tools+messages, NO message cache_control
// =====================================================================
withMessageCacheEnv("0", () => {
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: "S".repeat(6000) },
      { role: "user", content: "first ask " + "x".repeat(600) },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second ask " + "y".repeat(600) },
    ],
    tools: makeEligibleTools(),
  } as ChatCompletionCreateParams);

  const messageMarkers = countMessageCacheControls(out);
  const toolsArr = (out.params.tools ?? []) as Array<{ cache_control?: unknown }>;
  const toolMarkers = toolsArr.filter((t) => t.cache_control !== undefined).length;

  check(
    "case6 flag OFF → no cache_control on any message content block",
    messageMarkers === 0,
    { messageMarkers }
  );
  check(
    "case6 flag OFF → tools breakpoint still present (last tool only)",
    toolMarkers === 1,
    { toolMarkers }
  );
});

// =====================================================================
// 7. Flag ON — last user message gets cache_control; first user does NOT
// =====================================================================
withMessageCacheEnv("1", () => {
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: "S".repeat(6000) },
      { role: "user", content: "first ask " + "x".repeat(600) },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second ask " + "y".repeat(600) },
    ],
    tools: makeEligibleTools(),
  } as ChatCompletionCreateParams);

  const msgs = out.params.messages as Array<{
    role: string;
    content: unknown;
  }>;
  // After translation: index 0 = first user, 1 = assistant, 2 = last user
  const firstUser = msgs[0];
  const lastUser = msgs[2];
  const lastUserContent = Array.isArray(lastUser.content)
    ? (lastUser.content as Array<{ cache_control?: { type?: string } }>)
    : null;
  const lastBlock = lastUserContent
    ? lastUserContent[lastUserContent.length - 1]
    : null;
  const firstUserContent = firstUser.content;

  check(
    "case7 last user content is array with last block carrying cache_control: ephemeral",
    !!lastBlock &&
      lastBlock.cache_control !== undefined &&
      lastBlock.cache_control.type === "ephemeral",
    { lastBlock }
  );
  check(
    "case7 first user has NO cache_control (still string or no marker)",
    typeof firstUserContent === "string" ||
      (Array.isArray(firstUserContent) &&
        (firstUserContent as Array<{ cache_control?: unknown }>).every(
          (b) => b.cache_control === undefined
        )),
    { firstUserContent }
  );
  check(
    "case7 exactly one message-level cache_control marker total",
    countMessageCacheControls(out) === 1,
    { count: countMessageCacheControls(out) }
  );
});

// =====================================================================
// 8. Flag ON, single user with string content (>500) → converted to array
// =====================================================================
withMessageCacheEnv("1", () => {
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: "S".repeat(6000) },
      { role: "user", content: "u".repeat(600) },
    ],
    tools: makeEligibleTools(),
  } as ChatCompletionCreateParams);

  const last = findLastUserMessage(out);
  const content = last?.content as
    | Array<{ type?: string; text?: string; cache_control?: { type?: string } }>
    | undefined;

  check(
    "case8 string content converted to single-block array",
    Array.isArray(content) &&
      content.length === 1 &&
      content[0].type === "text" &&
      content[0].text === "u".repeat(600),
    { content }
  );
  check(
    "case8 the single block carries cache_control: ephemeral",
    Array.isArray(content) &&
      content[0].cache_control !== undefined &&
      content[0].cache_control.type === "ephemeral",
    { control: Array.isArray(content) ? content[0].cache_control : null }
  );
});

// =====================================================================
// 9. Flag ON, single tiny user message (<500 chars) → no cache_control
// =====================================================================
withMessageCacheEnv("1", () => {
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: "S".repeat(6000) },
      { role: "user", content: "u".repeat(200) },
    ],
    tools: makeEligibleTools(),
  } as ChatCompletionCreateParams);

  const last = lastMessageContent(out);
  check(
    "case9 tiny single user message → content stays plain string (no array conversion)",
    typeof last === "string" && last === "u".repeat(200),
    { last }
  );
  check(
    "case9 zero message-level cache_control markers",
    countMessageCacheControls(out) === 0,
    { count: countMessageCacheControls(out) }
  );
});

// =====================================================================
// 10. Flag ON but cacheEligible=false (small system + tiny tool)
// =====================================================================
withMessageCacheEnv("1", () => {
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: "S".repeat(200) },
      { role: "user", content: "u".repeat(600) },
    ],
    tools: [makeTool("tiny", 20, 1)],
  } as ChatCompletionCreateParams);

  const toolsArr = (out.params.tools ?? []) as Array<{ cache_control?: unknown }>;
  const toolMarkers = toolsArr.filter((t) => t.cache_control !== undefined).length;

  check(
    "case10 ineligible → no message-level cache_control either (shared fate)",
    countMessageCacheControls(out) === 0,
    { count: countMessageCacheControls(out) }
  );
  check(
    "case10 ineligible → no tool-level cache_control either",
    toolMarkers === 0,
    { toolMarkers }
  );
});

// =====================================================================
// 11. Flag ON, last user content is array (tool_result blocks)
// =====================================================================
withMessageCacheEnv("1", () => {
  const out = convertParams({
    model: baseModel,
    messages: [
      { role: "system", content: "S".repeat(6000) },
      { role: "user", content: "do a tool" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "g", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "r1" },
      { role: "tool", tool_call_id: "c2", content: "r2" },
    ],
    tools: makeEligibleTools(),
  } as ChatCompletionCreateParams);

  // After translation, the tool messages are batched into one user message
  // with two tool_result blocks at the tail.
  const last = findLastUserMessage(out);
  const blocks = Array.isArray(last?.content)
    ? (last!.content as Array<{
        type?: string;
        tool_use_id?: string;
        cache_control?: unknown;
      }>)
    : [];

  const tr1 = blocks.find((b) => b.tool_use_id === "c1");
  const tr2 = blocks.find((b) => b.tool_use_id === "c2");

  check(
    "case11 last user message has two tool_result blocks",
    blocks.length === 2 &&
      blocks.every((b) => b.type === "tool_result"),
    { blocks }
  );
  check(
    "case11 tool_result_2 (last block) carries cache_control: ephemeral",
    !!tr2 &&
      tr2.cache_control !== undefined &&
      (tr2.cache_control as { type?: string }).type === "ephemeral",
    { tr2 }
  );
  check(
    "case11 tool_result_1 (earlier block) has NO cache_control",
    !!tr1 && tr1.cache_control === undefined,
    { tr1 }
  );
});

// =====================================================================
// 12. Idempotence under flag ON — two calls produce identical output, no dup markers
// =====================================================================
withMessageCacheEnv("1", () => {
  const inputParams = {
    model: baseModel,
    messages: [
      { role: "system", content: "S".repeat(6000) },
      { role: "user", content: "first ask " + "x".repeat(600) },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second ask " + "y".repeat(600) },
    ],
    tools: makeEligibleTools(),
  } as ChatCompletionCreateParams;

  const a = convertParams(inputParams);
  const b = convertParams(inputParams);

  check(
    "case12 two flag-on invocations produce identical params JSON",
    JSON.stringify(a.params) === JSON.stringify(b.params),
    {
      aLen: JSON.stringify(a.params).length,
      bLen: JSON.stringify(b.params).length,
    }
  );
  check(
    "case12 each call has exactly one message-level cache_control marker",
    countMessageCacheControls(a) === 1 &&
      countMessageCacheControls(b) === 1,
    {
      aCount: countMessageCacheControls(a),
      bCount: countMessageCacheControls(b),
    }
  );
});

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[caching-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
