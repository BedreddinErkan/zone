# Gateway support — investigation

**Question.** How should Zone support arbitrary OpenAI-compatible gateways (LiteLLM, OpenRouter,
Cloudflare/Vercel AI Gateway, corporate hubs) where the API key format is unknown and model ids may
contain `/` or `:`?

**Status of this document.** Findings first, recommendation last and separately marked. No source
was changed in this pass. `docs/deferred-work.md` was not touched.

**Measured against** `0128df6e` with a clean `src/` (`git status --porcelain -- src` → empty), so
every figure below describes HEAD rather than a working tree. Runtime traces import the built
`dist/`, which post-dates the last `src/` change (`stat -c '%y' dist/llm/models.js src/llm/models.ts`
→ `2026-08-25 16:06` vs `15:26`).

**Instrument conventions used throughout.**

- Every absence claim carries **both** `command grep` and `git grep`, both shown, because the shell
  `grep` here is a ugrep function that skips gitignored trees.
- `git grep -a` is used where a file may be classified binary (`src/snapshots/snapshotStore.ts`
  carries a literal NUL); `tr -d '\r'` is applied to `src/cli/index.ts` output, which is CRLF.
- Claims about what code *would* do are marked **static reading only**. Claims about what it *does*
  name the instrument that produced them.
- Hits in `src/repo/rankerBaseline.snapshot.json` are excluded by name: that fixture embeds stale
  copies of real source files as JSON strings and answers differently from the module it shadows.

---

## Q1 — Is there a seam, or two parallel paths?

### 1.1 The short answer

**There is one shared *vocabulary* and no shared *implementation*.** `LLMClient` is a real interface
with three implementors, but it is not a protocol abstraction: it is the OpenAI Chat Completions
type surface used as a lingua franca, with the Anthropic adapter translating into and out of it. The
OpenAI path *is* the interface; the Anthropic path is a translation onto it.

```
$ git grep -an 'implements LLMClient' -- 'src/**'
src/llm/anthropicAdapter.ts:72:export class AnthropicAdapter implements LLMClient {
src/llm/openaiAdapter.ts:19:export class OpenAIAdapter implements LLMClient {
src/llm/recordingClient.ts:129:export class RecordingLLMClient implements LLMClient {

$ command grep -rn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git 'implements LLMClient' src
   (same three, different order)
```

`RecordingLLMClient` is a decorator, not a provider — `factory.ts:51` wraps whichever adapter was
built. So there are **two** provider implementations, not three.

The interface itself (`src/llm/types.ts:67–87`) is typed entirely in `openai/resources/chat/completions`
types: `ChatCompletionCreateParamsNonStreaming`, `ChatCompletionChunk`, `ChatCompletion`. There is no
neutral request/response type anywhere:

```
$ git grep -anE 'interface .*(Protocol|Transport|Wire|Gateway)' -- 'src/llm/**'
$ command grep -rnE --exclude-dir=node_modules 'interface .*(Protocol|Transport|Wire|Gateway)' src/llm
   (both empty)
```

### 1.2 Layer by layer

| Layer | OpenAI path | Anthropic path | Converge or duplicate? |
|---|---|---|---|
| Client construction | `new OpenAI({apiKey, baseURL, maxRetries:0, timeout, fetchOptions:{dispatcher}})` — `openaiAdapter.ts:36–42` | `new Anthropic({apiKey, timeout, maxRetries:0, fetchOptions:{dispatcher}})` — `anthropicAdapter.ts:84–91` | **Duplicate**, but structurally identical and sharing `requestTimeouts.ts` (`MIN_REQUEST_TIMEOUT_MS`, `zoneDispatcher`). The one asymmetry is `baseURL`, which only OpenAI's has. |
| Request construction | Near-passthrough. Two transforms only: `max_tokens`→`max_completion_tokens` (`openaiAdapter.ts:72–78`) and `reasoning_effort` injection (`:62–69`). A third path, the Responses API, converts via `responsesConvertParams` for `gpt-5*`. | Full translation: `convertParams.ts` (505 lines) — `extractSystem:257`, `translateMessages:293`, `translateTools:443`, `translateToolChoice:478`, plus thinking config, cache breakpoints, `web_search` append, and a drop-list of 7 unsupported OpenAI params (`:72–80`). | **Duplicate.** Zero shared code. The OpenAI path has essentially no request layer; the Anthropic path is 505 lines of one. |
| Auth header | Set by the vendor SDK from `apiKey`. | Set by the vendor SDK from `apiKey`. | **Neither** — the layer does not exist in Zone. See 1.3. |
| SSE parsing | Delegated to the OpenAI SDK; Zone consumes `AsyncIterable<ChatCompletionChunk>`. | Delegated to the Anthropic SDK; `convertStream.ts` consumes `AsyncIterable<Anthropic.MessageStreamEvent>` and re-emits `ChatCompletionChunk`. | **Neither parses SSE.** Both delegate. `convertStream` is an *event-shape* translator, not a wire parser. |
| Tool-call assembly | None in the adapter — chunks are returned raw. | `anthropicAdapter.ts:150–208` merges deltas into a `Map<number,…>` keyed on `tc.index`. | **Duplicate, and at different altitudes.** See Q6 — there are three independent merge implementations in the repo, none shared. |
| Error mapping | **None.** | `mapAnthropicBadRequest` (`anthropicAdapter.ts:46–70`) → `ProviderRequestError`. | **Asymmetric.** `ProviderRequestError` is thrown at exactly one site repo-wide (`anthropicAdapter.ts:67`). An OpenAI 400 propagates raw. |
| Retry classification | `classifyError` (`withExponentialBackoff.ts:62–85`) | same function | **Converges.** The one genuinely shared layer. |

### 1.3 The auth-header layer does not exist

Zone never constructs an LLM auth header. Both SDKs own it (`Authorization: Bearer` / `x-api-key`
+ `anthropic-version`).

```
$ git grep -nEi 'defaultHeaders|authorization|x-api-key|anthropic-version|bearer' -- 'src/**'
$ command grep -rnEi --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git 'defaultHeaders|authorization|x-api-key|anthropic-version|bearer' src
```

Both return the same set, and **none of it is an outbound LLM header**: `remote/controlServer.ts:181–188`
parses an *inbound* bearer token for Zone's own remote-control server; `utils/sanitizeDiagnostics.ts:4,12`
redacts bearer tokens from log text; the rest are risk-rule keyword lists
(`core/computeRiskScoreDetails.ts:173`, `semantic/semanticRiskRules.ts:126`) and tests. `defaultHeaders`
appears **zero** times in `src/`.

**Consequence for gateways:** a gateway needing a custom header (`x-litellm-api-key`, an org id, a
routing header) has no site to be added to. This is a layer to *create*, not one to *generalise*.

### 1.4 `classifyError` is the one convergent layer, and it is convergent by construction

`withExponentialBackoff.ts:62–85` accepts both SDKs' error classes side by side via `instanceof`
(`AnthropicRateLimitError || OpenAIRateLimitError`, and so on), then falls through to a
`status >= 500` catch-all (`:80–83`). `RetryContext.provider` (`:24`) exists but **is never branched
on** — it is passed to `emit` as telemetry only. A gateway driven through the OpenAI SDK inherits
correct retry classification for free, because the SDK still throws `OpenAIRateLimitError` etc.

### 1.5 Is there a third path — partial, dead, or behind a flag?

**No third provider exists anywhere.**

```
$ git grep -ainE 'gemini|ollama|vertex|bedrock|azure|mistral|groq|together\.ai|openrouter|litellm|xai|grok' -- 'src/**'
src/cli/config.test.ts:165:    const cfg = loadCliConfig({}, { defaultProvider: "grok" as never });
src/cli/config.ts:118:  // from independent fallback chains, so `ZONE_MODEL=gemini-3.5-flash` with no
src/cli/config.ts:119:  // provider silently kept the anthropic default — the badge showed Gemini while
src/core/buildEnv.test.ts:50:      GEMINI_API_KEY: "AIzaSy-secret",
src/core/buildEnv.test.ts:58:    expect(env.GEMINI_API_KEY).toBeUndefined();
src/llm/openaiClient.ts:99:      // (e.g. provider="anthropic" with model="gemini-3.5-flash"). We do NOT
src/llm/webSearchWarning.test.ts:32:    warnWebSearchDegradationOnce({ provider: "gemini", …
src/llm/webSearchWarning.test.ts:34:    expect(messages[1]).toContain("gemini");
src/usage/pricing.test.ts:72:    expect(formatCostNote("gemini" as ProviderName, "some-model")).toBeUndefined();

$ command grep -rniE --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
    --exclude=rankerBaseline.snapshot.json 'gemini|ollama|vertex|bedrock|azure|mistral|groq|openrouter|litellm' src
   (same set)
```

