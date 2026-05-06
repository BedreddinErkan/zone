/**
 * Manual fixture test for getModelName(provider, tier, override) and the
 * model catalog helpers.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/llm/__tests__/runModelOverrideManual.ts
 */
const { getModelName } = await import("../../../dist/llm/openaiClient.js");
const { isValidModelId, getDefaultModelForTier } = await import(
  "../../../dist/llm/models.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];

function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

// Snapshot env vars so we can restore.
const ENV_KEYS = [
  "ZONE_LLM_MODEL_HIGH",
  "ZONE_LLM_MODEL",
  "OPENAI_MODEL",
  "ZONE_ANTHROPIC_MODEL_HIGH",
  "ZONE_ANTHROPIC_MODEL",
];
const envSnapshot: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
for (const k of ENV_KEYS) delete process.env[k];

try {
  // 1. No override → openai high tier returns gpt-4o default
  {
    const got = getModelName("high", "openai");
    check("no override openai high → default gpt-4o", got === "gpt-4o", got);
  }

  // 2. Valid override → gpt-4-turbo
  {
    const got = getModelName("high", "openai", { high: "gpt-4-turbo" });
    check("valid openai high override → gpt-4-turbo", got === "gpt-4-turbo", got);
  }

  // 3. Invalid override → falls through to default
  {
    const got = getModelName("high", "openai", { high: "fake-model" });
    check(
      "invalid openai high override falls through to default",
      got === "gpt-4o",
      got
    );
  }

  // 4. Anthropic standard with valid haiku override
  {
    const got = getModelName("standard", "anthropic", {
      standard: "claude-haiku-4-5",
    });
    check(
      "valid anthropic standard override → claude-haiku-4-5",
      got === "claude-haiku-4-5",
      got
    );
  }

  // 5. isValidModelId positive
  {
    const got = isValidModelId("openai", "gpt-4o");
    check("isValidModelId openai/gpt-4o → true", got === true, got);
  }

  // 6. Cross-provider rejection
  {
    const got = isValidModelId("anthropic", "gpt-4o");
    check("isValidModelId anthropic/gpt-4o → false", got === false, got);
  }

  // 7. Default for openai high
  {
    const got = getDefaultModelForTier("openai", "high");
    check("getDefaultModelForTier openai/high → gpt-4o", got === "gpt-4o", got);
  }

  // 8. Default for anthropic standard
  {
    const got = getDefaultModelForTier("anthropic", "standard");
    check(
      "getDefaultModelForTier anthropic/standard → claude-haiku-4-5",
      got === "claude-haiku-4-5",
      got
    );
  }

  // 9. Empty-string override is treated as absent (falls through to default)
  {
    const got = getModelName("high", "openai", { high: "" });
    check(
      "empty-string override falls through to default",
      got === "gpt-4o",
      got
    );
  }

  // 10. Anthropic high with opus override
  {
    const got = getModelName("high", "anthropic", { high: "claude-opus-4-5" });
    check(
      "valid anthropic high override → claude-opus-4-5",
      got === "claude-opus-4-5",
      got
    );
  }

  // 11. Tier mismatch — only standard set, requesting high → falls through
  {
    const got = getModelName("high", "openai", { standard: "gpt-4o-mini" });
    check(
      "tier mismatch (standard set, requesting high) → default",
      got === "gpt-4o",
      got
    );
  }
} finally {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[model-override-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
