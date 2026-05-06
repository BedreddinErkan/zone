/**
 * Manual fixture test for getRequestContextFromHeaders.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/api/__tests__/runHeaderForwardManual.ts
 *
 * After Tur 5a, importing dist/api/server.js no longer side-effects an
 * `app.listen`, so this runner exits cleanly without ZONE_SERVER_MANUAL_START
 * and without process-exit hacks.
 */
const { getRequestContextFromHeaders } = await import(
  "../../../dist/api/server.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];

function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

function makeReq(headers: Record<string, string | undefined>): {
  headers: Record<string, string | undefined>;
} {
  return { headers };
}

// 1. Both new headers present (provider=openai)
{
  const req = makeReq({
    "x-zone-llm-key": "sk-zone-openai-1",
    "x-zone-provider": "openai",
  });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "new headers (openai): apiKey + provider populated",
    ctx.apiKey === "sk-zone-openai-1" && ctx.provider === "openai",
    ctx
  );
}

// 2. Both new headers present (provider=anthropic)
{
  const req = makeReq({
    "x-zone-llm-key": "sk-ant-test-1",
    "x-zone-provider": "anthropic",
  });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "new headers (anthropic): apiKey + provider populated",
    ctx.apiKey === "sk-ant-test-1" && ctx.provider === "anthropic",
    ctx
  );
}

// 3. New header without provider header → provider undefined, key still extracted
{
  const req = makeReq({ "x-zone-llm-key": "sk-no-provider" });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "new key without provider: provider undefined, apiKey set",
    ctx.apiKey === "sk-no-provider" && ctx.provider === undefined,
    ctx
  );
}

// 4. Legacy header only → ignored after Tur 5a retirement (no apiKey extracted)
{
  const req = makeReq({ "x-user-openai-key": "sk-legacy-1" });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "legacy x-user-openai-key alone is ignored (no apiKey, no provider)",
    ctx.apiKey === "" && ctx.provider === undefined,
    ctx
  );
}

// 5. New + legacy → new wins; legacy completely ignored
{
  const req = makeReq({
    "x-zone-llm-key": "sk-new-wins",
    "x-zone-provider": "anthropic",
    "x-user-openai-key": "sk-legacy-loses",
  });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "new headers used; legacy header ignored",
    ctx.apiKey === "sk-new-wins" && ctx.provider === "anthropic",
    ctx
  );
}

// 6. No headers at all → empty context
{
  const req = makeReq({});
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "no headers: empty apiKey, undefined provider",
    ctx.apiKey === "" && ctx.provider === undefined,
    ctx
  );
}

// 7. Invalid provider value → undefined provider (not crash)
{
  const req = makeReq({
    "x-zone-llm-key": "sk-something",
    "x-zone-provider": "claudemax",
  });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "invalid provider value → undefined, key still passes through",
    ctx.apiKey === "sk-something" && ctx.provider === undefined,
    ctx
  );
}

// 8. Whitespace handling (key + provider)
{
  const req = makeReq({
    "x-zone-llm-key": "   sk-trim-me   ",
    "x-zone-provider": "  ANTHROPIC  ",
  });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "whitespace trimmed; provider lowercased",
    ctx.apiKey === "sk-trim-me" && ctx.provider === "anthropic",
    ctx
  );
}

// 9. Provider header alone (no key) preserved → backend can fall through to env
{
  const req = makeReq({ "x-zone-provider": "anthropic" });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "provider preference preserved when no key supplied",
    ctx.apiKey === "" && ctx.provider === "anthropic",
    ctx
  );
}

// 10. Empty-string headers should behave like absent
{
  const req = makeReq({
    "x-zone-llm-key": "   ",
    "x-zone-provider": "",
  });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "whitespace-only key + empty provider → treated as absent",
    ctx.apiKey === "" && ctx.provider === undefined,
    ctx
  );
}

// 11. Both model headers present → both fields populated
{
  const req = makeReq({
    "x-zone-llm-key": "sk-with-models",
    "x-zone-provider": "anthropic",
    "x-zone-llm-model-high": "claude-opus-4-5",
    "x-zone-llm-model-standard": "claude-haiku-4-5",
  });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "both model headers present → modelHigh + modelStandard populated",
    ctx.modelHigh === "claude-opus-4-5" &&
      ctx.modelStandard === "claude-haiku-4-5",
    ctx
  );
}

// 12. Only one model header present → only that field populated
{
  const req = makeReq({
    "x-zone-llm-key": "sk-only-high",
    "x-zone-provider": "openai",
    "x-zone-llm-model-high": "gpt-4-turbo",
  });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "only modelHigh present → modelStandard undefined",
    ctx.modelHigh === "gpt-4-turbo" && ctx.modelStandard === undefined,
    ctx
  );
}

// 13. Empty/whitespace model headers treated as absent
{
  const req = makeReq({
    "x-zone-llm-key": "sk-blank-models",
    "x-zone-provider": "openai",
    "x-zone-llm-model-high": "   ",
    "x-zone-llm-model-standard": "",
  });
  const ctx = getRequestContextFromHeaders(req as never);
  check(
    "whitespace/empty model headers treated as absent",
    ctx.modelHigh === undefined && ctx.modelStandard === undefined,
    ctx
  );
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[header-forward-test] PASSED ${passed}/${total} assertions`);
// Force exit: the dist/api/server.js module sets up long-lived state (perf
// counters, etc.) whose handles keep the event loop alive after tests pass.
// Pre-existing — unrelated to this test.
process.exit(passed === total ? 0 : 1);