Every hit is a **comment, a test, or a redaction fixture**. Zero production code paths.

There is also **no DeepSeek integration**, contrary to a premise this investigation was originally
briefed with:

```
$ git grep -ail deepseek -- .                        → docs/deferred-work.md   (1 file)
$ command grep -ril --exclude-dir={node_modules,dist,.git} deepseek .  → ./docs/deferred-work.md
```

`docs/deferred-work.md:22682` records DeepSeek as an explicitly *deferred, later* pass with an
ordering rationale, and `:24405` mentions it hypothetically inside item 299. There is no
"OpenAI-compatible adapter with a per-provider quirks layer" in this repo to build on.

**Three partial/dead paths do exist, and two of them are exactly where a gateway seam wants to go:**

1. **`OpenAIAdapter`'s `baseUrl` parameter is real and unreached.** The constructor is
   `constructor(apiKey: string, baseUrl?: string, provider: LLMProvider = "openai")`
   (`openaiAdapter.ts:23`) and passes `baseURL: baseUrl` to the SDK (`:38`). The only production
   construction supplies one argument:

   ```
   $ git grep -n 'new OpenAIAdapter' -- .        → 20 hits: 1 production, 19 tests/manual
   src/llm/factory.ts:43:    inner = new OpenAIAdapter(apiKey);
   $ command grep -rn --exclude-dir={node_modules,dist,.git} 'new OpenAIAdapter' .
     (same, plus .zone/audits/openai-responses-api.md and a .zone/item193 dist artifact — neither is source)
   ```

   `AnthropicAdapter` has no such parameter: `constructor(apiKey: string)` (`anthropicAdapter.ts:76`).

2. **The `provider` constructor parameter already gates protocol behaviour**, and this is verified by
   a test rather than by reading: `openaiAdapter.responses.test.ts:125–134` constructs
   `new OpenAIAdapter("sk-test", undefined, "anthropic")` with `model: "gpt-5.4"` and asserts
   `mockChatCreate` was called and `mockResponsesCreate` was not. The guard is
   `this.provider === "openai" && normalizeModelId(params.model).startsWith("gpt-5")`
   (`openaiAdapter.ts:50`, mirrored at `:95`). **An OpenAIAdapter constructed with any non-`"openai"`
   provider stays on Chat Completions for every model id** — which is precisely the behaviour a
   gateway needs.

3. **A hosted-inference base-URL path exists and is fully dead.**
   `getHostedInferenceBaseUrl()` (`openaiClient.ts:29–36`) reads `ZONE_API_BASE_URL`, defaulting to
   `https://zonecli.dev`. It has **zero callers**:

   ```
   $ git grep -n 'getHostedInferenceBaseUrl' -- 'src/**' 'scripts/**'
   src/llm/openaiClient.ts:29:export function getHostedInferenceBaseUrl(): string {
   $ command grep -rn --exclude-dir={node_modules,dist,.git} --exclude=rankerBaseline.snapshot.json \
       getHostedInferenceBaseUrl src scripts
   src/llm/openaiClient.ts:29:export function getHostedInferenceBaseUrl(): string {
   ```

   Its sibling `createOpenAIClient` (`openaiClient.ts:38`) is likewise unreached — a comment at
   `runLlmPatchFlow.ts:4364` already records this ("which no production path reaches"). The
   remaining live reader of `ZONE_API_BASE_URL` is `isHostedEnvironment()`
   (`runLlmPatchFlow.ts:1328–1333`), which uses only its *presence* as a boolean. **This variable
   names Zone's own hosted service, not an LLM endpoint** — reusing it for a gateway would collide
   with that meaning.

   Note the rest of `openaiClient.ts` is *not* dead: `extractResponsesApiOutputText`,
   `formatOpenAiThrownErrorPayload`, `logOpenAiResponseDebug`, `buildEmptyModelResponseDetailsLine`
   all have live callers in `agentLoop.ts`, `planFullPatch.ts` and `taskClassifier.ts` (checked with
   both greps, per-symbol). Only the two client/base-URL functions are orphaned.

---

## Q2 — Provider resolution, base URL, auth header

### 2.1 "Provider" is one runtime value carried by eleven type declarations

The user's caution applies literally here, so it is stated rather than assumed. The config layer's
`CliConfig.provider` and the adapter layer's `LLMClient.provider` are **the same value at runtime**
— `dispatch.ts` passes `effectiveConfig.provider` onward at 13 sites
(`git grep -an 'provider: effectiveConfig.provider' -- src/cli/dispatch.ts` → `:276, 325, 367, 396,
493, 565, 613, 711, 724, 773, 786`, plus `:893` and `:964` on `config.provider`) — some into
`withRequestContext`, some directly into `runLlmPatchFlow` — and `factory.createLLMClient` reads
`getRequestContext()?.provider` (`factory.ts:37–38`).

They are **not** the same *type declaration*. `docs/deferred-work.md` item 297 counts ten
structurally-identical `"anthropic" | "openai"` unions plus an eleventh in `App.tsx:117`. I did not
re-derive that count; I confirmed the named type is two-valued and closed:

```ts
// src/llm/types.ts:9
export type LLMProvider = "openai" | "anthropic";
```

They differ in *what they decide*, which matters for where a seam goes:

| "provider" at this layer | decides |
|---|---|
| `CliConfig.provider` (config) | which API-key field is read; which catalog rows the picker shows; the no-key pre-flight message |
| `ZoneRequestContext.provider` (transport ctx) | which adapter class `createLLMClient` builds |
| `LLMClient.provider` (adapter) | Chat-vs-Responses routing; usage attribution; whether embeddings are attempted; whether `prompt_cache_key` is sent; the web-search degradation warning |

### 2.2 Base-URL sites: two, both inert

```
$ git grep -nE 'baseURL|baseUrl|base_url|BASE_URL' -- 'src/**' 'scripts/**'
```

After excluding `tsconfig` path-alias handling (`src/repo/parseTsconfigPaths.ts`, `buildDependencyGraph.ts`
— unrelated `compilerOptions.baseUrl`), Supabase URLs, and the ranker fixture, exactly two remain:

| Site | Reads | Reached? |
|---|---|---|
| `openaiAdapter.ts:23,38` — `baseUrl` ctor param → `baseURL` | its caller | **No** — sole production caller passes one argument (`factory.ts:43`) |
| `openaiClient.ts:31` — `ZONE_API_BASE_URL` inside `getHostedInferenceBaseUrl` | env | **No** — zero callers (both greps, §1.5) |

**There is no live base-URL configuration in Zone.** Adding one is net-new work, not a rewire.

### 2.3 Auth-header sites: zero

See §1.3. Nothing to inventory.

### 2.4 Provider-deciding sites — correcting the "six sites, three-and-three" count

I ran my own TypeScript-AST walk over tracked `src/**/*.{ts,tsx}` excluding `*.test.*`, `__tests__/`
and `src/test/` (the walk collects equality comparisons against a provider literal where the other side names a
provider, `Record[provider]` element accesses, `switch` on a provider expression, `??`/`||` with a
provider literal on the right, ternaries with one in either arm, bare `return "anthropic"|"openai"`,
and default parameters; it skips the seven zero-byte tracked files by content check).

**Class A — sites *producing* a provider value with a default/literal arm: 14 raw hits across 10 files.**
Collapsing the two `return` statements of a single if/return resolver into one site each, that is
**12 distinct decision sites**, and they split **6 defaulting to `anthropic`, 6 defaulting to `openai`**:

| Site | Shape | Condition tests | Default arm |
|---|---|---|---|
| `cli/config.ts:86–88` `resolveProvider` (now `:86–92` since `aa0711f0` added the warn branch; default arm unchanged) | if-return, no else | `value === "openai"` (raw config string) | **anthropic** |
| `llm/factory.ts:63–69` `resolveProvider` | precedence chain, trailing return | *presence* of explicit / ctx | **anthropic** |
| `llm/modelRegistry.ts:155` `getProviderForModel` | catalog `.find` + `??` | **catalog membership**, not a name | **anthropic** |
| `llm/agentLoop.ts:2250` | `input.provider ?? ctx?.provider ?? …` | presence | **anthropic** |
| `llm/agentLoop.ts:3564` | same | presence | **anthropic** |
| `llm/taskClassifier.ts:555` | `options.provider ?? ctx?.provider ?? …` | presence | **anthropic** |
| `llm/recordingClient.ts:90–93` `toProviderName` | if-return, no else | `provider === "anthropic"` | **openai** |
| `llm/openaiAdapter.ts:23` | **default parameter** | — | **openai** |
| `llm/openaiClient.ts:80` `getModelName` | **default parameter** + nested ternary | `provider === "anthropic"` | **openai** |
| `llm/subagentDispatch.ts:124` | `getRequestContext()?.provider ?? …` | presence | **openai** |
| `tools/toolExecutor.ts:1117` | `_requestCtx?.provider ?? …` | presence | **openai** |
| `llm/taskClassifier.ts:433` | ternary → `ProviderName` | `provider === "anthropic"` | **openai** |

**Verdict on the prior finding.** "Six sites … three defaulting to Anthropic, three to OpenAI" is
**directionally right and numerically low by half**. The 3-and-3 shape is real — it is 6-and-6. The
prior finding also mis-described the shapes: of these twelve, exactly **one** (`taskClassifier.ts:433`)
is a plain two-armed ternary on a provider literal. The rest are if-returns, `??` chains, default
parameters, and one catalog-membership lookup. This agrees with `docs/deferred-work.md` item 298's
own correction, which counted 11 class-A sites to my 12; the difference is that item 298's walk
"keyed on provider literals in the branches" and so missed resolvers whose branches are identifiers,
while mine counts default parameters and both arms of `toProviderName`. **Neither count is canonical
— the definition is.**

**Class B — sites *branching on* a provider value: 38 raw hits across 17 files**, of which **two are
false positives my own instrument produced** and are reported as such rather than quietly dropped:
`anthropicAdapter/thinkingBlocks.ts:139` and `:202` index by `ZONE_PROVIDER_FIELD`, which is
`= "_zoneProvider" as const` (`:134`) — a *field name*, not a provider value. Same word, different
thing. **36 genuine sites.** Item 298 reports 24; the gap is definitional (I count `Record[provider]`
index expressions such as `MODEL_CATALOG[provider]` and `PRICING_USD_PER_MTOK[provider]`, which a
branch-shaped definition excludes).

**Cross-validation is deliberately not claimed.** A textual sweep for the same two literals shares
its token with the AST walk and would reproduce its blind spots as agreement.

### 2.5 The defaults do not agree, and one disagreement is silent

Measured, not read — `loadCliConfig` executed from `dist/` with `HOME` redirected to a scratch
directory and `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`ZONE_MODEL`/`ZONE_PROVIDER` unset, from a cwd
with no `.zone/model.json`:

```
{}                        -> {"model":"claude-sonnet-4-6","provider":"anthropic"}
{"provider":"openrouter"} -> {"model":"claude-sonnet-4-6","provider":"anthropic"}     ← silent
{"provider":"openai"}     -> {"model":"claude-sonnet-4-6","provider":"openai"}        ← mismatched pair
```

Three things this establishes:

1. **An unrecognised provider is silently coerced to `anthropic`.** No warning, no log line.
   `resolveProvider` (`config.ts:86–88`) is `if (value === "openai") return "openai"; return "anthropic";`.
   **SUPERSEDED by `aa0711f0`** (Option B step 2): the coercion now warns, naming the value —
   `[zone] provider "<value>" is not recognized; falling back to anthropic.` The `← silent`
   annotation in the trace block above records what was measured before that commit.
2. **The contrast is stark**: a *known-model/provider conflict* warns loudly —
   `[zone] provider "anthropic" conflicts with model "gpt-4o" (openai); using openai to match the
   selected model.` (measured, `config.ts:127–130`). An *unknown provider* says nothing.
3. **`{provider:"openai"}` alone yields provider `openai` with model `claude-sonnet-4-6`** — a
   cross-provider pair. The model-pins-provider branch (`config.ts:124`) requires `explicitModel`,
   and a defaulted model is not explicit. Downstream, `getModelName` (`openaiClient.ts:97–109`)
   detects this and warns, falling back to `gpt-4o`.

### 2.6 There is no `--provider` flag — SUPERSEDED by `aa0711f0`: the flag now exists

```
$ git grep -an 'provider' -- src/cli/index.ts | tr -d '\r'      → (empty)
$ command grep -n 'provider' src/cli/index.ts | tr -d '\r'      → (empty)
$ git grep -an '\.option(' -- 'src/**' | tr -d '\r' | grep -i provider          → (empty)
$ command grep -rn --exclude-dir={node_modules,dist,.git} '\.option(' src | tr -d '\r' | grep -i provider  → (empty)
```

The string `provider` does not occur in `src/cli/index.ts` at all. `CliFlags.provider` (`config.ts:40`)
is declared and read (`config.ts:114`), but commander never sets it and no production caller supplies
it (`git grep -anE 'loadCliConfig\(' -- 'src/**' | grep -v '\.test\.' | grep -i provider` → empty;
confirmed by `command grep`). Provider is therefore settable only via `ZONE_PROVIDER`,
`<repo>/.zone/model.json`, or `~/.zone/config.json`'s `defaultProvider`.

> **Status.** Superseded by `aa0711f0` (Option B step 1). `--provider <name>` is declared in
> `src/cli/index.ts`, wired through `CliOptions` and `buildCliFlags`, and covered by
> `index.optionsBoundary.test.ts`. Re-running this section's own four instruments at that commit
> returns three hits, not empty. Everything below is preserved as the measurement that motivated
> the flag, not as a description of the code today.

This is the exact shape of ledger item 258: `program.opts<CliOptions>()` asserts a hand-written
interface rather than checking it. Note also that `openaiClient.ts:107`'s own warning text tells the user
to *"Check --model / --provider / .zone/model.json consistency"* — naming a flag that does not exist.

---

## Q3 — Key handling

### 3.1 No production code branches on key format, prefix, or length — except two guards and one mask

```
$ git grep -nE '"sk-|sk-ant|startsWith\("sk' -- 'src/**'
$ command grep -rnE --exclude-dir={node_modules,dist,.git} --exclude=rankerBaseline.snapshot.json '"sk-|sk-ant|startsWith\("sk' src
```

Both return **only `*.test.ts` files**. There is no `sk-` check, no length check, and no provider
inference from key shape in any production path.

The complete set of format-sensitive decisions:

| Site | Rule | Effect on an unknown-format gateway key |
|---|---|---|
| `factory.ts:74` `assertApiKeyCharset` | `key.startsWith("<")` → `ApiKeyError` | Fine unless the key literally starts `<` |
| `factory.ts:80–89` | every char must be `0x20 ≤ cp ≤ 0x7e` | **Rejects a non-ASCII key.** Some corporate hubs issue base64url or JWT keys — both ASCII, so fine in practice; a UTF-8 key would be refused with a "likely a placeholder" message |
| `diskKeys.ts:67–78` `setDiskKey` | the same two checks, **duplicated** rather than shared | same |
| `diskKeys.ts:93–95` `maskKey` | `length <= 10 → "***"`, else `slice(0,7) + "***" + slice(-4)` | A short gateway key renders as `***` with no identifying prefix; a long one leaks its first 7 chars into the TUI list |

The error text is provider-shaped: `factory.ts:73` hardcodes
`{ openai: "sk-…", anthropic: "sk-ant-…" }` and interpolates it into both throw sites (`:77`, `:86`)
as "Set a real key (e.g. sk-…)". A third provider indexing that map gets `undefined` in the message.

### 3.2 Key *selection* is a provider ternary, repeated

The "which key do I use" decision is open-coded in five places, all the same shape:

- `cli/config.ts:195,197` — `validateCliConfig`
- `cli/dispatch.ts:120,124` — no-key pre-flight
- `cli/dispatch.ts:268` — plan-gen key
- `cli/dispatch.ts:697` — main run key
- `cli/dispatch.ts:892`, `:958` — headless and envelope-resume
- `memory/initFlow.ts:77` — `/init`

Plus `embeddings/embedFile.ts:23`, which reaches past the config layer entirely and pulls the OpenAI
key straight out of `~/.zone/keys.json` by provider name.

### 3.3 TUI affordances are two-valued by keypress

`ApiKeysView.tsx:32–33` is the provider chooser:

```tsx
if (input === "a" || input === "A") { dispatch({ type: "KEYS_PROVIDER_SELECTED", provider: "anthropic" }); return; }
if (input === "o" || input === "O") { dispatch({ type: "KEYS_PROVIDER_SELECTED", provider: "openai" }); return; }
```

`:95` renders `Select provider: [A]nthropic  [O]penAI  Esc cancel`. Rows are keyed
`key={entry.provider}` (`:81`), which assumes at most one entry per provider — consistent with the
store (§7). Input is masked to `"•".repeat(editInput.length)` (`:105`), so nothing about the key's
shape is visible while typing.

`ModelModal.tsx` filters rows by which providers have a key
(`visibleModelRows(USER_FACING_MODELS, state.providersWithKey, currentModelId)`, `:23`), and prints
`{hidden} hidden — no API key for that provider · /keys to add` (`:98`).

### 3.4 Persistence

`~/.zone/keys.json`, `0600`, atomic tmp+rename (`diskKeys.ts:57–64`). Full schema in Q7.

**One key per provider.** `setDiskKey` (`:80–83`) does `findIndex(k => k.provider === provider)` and
replaces in place. There is no way to store two keys for one provider, and therefore no way to store
a gateway key alongside a direct-vendor key **under the current key space**.

---

## Q4 — Model reference parsing, end to end

### 4.1 The chain

```
TUI /model  ──► ModelModal.tsx:39   entry.id from USER_FACING_MODELS  (catalog only — no free text)
                       │
CLI --model ───────────┤            cli/index.ts:1250 `-m, --model <id>`  (no validation)
ZONE_MODEL ────────────┤
<repo>/.zone/model.json┤            diskModel.ts:26 loadDiskModel
~/.zone/config.json ───┘            config.ts:64 defaultModel
                       ▼
              config.ts:109-111  explicitModel ?? "claude-sonnet-4-6"
                       ▼
              config.ts:124      isKnownModelId(explicitModel) ? getProviderForModel(…) : resolveProvider(…)
                       ▼
              dispatch.ts:276…   withRequestContext({ provider, modelOverride:{high,standard} })
                       ▼
              agentLoop.ts:4216  getModelName("high", client.provider, requestCtx?.modelOverride)
                       │            └─ openaiClient.ts:92-110  isValidModelId gate → provider default on miss
                       ▼
              adapter            params.model  ──► SDK body field  (never a URL segment)
```

**The TUI cannot name a gateway model.** `ModelModal` renders only `USER_FACING_MODELS`, built by
`buildModels()` (`modelRegistry.ts:133–151`) from the hardcoded `MODEL_CATALOG`. There is no
free-text entry. `modelPickerList.ts:48` already anticipates this: *"Returns 0 when the current id is
absent from the rows, which happens only for an id outside the catalog entirely (a custom `--model`)"*.

### 4.2 Every split, join, regex, or path derived from a model id

**The complete regex set is two patterns, both in one module:**

```ts
// src/llm/modelIdNormalize.ts:40,44
const ANTHROPIC_SNAPSHOT_SUFFIX = /-\d{8}$/;
const OPENAI_SNAPSHOT_SUFFIX    = /-\d{4}-\d{2}-\d{2}$/;
```

`normalizeModelId` applies both. It performs **no casing change, no trimming, no prefix stripping,
and no splitting** — its own module comment says so and calls itself "a lift, not a redesign".

**Prefix matching, not splitting**, is the lookup strategy in four functions:
`getContextWindow` (`models.ts:170–194`), `lookupMaxOutputTokens` (`:354–361`), `getCacheMinChars`
(`:387–393`), and `resolveUnverifiedKey` (`:321–328`). All four are `exact match → longest
`modelId.startsWith(key)` → default`. **A leading gateway prefix defeats `startsWith` completely**:
`"hub/anthropic/claude-sonnet-4-6".startsWith("claude-sonnet-4-6")` is `false`.

**One `startsWith` is a protocol router**, not a lookup: `openaiAdapter.ts:50,95` —
`normalizeModelId(params.model).startsWith("gpt-5")`.

**No filesystem path is derived from a model id.**

```
$ git grep -nE '(join|resolve)\([^)]*model' -- 'src/**'
src/api/diskModel.test.ts:38, src/api/diskModel.ts:23   ← both the fixed literal "model.json"
$ command grep -rnE --exclude-dir={node_modules,dist,.git} --exclude=rankerBaseline.snapshot.json '(join|resolve)\([^)]*[Mm]odel' src
   (same two, plus a theme test reading ModelModal.tsx by name)
```

Cost-log and usage filenames derive from `runId`/`userId`, never the model
(`usage/costLogger.ts:12`, `usage/usageTracker.ts:64`). **So `/` and `:` in a model id create no
path-traversal or filename hazard in Zone's own storage**, and no URL hazard either — `model` is a
JSON body field for both SDKs, not a URL segment.

### 4.3 Traced, not predicted — the two ids

Executed against built `dist/` (a script importing `dist/llm/{models,modelRegistry,modelIdNormalize,modelRouting}.js` and
`dist/usage/pricing.js` and calling each exported lookup on the four ids below). Controls in the last two
columns confirm the instrument is live.

| function | `hub/anthropic/claude-sonnet-4-6` | `hub/qwen2.5-coder:7b` | *ctl* `claude-sonnet-4-6` | *ctl* `claude-sonnet-4-6-20260219` |
|---|---|---|---|---|
| `normalizeModelId` | unchanged | unchanged | unchanged | → `claude-sonnet-4-6` |
| `getProviderForModel` | **`"anthropic"`** | **`"anthropic"`** | `"anthropic"` | `"anthropic"` |
| `isKnownModelId` | `false` | `false` | `true` | `false` |
| `isValidModelId(anthropic/openai)` | `false` / `false` | `false` / `false` | `true` / `false` | `false` / `false` |
| `supportsEffort` | `false` | `false` | `true` | `true` |
| `effortLevelsFor` | `[]` | `[]` | `[low,medium,high,max]` | `[low,medium,high,max]` |
| `resolveEffortForModel(…, "high")` | `undefined` | `undefined` | `"high"` | `"high"` |
| `usesAdaptiveThinking` | `false` | `false` | `false` | `false` |
| **`supportsVision`** | **`true`** | **`true`** | `true` | `true` |
| `lookupMaxOutputTokens` | `undefined` | `undefined` | `64000` | `64000` |
| `getMaxOutputTokens` | **`16384`** | **`16384`** | `64000` | `64000` |
| `getContextWindow` | **`200000`** + warn | **`200000`** + warn | `1000000` | `1000000` |
| `getCacheMinChars` | `8200` | `8200` | `8200` | `8200` |
| `nextStrongerModel("anthropic", …)` | `null` | `null` | `claude-opus-4-8` | `null` |
| `totalCost("openai", …, 1k/1k)` | **`0`** + warn | **`0`** + warn | `0` + warn | `0` + warn |
| `formatCostNote("openai", …)` | `undefined` | `undefined` | `undefined` | `undefined` |

Two warnings fire, verbatim:

```
[zone-context-window-fallback] {"modelId":"hub/qwen2.5-coder:7b","assumedContextWindow":200000,
  "impact":"compaction triggers at 75% of the assumed window; add this model to MODEL_CONTEXT_WINDOWS if its real window is larger"}
[zone-pricing] unknown model openai/hub/qwen2.5-coder:7b, cost=0
```

And through `loadCliConfig` (measured, §2.5's harness):

```
{"model":"hub/qwen2.5-coder:7b"}                      -> provider "anthropic"
{"model":"hub/qwen2.5-coder:7b","provider":"litellm"} -> provider "anthropic"   ← the flag is discarded twice over
{"model":"hub/anthropic/claude-sonnet-4-6"}           -> provider "anthropic"
```

**What that means end to end today.** Naming either id sends the request to **`AnthropicAdapter`**
— `getProviderForModel` defaults to `anthropic`, and `resolveProvider` cannot be talked out of it.
The Anthropic SDK then POSTs `model: "hub/qwen2.5-coder:7b"` to `api.anthropic.com`, which 404s or
400s on an unknown model. `mapAnthropicBadRequest` (`anthropicAdapter.ts:46`) would classify a 400
as `request_shape` and surface *"Invalid API request (…). Check model and parameter configuration."*
— **static reading only**; I did not issue a billed call to confirm the upstream status code.

Silent degradations that happen *before* that, all measured: effort dropped, output budget cut to
16 384, context window assumed at 200 000, cost recorded as **$0**, and **`supportsVision` returns
`true` for an unknown model** (`modelRegistry.ts:181`, "optimistic default") — so Zone would attach
images to a model it knows nothing about.

---

## Q5 — Capability metadata

All of it is **per-model**, hardcoded, in two files. None is per-provider, and none is negotiated or
inferred from the endpoint.

| Capability | Home | Lookup | Unknown model |
|---|---|---|---|
| Context limit | `MODEL_CONTEXT_WINDOWS` `models.ts:130–150` | exact → longest-prefix | `DEFAULT_CONTEXT_WINDOW = 200_000` (`:154`) + **`[zone-context-window-fallback]` once per id** (`:178–192`) |
| Output limit | `MODEL_MAX_OUTPUT_TOKENS` `models.ts:209–237` | exact → longest-prefix | `DEFAULT_MAX_OUTPUT_TOKENS = 16_384` (`:241`) — "smallest known ceiling so an unlisted ID can never 400 by over-asking". **Silent** |
| Tool-calling | **nowhere.** No `supportsTools` field exists in `ModelOption` (`models.ts:6–16`) or `ModelEntry` (`modelRegistry.ts:7–19`) | — | Assumed universally true; tools are sent to every model |
| Vision | `ModelOption.supportsVision?` (`models.ts:15`) via `supportsVision()` (`modelRegistry.ts:175–182`) | normalized exact scan of both catalogs | **`true`** — optimistic default, `:181`. Declared on **zero** catalog entries today, so the field is currently inert |
| Prompt caching (min size) | `MODEL_CACHE_MIN_CHARS` `models.ts:378–380` (one entry) | exact → longest-prefix | `DEFAULT_CACHE_MIN_CHARS = 8_200` (`:384`). **Silent** |
| Prompt caching (mechanism) | not a capability flag — `convertParams.ts:153–178` gates on `isCacheEligible(system, tools, model)` and applies `cache_control` unconditionally on the Anthropic path | — | An OpenAI-protocol gateway never receives `cache_control`; it receives `prompt_cache_key` instead, and only when `client.provider === "openai"` (`agentLoop.ts:4212–4214`) |
| Effort levels | `MODEL_EFFORT_LEVELS` `modelRegistry.ts:84–105` + `EFFORT_SUPPORTED_MODELS` `:21–47` | normalized **exact only** — no prefix fallback | `[]` → `resolveEffortForModel` returns `undefined` → **no effort sent, silently** (`:116`) |
| Adaptive thinking | `ADAPTIVE_THINKING_MODELS` `modelRegistry.ts:51–66` | normalized exact | `false` |
| Pricing | `PRICING_USD_PER_MTOK` `usage/pricing.ts:43–78`, `Record<ProviderName, Record<string, ModelRates>>` | exact → `normalizeModelId` retry (`:90–99`) | **`0`** + `console.warn("[zone-pricing] unknown model …, cost=0")` (`:109`) |
| Retention / ZDR | `ModelOption.retention` `models.ts:13` | catalog entry | absent → no badge |
| Escalation ladder | `ESCALATION_LADDERS` `models.ts:105–108` | `indexOf` | `-1` → `null`, no escalation |

**The pattern is consistent and mostly benign**: unknown models degrade to conservative defaults.
**Three exceptions are not benign**, and all three are silent:

1. **Cost is 0.** Per item 299 (which I did not re-derive but whose mechanism I reproduced above),
   the `--max-budget-usd` gate compares this run's accumulated cost every iteration
   (`agentLoop.ts:4108–4110` — verified at HEAD; item 299 cites `:4099`, which has since drifted),
   so a $0 means it **never fires**; the daily cap
   under-reports into the ledger and weakens the gate for *subsequent* runs.
2. **Vision defaults true**, so images are sent to a model with no declared support.
3. **Effort is dropped silently** while `[zone-effort-clamped]` fires only on a *clamp*, not on a
   *drop* (`modelRegistry.ts:116` returns before the warn at `:128`).

---

## Q6 — Streaming and tool-call assembly

### 6.1 Nobody parses SSE

```
$ git grep -nE 'text/event-stream|EventSource|parseSSE' -- 'src/**'
src/core/developerRunProgressSse.ts:170:  const sse = `data: ${body}\n\n`;     ← Zone's OWN outbound progress SSE
$ command grep -rnE --exclude-dir={node_modules,dist,.git} --exclude=rankerBaseline.snapshot.json \
    'text/event-stream|EventSource|parseSSE' src
   (empty)
```

Both SDKs own wire-level SSE. Zone consumes typed async iterables. **The gateway consequence is
good news**: an OpenAI-compatible gateway's SSE framing is the OpenAI SDK's problem, and the SDK
handles it.

### 6.2 Three independent tool-call merge implementations, keyed differently

| # | Site | Keyed on | Opens an entry when | Notes |
|---|---|---|---|---|
| 1 | `anthropicAdapter.ts:186–208` (`_streamWithToolCallbacks`) | **`tc.index ?? 0`** into `Map<number,…>` | `tc.id && tc.function?.name !== undefined` | Consumes `convertStream`'s already-OpenAI-shaped chunks. Correct for parallel calls |
| 2 | `planFullPatch.ts:783–799` | **nothing — flat accumulator** | any `tc.id` overwrites `toolCallId`; any name overwrites `toolCallName` | `index` is never read. Parallel tool calls would concatenate into one `argsAccum` |
| 3 | `agentLoop.ts:1953–1978` (`extractFunctionCallItems`) | n/a — non-streaming | requires `t.type === "function" && typeof t.id === "string" && typeof t.function.name === "string" && typeof t.function.arguments === "string"` | **Strict**: a tool call missing `type:"function"` is silently dropped |

`convertStream.ts:76` assigns its own monotonic `nextToolIndex++` per `content_block_start`, so
Anthropic's block indices are re-numbered into OpenAI's tool-call index space before #1 sees them.

**Keyed on protocol or provider?** #1 and #3 are keyed on **protocol** (the OpenAI chunk/message
shape) and work for any gateway that emits it. #2 is protocol-keyed but *lossy*. The only
provider-keyed line in this area is `recordingClient.ts:158–167`.

### 6.3 What the streaming code assumes

| Assumption | Where | Holds for a gateway? |
|---|---|---|
| `delta.tool_calls[].index` is present and stable | `anthropicAdapter.ts:191` (`tc.index ?? 0`) | **Degrades silently.** A gateway omitting `index` collapses all parallel calls onto slot 0. The `?? 0` makes it a wrong answer rather than a crash |
| Arguments arrive across **many** chunks | all three merges accumulate with `+=` | Yes — one-chunk delivery is the degenerate case and works |
| The **first** tool_calls entry carries both `id` and `name` | `anthropicAdapter.ts:192–194` | A gateway that sends `name` in a later delta than `id` never opens the map entry, and every subsequent `argFrag` is dropped (`entry` is undefined at `:196`) |
| Usage arrives in a final **empty-choices** chunk | `anthropicAdapter.ts:161–172`, `recordingClient.ts:176–184`, synthesised by `convertStream.ts:203–219` | `recordingClient.ts:158–167` requests it via `stream_options.include_usage` **only when `this.provider === "openai"`**. A gateway adapter reporting a non-`openai` provider gets **no usage and therefore no cost record** |
| `finish_reason` ∈ `{stop, length, tool_calls, content_filter}` | consumed at `agentLoop.ts:5582`, `:5636` (`"length"` → auto-continuation) and `:5679` (`"content_filter"` → refusal); produced by `convertStopReason` (`convertResponse.ts:14–31`) | An unrecognised value is treated as "not length, not content_filter" — no continuation, no refusal branch. Fails soft |
| Tool arguments are valid JSON | `agentLoop.ts:4641–4652` | `JSON.parse` failure is caught, emits `[zone-tool-args-parse-failed]`, and feeds the model a `TOOL_ARGS_TRUNCATED` coaching message. Handled |

---

## Q7 — Credentials and blast radius

### 7.1 What `/keys` writes

```jsonc
// ~/.zone/keys.json   —  0600, atomic tmp+rename (diskKeys.ts:57-64)
{
  "version": 1,
  "keys": [
    { "provider": "anthropic", "key": "…", "addedAt": "2026-01-01T00:00:00.000Z" }
  ]
}
```

Types at `diskKeys.ts:5–16`. Path is `_keysFilePathOverride ?? join(homedir(), ".zone", "keys.json")`
(`:27–29`) — resolved **at call time**, so the test-home redirect works. On ENOENT, a one-time
migration reads `<cwd>/.zone/keys.json` and re-saves to the home path, logging `[zone-keys-migrated]`
(`:43–51`).

Adjacent, and separately relevant because the picker writes it:

```jsonc
// <repoPath>/.zone/model.json   —  0600, atomic (diskModel.ts:53-61)
{ "version": 2, "model": "claude-opus-5", "provider": "anthropic", "effort": "max", "updatedAt": "…" }
```

Note this is **per-repo**, not `~/.zone/` — `modelPath(cwd)` is `join(cwd, ".zone", "model.json")`
(`diskModel.ts:22–24`) and every writer passes `process.cwd()` (`ModelModal.tsx:44`,
`EffortModal.tsx:45`, `Composer.tsx:407,423`, `PlanModeModal.tsx:37`, `SessionMemoryModal.tsx:45`,
`SummaryModal.tsx:37`). `CLAUDE.md` currently describes it as `~/.zone/model.json`; that is stale.
Verified incidentally during this pass — the repo's own `.zone/model.json` leaked into an early
config trace, which is how it was noticed.

### 7.2 What a schema change costs

Both loaders **fail closed on a version mismatch, and only one of them says so.**

| File | Loader | On unexpected version |
|---|---|---|
| `keys.json` | `loadDiskKeys` `diskKeys.ts:36–38` | returns `{version:1, keys:[]}` — **silently**. Every key appears to have vanished |
| `model.json` | `loadDiskModel` `diskModel.ts:31–34` | returns `null` + `console.warn("[zone] .zone/model.json has unexpected version …; ignoring.")` |
| `model.json` | `loadDiskModelSync` `diskModel.ts:46` | returns `null` — **silently**, no warn. This is the one `loadCliConfig` uses (`config.ts:107`) |

So the blast radius of a **version bump** is asymmetric and unpleasant:

- **Bumping `keys.json` to `version: 2`** makes every *older* Zone binary on the machine report "No
  keys. N to add one." with no explanation, and `validateCliConfig` then throws *"No API key found
  for provider anthropic"*. Downgrade is not survivable. A user with two Zone installs (npm global +
  a checkout) hits this immediately.
- **Bumping `model.json` to `version: 3`** silently reverts the user's model, provider, effort, plan
  depth, autocommit and session-memory settings to defaults, because `loadDiskModelSync` has no warn
  branch.

**The cheap alternative, available at zero migration cost**: both schemas are additive-friendly.
`DiskApiKey` gains optional fields without a version bump, because the loader validates only
`version === 1 && Array.isArray(keys)` and casts. An older binary reading a record with extra fields
ignores them. **The constraint that actually bites is not the schema version — it is the
`provider` field's type and its uniqueness.** `ApiKeyProvider = "anthropic" | "openai"`
(`diskKeys.ts:5`) plus `findIndex(k => k.provider === provider)` (`:80`) means one key per provider,
and any gateway needs either a widened `provider` value or a second identity field.

An older binary reading a `keys.json` that contains `{"provider":"gateway", …}` would: load it fine
(no per-entry validation), render it in `ApiKeysView` (which prints `entry.provider` as free text at
`:83`), and never select it, because every selector compares against a literal. **No crash, no data
loss — the row is simply inert.** That is the friendliest possible failure and it makes a widened
`provider` value cheaper than it looks.

---

## Where the seam would go

Restating the layers by *what they actually vary by*:

### Already protocol-shaped — could be unfused from provider identity today

| Layer | Why it is already generic |
|---|---|
| `LLMClient` interface (`types.ts:67–87`) | Typed in OpenAI Chat Completions shapes. A gateway speaking that protocol needs **no** interface change |
| `OpenAIAdapter` request construction | Two transforms (`max_tokens`, `reasoning_effort`), both harmless to a gateway. The Responses branch is already gated on `this.provider === "openai"` and **proven off by a test** (`openaiAdapter.responses.test.ts:125`) |
| `OpenAIAdapter` transport | `baseURL` parameter already exists and is already wired to the SDK (`:23`, `:38`) |
| `classifyError` / `withExponentialBackoff` | Accepts both SDKs' error classes, has a `status >= 500` catch-all, and never branches on `provider` |
| SSE handling | Delegated to the SDK entirely |
| Tool-call merge #1 and #3 | Keyed on the OpenAI chunk/message shape |
| `usageTracker` aggregation | `byProvider[r.provider]` is string-keyed with a `??` default (`:197`) — a third provider aggregates correctly with no change |
| `webSearchWarning.ts` | **The existing idiom for this problem.** Takes `provider: string`, not the union, and degrades with a message naming the actual provider (`:9,12`). This is the shape every other site should have |

### Genuinely provider-specific — must stay branched

| Layer | Why |
|---|---|
| `AnthropicAdapter` + `convertParams`/`convertResponse`/`convertStream` | Real protocol translation. ~800 lines. Not reusable for a gateway and not the problem |
| Anthropic prompt caching (`cache_control`, two breakpoints, `getCacheMinChars`) | Vendor mechanism with a vendor-specific request shape |
| Adaptive thinking / `budget_tokens` / `output_config.effort` | Vendor-specific |
| Provider-native `web_search_20250305` | Appended post-translation, Anthropic-only |
| `prompt_cache_key` | OpenAI-specific, already gated |
| Embeddings | `AnthropicAdapter.createEmbedding` throws (`anthropicAdapter.ts:308–311`); `embedFile.ts:83` skips when `client.provider !== "openai"` |

### The seam, named

**The seam is between "which wire protocol" and "which vendor".** Zone currently fuses them into a
single two-valued `LLMProvider`. Every fact above says the split is:

- **protocol** ∈ `{anthropic-messages, openai-chat, openai-responses}` — decides the adapter class
  and the conversion modules;
- **endpoint identity** — decides base URL, credential, capability table, and pricing table.

`OpenAIAdapter`'s constructor already takes both (`apiKey, baseUrl, provider`) and already uses
`provider` as a *protocol sub-selector* rather than a vendor name. It is the only place in the
codebase where the two concepts are already separate. **The seam is there and it is one argument
wide; what is missing is a caller that passes it.**

---

## Implementation options

### Option A — Widen `LLMProvider` to include one `"openai-compatible"` member

**Shape.** Add a third union member. `factory.createLLMClient` builds
`new OpenAIAdapter(key, gatewayBaseUrl, "openai-compatible")`. Base URL and key come from a new
optional `gateway` block in `~/.zone/config.json` and a new `keys.json` provider value.

**Files touched.** `llm/types.ts:9`; `llm/factory.ts:36–52` + `:72–90` (charset guard's `examples`
map); `cli/config.ts:86–88` (`resolveProvider`), `:124–134`, `:136–137` (key fields), `:195–197`;
`api/diskKeys.ts:5`; `api/diskModel.ts:12`; the nine other structurally-identical unions item 297
enumerates; `llm/modelRouting.ts:10,47–53`; `llm/openaiClient.ts:78–113`; `llm/models.ts:29,105`
(`Record<LLMProvider, …>` — **compiler-enforced**, will fail loudly); `usage/pricing.ts:10,43`
(same); `cli/tui/App.tsx:117`; `cli/tui/components/ApiKeysView.tsx:30–33,95`;
`cli/tui/components/ModelModal.tsx:57`; `cli/dispatch.ts` ×6; `llm/agentLoop.ts:2250,3564,4213`;
`llm/subagentDispatch.ts:124`; `tools/toolExecutor.ts:1117`; `llm/taskClassifier.ts:303,433,555`;
`llm/recordingClient.ts:90–93,159`; `embeddings/embedFile.ts`; `memory/initFlow.ts:77`.

**What breaks for existing installs.** Nothing on disk — `keys.json` and `model.json` stay
`version: 1`/`2` and gain a new legal `provider` value additively. An older binary encountering a
gateway row renders it and ignores it (§7.2). **Zero migration.**

**What it leaves unsolved.** The 36 class-B branch sites still compile clean and still mis-route:
item 297's Probe B widened all eleven provider types at once and produced **4** errors, all
`Record<Union,…>` exhaustiveness in data tables, and **zero** at any branch site or cost-laundering
point. So this option produces a large, mostly-silent edit surface: the compiler will find the three
tables and nothing else. Capability and pricing lookups still miss (Q4/Q5). One gateway at a time —
`"openai-compatible"` is a single slot, so LiteLLM *and* OpenRouter cannot coexist.

### Option B — Introduce a `ProviderProfile` record; keep `LLMProvider` as the protocol selector

**Shape.** A profile is `{ id, protocol: "anthropic-messages"|"openai-chat", baseUrl?, keyRef,
capabilities?, pricing? }`. Built-in profiles `anthropic` and `openai` reproduce today's behaviour
byte for byte. `LLMProvider` is **renamed in meaning, not in type** — it becomes the protocol
selector, which is what `OpenAIAdapter`'s third parameter already treats it as. Resolution collapses
into one `resolveProfile()` that the six-and-six defaulting sites delegate to. Capability lookups
gain a per-profile override consulted before the global tables. `webSearchWarning`'s
`provider: string` + graceful-degrade idiom is generalised to the other seven capability gates.

**Files touched.** New `src/llm/providerProfile.ts`. Rewired: `llm/factory.ts` (the whole file);
`cli/config.ts:86–137,195–197`; `llm/models.ts:170,354,387` (accept an optional profile);
`usage/pricing.ts:90–99`; `llm/modelRegistry.ts:107,153`; `llm/openaiClient.ts:78–113`;
`llm/modelRouting.ts:47`; `cli/dispatch.ts` ×6 key ternaries; `api/diskKeys.ts` (key identity);
`api/diskModel.ts:12`; `cli/tui/components/ApiKeysView.tsx`, `ModelModal.tsx`,
`cli/tui/modelPickerList.ts`. Plus a `--provider` flag in `cli/index.ts`, which **does not exist
today** (§2.6) — *superseded by `aa0711f0`, which added it* — and which every option needs.

**What breaks for existing installs.** `model.json`'s `provider` field must map onto a profile id;
keeping `"anthropic"`/`"openai"` as built-in ids means **nothing breaks and no version bump is
needed**. `keys.json` needs a key identity that is no longer "one per provider" — the cheapest form
is an optional `profileId` alongside the existing `provider`, so old records keep working.

**What it leaves unsolved.** Anthropic-protocol gateways (Bedrock, Vertex) still need a `baseURL` on
`AnthropicAdapter`, which it does not have. Per-profile capability tables are a new maintenance
surface with no source of truth. It is the largest edit of the three and touches provider resolution,
which is the subsystem the ledger explicitly declined to redesign (item 298: *"no remedy is proposed,
and that is the honest bucket"*).

### Option C — Environment-only escape hatch, no type change

**Shape.** `ZONE_OPENAI_BASE_URL` (+ optional `ZONE_OPENAI_EXTRA_HEADERS`) read in
`factory.createLLMClient` and passed as `OpenAIAdapter`'s existing second argument. The user selects
`provider=openai` and `--model <gateway-id>`. No union changes, no disk-schema changes.

**Files touched.** `llm/factory.ts:41–43` (one line plus an env read); `llm/openaiClient.ts:94`
(`isValidModelId` gate must not reject an off-catalog id when a base URL is set — otherwise
`getModelName` warns and swaps the model out from under the user); optionally
`llm/models.ts:170,354` for capability fallbacks. **Realistically three files.**

**What breaks for existing installs.** Nothing. No new value reaches disk.

**What it leaves unsolved.** Almost everything Q4 and Q5 measured. Cost is still `$0` and
`--max-budget-usd` still never fires. Context window is still assumed 200k, output still 16 384,
effort still silently dropped, vision still optimistically `true`. `web_search` is still advertised
as enabled and silently unavailable. The TUI picker still shows no gateway model. `/keys` still has
no `[G]ateway` option, so the key must come from `OPENAI_API_KEY`. And the provider *displayed* in
the status bar and recorded in the usage ledger says `openai` for a run that never touched OpenAI —
laundering the very attribution that item 299 is about.

---

## Open unknowns that block a decision

| # | Unknown | Why it blocks | Cheapest instrument |
|---|---|---|---|
| 1 | Does `OpenAIAdapter` + `baseURL` actually work against a real gateway end to end? Everything above is static plus unit-level. | If the SDK's `baseURL` handling, the dispatcher, or `stream_options` misbehaves against a non-OpenAI host, Option C's three-file estimate is wrong. | **Closed** — see "Harness results — unknowns 1-3 closed" below. Run a local LiteLLM proxy (or `llama.cpp --server`), then one Node script: `new OpenAIAdapter(key, "http://127.0.0.1:4000/v1", "openai-compatible")` → `createChatCompletion` with one tool. ~20 min, $0. |
| 2 | Do real gateways emit `delta.tool_calls[].index`? | §6.3 shows `?? 0` collapses parallel calls silently if not. Decides whether merge #1 needs hardening. | **Closed** — see "Harness results — unknowns 1-3 closed" below. Same harness, prompt for two parallel tool calls, log raw chunks. |
| 3 | Does the gateway return usage in a final empty-choices chunk when `stream_options.include_usage` is set? | `recordingClient.ts:158–167` only *requests* it for `provider === "openai"`. If gateways need it too, that gate is a bug for every option. | **Closed** — see "Harness results — unknowns 1-3 closed" below. Same harness; assert `lastUsage !== null`. |
| 4 | What does an unknown-model 400 from `api.anthropic.com` actually look like? | Q4's end-state ("Invalid API request …") is **static reading only**. It determines whether today's failure is legible enough to leave alone. | One billed call with `model: "hub/qwen2.5-coder:7b"` — cents. Requires a working Anthropic balance; `models.ts:210` records the account's credit as exhausted, which is the same blocker that stalled the Opus 5 probes. |
| 5 | Is a *single* gateway slot enough, or must several coexist? | Decides A vs B outright. Option A cannot hold two gateways; Option B is over-built for one. | Ask. This is a product question, not a code question. |
| 6 | Should a gateway inherit the current capability defaults or require explicit declaration? | Decides whether Option B's per-profile capability table is mandatory. The measured defaults are conservative except vision and cost. | Decide, then encode. No instrument needed. |
| 7 | Does `assertApiKeyCharset`'s ASCII-only rule reject any real gateway key? | A hard `ApiKeyError` at `factory.ts:83` would block adoption entirely. | Collect one sample key from each target gateway and run the two guards. Low effort, needs external input. |
| 8 | Does Zone's own tool-call merge handle a gateway's parallel calls correctly? `planFullPatch.ts`'s flat accumulator never reads `index`. | Decides whether merge hardening is part of Option B or a separate fix. | Same LiteLLM harness, but driven through the path that reaches `planFullPatch.ts`, asserting on the merged tool calls rather than raw chunks. |
| 9 | ~12 TUI settings-persistence sites (`Composer.tsx`, `store-core.ts`, `EffortModal.tsx`, `PlanModeModal.tsx`, `SessionMemoryModal.tsx`, `SummaryModal.tsx`, and others) hardcode `provider: "anthropic"` as one arm of a ternary building a `.zone/model.json` object literal when no current model is set. §2.4's AST walk matches a provider literal as a ternary's own arm, not one nested inside an object-literal field — so these sites sit outside its twelve-site count, and outside the characterization baseline `docs/deferred-work.md` item 386 established for those twelve. | A `ProviderProfile` refactor changes provider-defaulting sites by definition; these ~12 have no characterization test and no confirmed reachability check (whether they fire only when `state.modelSettings`/`currentModel` is unset, or are otherwise effectively dead, is unconfirmed) — the refactor could touch them with no written baseline to diff against, the same gap item 386 exists to close for the other twelve. | A grep sweep for `provider: "anthropic"` inside object literals across `src/cli/tui/**/*.tsx` and `store-core.ts`, then read each site to confirm reachability and add characterization tests the same way item 386 did for the twelve — no instrument beyond reading needed. |

Unknowns 1–3 share **one** instrument. Building it is the highest-value next action regardless of
which option is chosen.

---

## Inferences — separated from findings

Everything above is a measurement or a citation. The following are **judgements**, and none of them
was tested.

1. **The `provider` parameter on `OpenAIAdapter` looks like deliberate preparation.** It was added
   alongside the Responses API work as a guard, and it happens to be exactly the right shape for a
   protocol selector. I have no commit-level evidence that a gateway was intended, and the dead
   `getHostedInferenceBaseUrl` suggests the `baseUrl` parameter is a leftover from a hosted-service
   design rather than a gateway one.
2. **The silent `resolveProvider` coercion is likely the single worst-felt defect** *(superseded by
   `aa0711f0`: the coercion is no longer silent — see §2.5's status note)*, because it makes
   every gateway configuration attempt fail in the same confusing way: the user sets a provider, sees
   no error, and gets an Anthropic 400 about a model they never named. This is a judgement about user
   experience, not a measurement.
3. **Option A's real cost is the 36 class-B sites, not the union edit.** Item 297's Probe B is strong
   evidence the compiler will not find them, so each would have to be read and judged by hand. I did
   not attempt that triage, so "most of them are harmless" is a guess, not a finding.
4. **`webSearchWarning.ts` is probably the intended house style** for provider-conditional
   capabilities — `provider: string`, degrade with a message naming the actual value. It is the only
   site written that way, so calling it "the idiom" is an inference from one instance.
5. **Cost attribution is likely the hard blocker for any gateway, not routing.** Routing has a
   one-argument fix; a gateway has no published per-model rate table Zone can consult, and
   `--max-budget-usd` is only as good as `totalCost`. I did not investigate whether gateways return
   cost in their responses (several do, in `usage` extensions), which would be the natural fix.

---

## RECOMMENDATION

*This section is a recommendation, not a finding.*

**Do Option C first as a spike, then Option B — and do not ship Option A.**

**Why not A.** It costs almost as much as B (the union appears in eleven declarations and 36 branch
sites), the compiler surfaces only three of those, and it buys a single gateway slot. It also
entrenches the fusion of protocol and vendor identity that is the actual defect. A widened
`LLMProvider` would have to be widened again for the second gateway.

**Why C first, but only as a spike.** It is three files and answers unknowns 1–3, which are the only
unknowns that can invalidate the design. Ship it **behind an env var and documented as
experimental**, precisely because its silent-degradation list (§Option C) is long enough that it
should not become the supported path. Two specific guards belong in the spike:

- `openaiClient.ts:94`'s `isValidModelId` gate must be bypassed when a gateway base URL is set —
  otherwise `getModelName` warns and silently substitutes `gpt-4o`, and the spike measures the wrong
  thing.
- Emit **one loud line** naming the base URL, the model, and the fact that cost recording is
  disabled — so a spike run can never be mistaken for a supported one.

**Then B, in this order**, each step independently shippable:

> **Progress.** Steps 1 and 2 are **DONE** (`aa0711f0`). Step 3's stated prerequisite — pinning
> current behaviour first — is **DONE** (`368e01e7`, ledger item 386), and step 3 itself is
> **DONE** (ledger item 387; the commit that added `src/llm/providerProfile.ts` —
> `git log --diff-filter=A -- src/llm/providerProfile.ts`). Step 4 is **DONE** (ledger item 392).
> Step 5 and the Option C spike remain open, and step 5 has gained the vision fix (item 394).
> Each step's text below is left as written; the status markers are appended, not substituted.

1. **[DONE — `aa0711f0`] Add `--provider` to commander** (`cli/index.ts`). It is referenced by an existing warning
   message and does not exist. One line, no design required, and it makes every later step testable
   from the CLI.
2. **[DONE — `aa0711f0`] Make `resolveProvider` loud** (`config.ts:86–88`). An unrecognised value must warn naming the
   value, the way the model/provider conflict already does at `:127`. This is a bug fix on its own
   merits.
3. **[DONE — see item 387; prerequisite `368e01e7`] Introduce `ProviderProfile`** with built-in `anthropic` and `openai` profiles that reproduce
   current behaviour exactly, and route the six-and-six defaulting sites through one resolver.
   Pin the current behaviour with tests *before* the refactor — the defaults disagree today, so
   "preserve current behaviour" needs a written-down baseline or the refactor will silently pick a
   winner.
   *As built:* `src/llm/providerProfile.ts` is the record and the one resolver; each site passes its
   OWN fallback so the six-and-six split is preserved rather than unified by accident. Eight sites
   route through it, two lane-crossing conversions are deleted, and two constructor/parameter
   defaults are deliberately left alone because they already are the protocol selector. The
   step-4 pricing warning was pulled forward in reduced form: a profile with no pricing table now
   records cost as unknown rather than `$0`. See ledger item 387 for what was NOT done.
4. **[DONE — see item 392] Give profiles optional capability and pricing overrides**, consulted before the global tables.
   Make a missing pricing entry on a *gateway* profile a startup warning rather than a silent `$0`
   — the daily and per-run gates depend on it. *(The startup-warning half of this landed early with
   step 3; the capability and pricing OVERRIDE tables remain open — `ProviderProfile.capabilities`
   is declared and unpopulated.)*
   *As built:* `ModelCapabilities` (`llm/types.ts`) declares six per-model fields and
   `ProfileCapabilities` (`llm/providerProfile.ts`) carries them per profile, matched EXACTLY on the
   model id. Resolution is override → global table → conservative default at every site. Reaching
   the adapter-side capabilities required a per-call `capabilities` field on `LLMRequestOptions`
   rather than a constructor argument, because both adapter constructors have their argument lists
   pinned by assertions. Four of the six are verified against an outgoing request body; `contextWindow`
   never appears in one and is verified at its accessor; `supportsVision` is declared and
   deliberately NOT consumed — see step 5. Pricing gained inline per-model rates consulted before the
   named table. Both warn-once helpers are now reachable, driven through `createLLMClient` and
   `runAgentLoop`.
5. **Widen the key store's identity** to `{ provider, profileId? }`, additively, no version bump.
   Add `[G]ateway` to `ApiKeysView` and free-text model entry to `ModelModal`.
   **Also in this step's scope, moved here from step 4:** correct `supportsVision`'s optimistic
   `true` default for unknown models, AND thread profile capabilities into the composer's image gate
   in the same change. These two halves must land together — flipping the default alone blocks
   images for exactly the unlisted-model users a gateway profile serves, with no override path,
   because the composer has no profile in scope. Ledger item 394 records the measurement and the
   coupling.

**Explicitly out of scope for all of the above**: a `baseURL` on `AnthropicAdapter`. Anthropic-protocol
gateways (Bedrock, Vertex) are a separate problem with separate auth (SigV4, GCP tokens), and folding
them in would put credential-shape variation into a design that currently has none.

**The one thing to do before any of this**: build the local-gateway harness from unknowns 1–3. It is
~20 minutes and $0, and it can invalidate the protocol assumption that every option above rests on.

---

## Harness results — unknowns 1-3 closed

**Instrument.** A local LiteLLM 1.98.0 proxy in front of an OpenAI upstream, model
`openai/gpt-4o-mini`. One gateway, one upstream: everything below is an observation about this
specific pairing, not a demonstrated property of gateways in general.

### Unknown 1 — adapter reachability

`OpenAIAdapter(key, baseUrl, "openai-compatible")` reaches the gateway: the proxy logged
`POST /v1/chat/completions 200`. The Responses branch stayed off. **Instrument.** LiteLLM's own
request log.

`"openai-compatible"` is not a valid `LLMProvider` value in `src/` today — `src/llm/types.ts:9` is
`"openai" | "anthropic"` only; Option A proposes widening it to include exactly this value. The
harness imported the built `dist/llm/openaiAdapter.js` and called it with the third constructor
argument cast as `"openai-compatible" as never`, bypassing the type checker rather than satisfying
it — stated here as the actual mechanism, not left as an unstated "somehow". The measurement still
holds despite the cast: at runtime `provider` is only a stored string, compared with `=== "openai"`
at every branch point that reads it (the Responses-branch guard in `openaiAdapter.ts`, the
`include_usage` guard in `recordingClient.ts` below); what this closes depends on the value being
anything other than `"openai"`, not on `"openai-compatible"` specifically.

### Unknown 2 — parallel tool-call indices

Parallel tool calls carry `delta.tool_calls[].index`, stable and zero-based; the first delta of each
call carries `id` and `name` together. **Instrument.** Two independent instruments agreed: raw curl
against the SSE stream, and the adapter's own chunk stream.

The `?? 0` fallback at `anthropicAdapter.ts:191` was not exercised — and not merely because this
run's indices happened not to need it. That line lives inside `AnthropicAdapter`'s own
translated-stream consumer (`_streamWithToolCallbacks`, §6.2's row 1), which renumbers Anthropic's
native `content_block_start` events into this same index space via `convertStream.ts`'s own counter;
it is unreachable from the `OpenAIAdapter` path this harness exercises at all. Per §1.2, the OpenAI
adapter path does no tool-call assembly of its own — chunks are returned raw.

So this harness measured what the gateway puts on the wire, not how Zone merges it. The index
observation is about the wire; it says nothing about Zone's own merge behavior against a gateway.
The merge that would actually run is whichever of §6.2's other two implementations receives the raw
chunks: `planFullPatch.ts:783–799` (flat accumulator — `index` is never read; parallel calls would
concatenate into one `argsAccum`) for a streaming call, or `agentLoop.ts:1953–1978`
(`extractFunctionCallItems`, non-streaming) for a non-streaming one. Both are reachable from
`OpenAIAdapter`'s output; neither was reached by this harness. Their behavior against a real
gateway's parallel tool calls is **unmeasured** — not a claim that they are broken.

### Unknown 3 — usage reporting

The adapter does not send `stream_options.include_usage`, so no usage chunk arrives and the stream
ends at `finish_reason: "tool_calls"`. Raw curl WITH the flag set did receive usage, in a final chunk
carrying one choice with an empty delta — note that shape, since it is not an empty `choices` array.
**Instrument.** Raw curl, once with the flag and once without.

### Cost accounting — not one of the tracked unknowns

`x-litellm-response-cost` is correct on non-streaming requests (reproduced twice) and `0.0` on
streaming ones. `/spend/logs` records both correctly, written asynchronously. **Instrument.** The
proxy's own response header and its `/spend/logs` endpoint.

An earlier reading of `/spend/logs` appeared to show the streaming calls missing — the query sliced
the last three array elements from an unsorted response; sorted by `startTime`, the streaming calls
were present with correct spend.

### Consequence

On a gateway, no usage reaches Zone and the streaming cost header is zero, so `totalCost` stays `0`
and `--max-budget-usd` never fires. `recordingClient.ts:158–167` gates `include_usage` on
`provider === "openai"`; that gate is protocol-shaped, not vendor-shaped.
