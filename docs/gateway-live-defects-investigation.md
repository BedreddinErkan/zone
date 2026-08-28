# Gateway live-defects investigation

Two defects reported from live use against the adesso AI hub (an OpenAI-compatible endpoint serving
`qwen-3.8-27b-sovereign`). Read-only pass: no source changed, no ledger entry added.

Investigated at `560ea54b` (2.2.0, the gateway support arc).

---

## Evidence base, and one bound on it

Absence claims below are shown with **both** instruments — the shell `grep` function (ugrep, skips
gitignored trees) and `git grep` — and each carries a positive control, because an absence check
against a broken instrument passes vacuously. Claims established only by reading code are marked
**static reading only**. Everything else was executed.

**The bound:** the runs being investigated did not happen against this machine's `$HOME`.

```
~/.zone/keys.json  → version 1, 2 rows:
    provider=anthropic  fields=["provider","key","addedAt"]  addedAt=2026-05-24
    provider=openai     fields=["provider","key","addedAt"]  addedAt=2026-06-11
~/.zone/markers.jsonl   last written 2026-08-25 01:37
~/.zone/cost-logs/      newest        2026-08-23 16:17
~/.zone/sessions/       newest        2026-08-23 14:41
gateway arc committed   2026-08-27 → 2026-08-28
```

No `adesso` row exists, no row carries a `baseUrl`, and `grep -ril adesso` over `~/.zone/`,
`<repo>/.zone/` and the tracked tree returns nothing. Every Zone artifact on this box predates the
gateway arc. So the marker sink — which would otherwise have held the whole aborted run, since
`stdoutShield.ts:23` writes every marker to `markers.jsonl` *regardless of verbosity* — has nothing
to contribute here. **The single most valuable artifact for Defect 2 is `~/.zone/markers.jsonl` on
the machine where the run actually happened.** It is already on disk there; nothing needs to be
re-run to obtain it.

This bound does not weaken the findings. Both defects are properties of the code, and Defect 1 was
reproduced end to end against a synthetic key store.

---

## Defect 1 — a gateway key cannot be replaced from the TUI

### Finding — the key updates correctly; the row stops being a gateway

**The reported symptom is real but the reading of it is not.** The key is written correctly, exactly
one row exists afterwards, and no duplicate is created. What is destroyed is everything else on the
row: `baseUrl`, `protocol`, `label` and `pricing` are all dropped, which silently demotes the gateway
profile to a plain vendor-key row.

Measured, not read — driving the built `dist/api/diskKeys.js` and `dist/llm/gatewayProfiles.js`
against a temp store seeded with a fully-configured gateway row:

```
BEFORE  adesso keys: ["provider","key","addedAt","baseUrl","protocol","label","pricing"]
        isGatewayRow: true    gatewayProfilesFrom: ["adesso"]

AFTER   adesso keys: ["provider","key","addedAt"]
        isGatewayRow: false   gatewayProfilesFrom: []

key updated?           true
duplicate row?         false
baseUrl survived?      false
pricing survived?      false
anthropic row intact?  true
```

### The trace, end to end

1. **`ApiKeysView.tsx:87`** — `E` on the selected row dispatches `KEYS_START_EDIT`.

2. **`store-core.ts:953-954`** — the reducer sets `keysEditMode: "input"`, `keysEditProvider`, and
   `keysEditInput: ""`. It does **not** touch `keysDraftBaseUrl`. Every other action that reaches
   this mode does: `KEYS_GATEWAY_URL_SUBMIT` (`:984`) sets it, and `KEYS_OPEN` (`:936`),
   `KEYS_START_ADD` (`:951`), `KEYS_INPUT_CANCEL` (`:966`) and `KEYS_GATEWAY_START` (`:971`) all
   clear it. Since the modal is entered through `KEYS_OPEN`, `keysDraftBaseUrl` is `""` when `E` is
   pressed. There is no path on which it is anything else.

3. **`ApiKeysView.tsx:147-148`** — the save reads that field as the sole signal for "is this a
   gateway":

   ```ts
   const savedGatewayId = draftUrl ? editProvider : null;
   void setDiskKey(editProvider, editInput.trim(), draftUrl ? { baseUrl: draftUrl } : undefined)
   ```

   `""` is falsy, so `extras` is `undefined` and `savedGatewayId` is `null`.

4. **`diskKeys.ts:151-165`** — `setDiskKey` builds a **fresh** entry and assigns it over the old one.
   It never reads `store.keys[idx]`:

   ```ts
   const entry: DiskApiKey = {
     provider, key, addedAt: new Date().toISOString(),
     ...(extras?.baseUrl  ? { baseUrl: extras.baseUrl }   : {}),
     ...(extras?.protocol ? { protocol: extras.protocol } : {}),
     ...(extras?.label    ? { label: extras.label }       : {}),
     ...(extras?.pricing && Object.keys(extras.pricing).length > 0 ? { pricing: extras.pricing } : {}),
   };
   if (idx >= 0) store.keys[idx] = entry; else store.keys.push(entry);
   ```

   `findIndex` matches, so this is a replace-in-place — **the "second row" hypothesis is ruled out**.
   The row survives with the new key and nothing else.

5. **`gatewayProfiles.ts:29-31`** — `isGatewayRow` is `typeof row.baseUrl === "string" && trim() !== ""`.
   With `baseUrl` gone the row is skipped by `gatewayProfilesFrom`, so `readGatewayProfilesSync()`
   returns `[]` and the profile ceases to exist.

`setDiskKey` has exactly two production callers (both instruments agree; the `git grep` third hit is
`src/repo/rankerBaseline.snapshot.json`, the stale embedded-source fixture CLAUDE.md warns about —
it answers with the pre-gateway version of both files and was not used):

| site | passes extras? | outcome |
|---|---|---|
| `ApiKeysView.tsx:57` `savePricing` | yes — re-spreads `baseUrl`/`protocol`/`label` | correct, and its comment at `:36-42` states the merge requirement explicitly |
| `ApiKeysView.tsx:148` key input | only when `draftUrl` is set — never on the edit path | **the defect** |

The pricing path already knew `setDiskKey` replaces rather than merges and compensated. The edit path
did not.

### Exact text the user sees

Measured by driving `dist/cli/config.js` (`loadCliConfig` → `applyDiskKeyFallbacks` →
`validateCliConfig`) against a redirected `HOME`, with the demoted row on disk and
`--provider adesso --model qwen-3.8-27b-sovereign`:

**A. Control — healthy gateway row**

```
resolved provider: openai | profile: adesso | baseUrl: https://aihub.adesso.de/v1
warnings: (none)     throw: (none)
```

**B. Demoted row, no Anthropic key present**

```
[zone] provider "adesso" is not recognized; falling back to anthropic.
Error: No API key found for provider "anthropic". Set ANTHROPIC_API_KEY or run "zone login" to configure.
```

The warning is `config.ts:124` (`resolveProviderProfile`'s `onUnrecognized`); the throw is
`config.ts:286-289` (`validateCliConfig`). **This is the reported symptom.** The user enters a key
through `/keys`, `/keys` reports "Key saved — active on next run", and the next run says no API key
was found — so it reads exactly like a key that did not save. It did save. The provider that would
have consumed it no longer exists, so Zone went looking for an *Anthropic* key instead.

**C. Demoted row, Anthropic key also present — worse**

```
[zone] provider "adesso" is not recognized; falling back to anthropic.
throw: (none)
```

No error at all. The run proceeds silently against `api.anthropic.com`, on the user's real Anthropic
key, with `model: "qwen-3.8-27b-sovereign"`. It will fail at the vendor with an unrelated
model-not-found, having left the gateway entirely and billed the wrong account. Which arm a given
user hits depends only on whether they happen to have a vendor key configured.

Two aggravating details, **static reading only**:

- **`ApiKeysView.tsx:89`** gates `P` (price) on `list[sel]?.baseUrl`. Once demoted, pricing is
  unreachable too — so the row cannot be repaired from the keys modal at all. The only recovery is
  `Del` then `N` → `G`, re-entering the id, URL, key and every price.
- If `~/.zone/model.json` also carries `provider: "adesso"` (which `/model`'s gateway routing writes),
  the same warning fires with no `--provider` flag involved, so the failure follows the user across
  invocations.

### Why no test caught it

`KEYS_START_EDIT` appears in exactly two places in `src/`: the view that dispatches it and the
reducer case that handles it. **No test file references it** — both instruments exit 1, while the
same sweep for `KEYS_GATEWAY_URL_SUBMIT` returns `ApiKeysView.test.tsx`, so the instrument works:

```
command grep -rn "KEYS_START_EDIT" --include=*.test.ts --include=*.test.tsx src/   → exit 1
git grep -n "KEYS_START_EDIT" -- '*.test.ts' '*.test.tsx'                          → exit 1
git grep -ln "KEYS_GATEWAY_URL_SUBMIT" -- '*.test.ts' '*.test.tsx'                 → ApiKeysView.test.tsx
```

`ApiKeysView.test.tsx` opens with a note that `/keys` had no behavioural test of any kind before it
and that "the gateway flow arrives with pins rather than relying on the gap it was written into". It
pins the add flow (14 tests), the pricing sub-flow, and the list rendering. The edit path is the one
mode transition it does not reach — and its `press()` harness resets to `buildInitialState()` per
call with `loadDiskKeys` mocked to an empty list, so `list[sel]` is empty and `E` is unreachable
without an explicit `KEYS_OPEN` seed. The gap is structural, not an oversight in any one test.

### Remaining unknown, and the cheapest instrument to close it

None material. The mechanism is measured end to end and both downstream arms are reproduced. The one
thing worth a single command on the affected machine is confirming which arm was hit:

```bash
grep -n 'is not recognized' <the run's stderr>     # or: python3 -m json.tool ~/.zone/keys.json | grep -c baseUrl
```

A `0` from that second command on a machine where a gateway was configured *is* the defect.

---

## Defect 2 — the agent tool loop never returns on this gateway

The report asks which of two things happened: the first LLM call does not return, or its stream is
never consumed. **The second is not applicable — there is no stream on this path.**

### Finding 1 — no timeout could have fired at 115 s. The floor is 921.6 s.

Traced through `requestTimeouts.ts` and the adapter rather than taken from the SDK's nominal default:

- A gateway row defaults to `protocol: "openai-chat"` (`gatewayProfiles.ts:103`), which sets
  `adapterProvider: "openai"` (`:115`), which makes `factory.ts:165` construct
  `new OpenAIAdapter(apiKey, profile.baseUrl, "openai")`.
- The profile declares no `capabilities`, so `capabilitiesFor(profile, model)` returns `undefined`
  (`providerProfile.ts:130-141`).
- `qwen-3.8-27b-sovereign` is not in `MODEL_MAX_OUTPUT_TOKENS`, so `getMaxOutputTokens` falls to
  `DEFAULT_MAX_OUTPUT_TOKENS = 16_384` (`models.ts:245`). The agent loop passes that as `max_tokens`
  (`agentLoop.ts:4439`); `openaiAdapter.ts:72-78` renames it to `max_completion_tokens`.
- `deriveRequestTimeoutMs(16_384)` = `min(3_600_000, max(600_000, ceil(16384 × 28.125 × 2)))`.

Computed:

| `max_tokens` | derived per-request timeout |
|---|---|
| 0 / 4 096 | 600 000 ms (10 min — the `MIN_REQUEST_TIMEOUT_MS` floor) |
| **16 384** | **921 600 ms — 15 min 22 s** |
| 64 000+ | 3 600 000 ms (60 min — the ceiling) |

Transport backstop: `TRANSPORT_TIMEOUT_MS = 3_900_000` ms (65 min), applied as undici
`headersTimeout`/`bodyTimeout` via `zoneDispatcher` on `fetchOptions.dispatcher`
(`openaiAdapter.ts:41`).

**At 115 s the request was 806 s short of its earliest possible deadline.** The run was aborted
roughly 13½ minutes before any Zone or transport timer could have fired, so the observation is
equally consistent with "hung" and with "slow but working", and nothing in the run distinguished
them. Note also that Zone picks `16_384` for an unlisted gateway model **silently** —
`warnIfUnverifiedModelParams` (`models.ts`) only fires for models present in
`UNVERIFIED_MODEL_PARAMS`, so an unknown id emits no marker at all.

Retries are structurally excluded as an explanation. `withExponentialBackoff` carries
`totalBudgetMs: 60_000` (`withExponentialBackoff.ts:38`) and throws `UpstreamUnavailableError` once
projected wait would cross it (`:128-130`), so a retry storm cannot span 115 s. It also
`console.warn`s `[zone-llm-retry-attempt] …` per attempt (`:132`), which the stderr shield passes
through under `ZONE_VERBOSE_LOGS=1`. **Inference:** given the report of complete silence, no retry
occurred and no error was raised — a single request was in flight the whole time.

### Finding 2 — the silence is structural. Zone cannot log inside that gap on this path.

This is the answer to "does Zone log anything between issuing the request and the first chunk", and
it is a design fact rather than a missing log line.

The agent loop's main call is `client.createChatCompletion` (`agentLoop.ts:4433`) — non-streaming. It
passes `onToolArgumentsDelta` and `onTextDelta` in its options (`:4442`). The two adapters do
opposite things with them:

- **`AnthropicAdapter.createChatCompletion` (`anthropicAdapter.ts:103-105`)** — `if (options.onToolArgumentsDelta || options.onTextDelta)` diverts to `_streamWithToolCallbacks`, which calls
  `sdk.messages.stream(...)` and fires the callbacks per delta (`:182`, `:204`). A `createChatCompletion`
  on Anthropic is *internally streamed*.
- **`OpenAIAdapter.createChatCompletion`** — never mentions either identifier. It issues one
  `sdk.chat.completions.create(...)` and awaits the complete response.

```
command grep -rn "onToolArgumentsDelta\|onTextDelta" src/llm/openaiAdapter.ts src/llm/openaiAdapter/  → exit 1
git grep     -n "onToolArgumentsDelta\|onTextDelta" -- src/llm/openaiAdapter.ts src/llm/openaiAdapter/ → exit 1
control: command grep -c "onToolArgumentsDelta\|onTextDelta" src/llm/anthropicAdapter.ts              → 5
```

So on any gateway speaking `openai-chat`, the entire generation is one opaque POST. The callbacks the
loop supplies are accepted and discarded. **There is nothing to consume and nothing to report until
the full response arrives**, which is exactly the observed behaviour — 115 s of silence is what this
path *does*, not evidence that it broke. An Anthropic user watching live token deltas and a gateway
user watching a still spinner are on the same code path with the same intent; only the adapter
differs.

This is also why "or its stream is never consumed" has no answer: no stream is created.

### Finding 3 — what should have appeared, and where a line would have to go

Two markers already bracket the call, and the report's summary of "nothing" is the thing worth
checking first, because their presence or absence localises the hang for free:

| marker | site | gating | distance to the network call |
|---|---|---|---|
| `[zone-agent-llm-pre]` | `agentLoop.ts:4269` | `debugLog` — `ZONE_VERBOSE_LOGS=1` only | ~165 lines |
| `[zone-token-breakdown]` | `tokenBreakdown.ts:448` via `agentLoop.ts:4389` | `log` — **unconditional** | ~44 lines |
| `[zone-agent-llm-post]` | `agentLoop.ts:4476` | `debugLog` | immediately after |

Both are visible under the reported conditions. `stdoutShield.ts:24` routes matched markers to stderr
when **either** `ZONE_TUI_DEBUG=1` **or** `ZONE_VERBOSE_LOGS=1` — CLAUDE.md's TUI section names only
the first, which is incomplete; the code checks both. So `ZONE_VERBOSE_LOGS=1` alone is sufficient to
see them, and their absence is informative rather than expected.

**Where a line would still have to go.** `[zone-token-breakdown]` is the closest existing marker and
it is still ~44 lines upstream of `createChatCompletion`, with the cache-probe block and the
breakdown walk in between. To distinguish "waiting on the network" from "stuck in our own code" with
certainty rather than by proximity, the line has to sit **inside `OpenAIAdapter.createChatCompletion`,
immediately before `this.sdk.chat.completions.create(...)` at `openaiAdapter.ts:81`** — the last
statement Zone owns before control passes to the SDK. `agentLoop.ts:4433` is the second-best position
and is adapter-agnostic. Nothing exists at either today; `[zone-agent-llm-pre]` is a *loop-iteration*
marker, not a *request-issued* marker, and it is safe to read it as the latter only when nothing
between the two can block.

### Finding 4 — three response-shape assumptions that a non-vendor model can break. None can hang.

`extractFunctionCallItems` (`agentLoop.ts:1968-1991`) reads tool calls from exactly one place and
requires exactly one shape:

```ts
const toolCalls = (choices[0] as {message?: {tool_calls?: unknown[]}})?.message?.tool_calls;
if (!Array.isArray(toolCalls)) return [];
… t.type === "function" && typeof t.id === "string"
  && typeof t.function.name === "string" && typeof t.function.arguments === "string"
```

Three ways an OpenAI-compatible server can be dropped on the floor, each silently:

1. **A tool call emitted as text in `content`** — the failure mode named in the report, and the common
   one for open-weight models behind a server without a model-specific tool-call parser (`<tool_call>{…}</tool_call>`, or a bare JSON object). `tool_calls` is absent, `[]` is returned.
2. **`function.arguments` delivered as a parsed object rather than a JSON string** — several
   OpenAI-compatible servers do this. The `typeof … === "string"` guard rejects the call.
3. **`type` omitted on the tool-call item** — also seen in the wild on non-streaming responses. The
   `t.type === "function"` guard rejects it.

In all three cases the loop sees zero tool calls and takes the *final-answer* branch: the assistant
text becomes the answer and the run **ends immediately**. That is a real and likely gateway defect —
but it is the opposite symptom. **It cannot produce the observed hang**, and it is worth stating
plainly so it is not mistaken for the cause. There is no salvage path and no marker; a dropped tool
call is indistinguishable from a model that chose not to call one.

### Finding 5 — accounting for the earlier run that completed two `list_files` calls

Partially. What the earlier run rules out, and what it leaves open:

- **Ruled out: the shape assumptions in Finding 4.** Two completed `list_files` calls mean the model
  produced well-formed `tool_calls` twice, so this endpoint and model satisfy all three guards.
- **Ruled out: simple tier.** `list_files` is absent from the 5-tool simple subset
  (`read_file`/`write_file`/`apply_patch`/`multi_edit`/`run_command`). The earlier run was medium or
  complex. So the two runs differ by at most one tier step, not by the full range.
- **Still open, and measurable:** request size. Measured from `dist/tools/toolDefinitions.js`:

  | tier | tools | `JSON.stringify` chars |
  |---|---|---|
  | simple | 5 | 5 709 |
  | medium | 9 | 9 275 |
  | complex | 20 | 16 465 |

  A medium→complex classification difference nearly doubles the tool schema on top of a ~12 KB system
  prompt. On a 27B model behind a shared corporate endpoint that is a plausible latency cliff, and
  `[zone-token-breakdown]`'s `totals.estTokens` records it per call, in both runs, already.
- **Still open, and not observable from Zone:** gateway-side queueing or cold model load.

**I cannot determine which from the evidence available**, and there is no basis to prefer one. The
breakdown marker from both runs settles the size question in one comparison; it cannot settle the
queueing one.

### Other gateway-compatibility hazards found in passing

Each is **static reading only** and none is confirmed as the cause. Listed because they are on the
same path and are cheap to check while the endpoint is in hand.

1. **`prompt_cache_key` is sent to the gateway.** `RecordingLLMClient.provider = inner.provider`
   (`recordingClient.ts:168`), and `OpenAIAdapter.provider` is `profile.adapterProvider`, i.e.
   `"openai"` — so `agentLoop.ts:4274-4276` evaluates `client.provider === "openai"` as true and adds
   `prompt_cache_key: "zone-run-…"` to the body (`:4440`). This is an OpenAI-platform field. Lenient
   proxies ignore it; a strict one returns 400. A 400 classifies as `non_retryable`
   (`withExponentialBackoff.ts:84`) and throws at once, so this **cannot** explain a 115 s silence —
   but it is a live compatibility risk that no gate protects against, and the `web_search` precedent
   in CLAUDE.md shows the pattern of vendor-shaped fields escaping the profile abstraction.
2. **The task classifier abandons its request without cancelling it.** `taskClassifier.ts:670-688`
   races `client.createChatCompletion` against a 5 s timer (`DEFAULT_TIMEOUT_MS = 5000`, `:180`) and
   passes **no** abort signal — confirmed with both instruments (exit 1), against the control that
   `agentLoop.ts` passes `signal: input.abortSignal` at three sites. `Promise.race` settles the race;
   it does not cancel the loser. On a slow gateway every run therefore leaves one orphaned in-flight
   request holding a connection for up to its own 600 s timeout, concurrent with the agent loop's
   real call. If the endpoint serialises per key — normal for corporate quota gateways — **the agent
   loop's first call queues behind an abandoned classifier request.** That is a mechanism that
   produces exactly the reported shape, and it is checkable.
3. **No proxy support anywhere.** Both instruments, whole tracked tree, exit 1 for
   `https?_proxy|proxyagent|no_proxy|setGlobalDispatcher`. `zoneDispatcher` is a bare
   `undici.Agent`, passed explicitly as `fetchOptions.dispatcher`, which **overrides** any global or
   env-derived proxy dispatcher. A corporate endpoint reachable only through an HTTP proxy is
   therefore unreachable regardless of `HTTPS_PROXY`. undici's default `connectTimeout` (10 s) is
   left unset, so a refused connection surfaces in ~10 s as a retryable network error with
   `[zone-llm-retry-attempt]` lines — meaning a *silently dropped* SYN (firewall DROP rather than
   REJECT) is the only proxy-shaped failure that stays quiet, and even that resolves inside the 60 s
   retry budget. Not the cause here; a blocker for anyone else on a proxied network.

### Remaining unknowns, and the cheapest instrument for each

Ordered by value. The first costs nothing and is likely to settle the question on its own.

| # | Unknown | Cheapest instrument | Cost |
|---|---|---|---|
| 1 | Did the request reach the network, or did Zone stall before issuing it? | On the affected machine: `grep -c 'zone-token-breakdown' ~/.zone/markers.jsonl` for that run, and `grep -c 'llm key source' `. The sink is written regardless of verbosity, so **the aborted run is already recorded.** A breakdown marker present ⇒ Zone got to the call and the gap is the network. Two `llm key source` lines ⇒ both the classifier and the agent loop built clients; one ⇒ it never got past classification. | zero — data already on disk |
| 2 | Did the classifier complete, and at what latency? | Same file: `grep 'zone-task-classified' ~/.zone/markers.jsonl \| tail -1`. Emitted on **every** path — success, error, timeout (`fallbackUsed:true`), and no-model — so its absence is itself the finding. `classifierLatencyMs` and `fallbackUsed` come with it. | zero — same file |
| 3 | Would the call have returned given more time? | Re-run with `ZONE_VERBOSE_LOGS=1` and simply **do not abort before ~16 minutes** (921.6 s + margin). Either `[zone-agent-llm-post]` appears, or the derived timeout fires and raises a real error. | one run, unattended |
| 4 | Is it the abandoned-classifier collision (hazard 2)? | Re-run with `ZONE_FORCE_TIER=complex` (or any `--force-tier`), which makes `classifyTask` unnecessary — then compare time-to-first-output. `tcpdump`/`ss -tn` against the endpoint answers it directly if the network is inspectable. | one run |
| 5 | How much bigger is the failing request than the working one? | Compare `totals.estTokens` on the `[zone-token-breakdown]` line from the two-`list_files` run and from the hanging run. | zero — same file |
| 6 | Does the gateway reject `prompt_cache_key`? | `curl` the endpoint once with and once without the field. | one curl pair |

---

## Incidental findings

Not asked for; found on the same code paths and recorded so they are not lost. Neither is in
`docs/deferred-work.md` — this pass does not touch it.

1. **The auto-offer-to-price prompt after adding a gateway never appears.** `ApiKeysView.tsx:149-157`
   calls `refresh()` and then dispatches `KEYS_PRICE_START`, with the comment "`refresh` dispatches
   `KEYS_OPEN` (which resets to "view"), so this must follow it." It follows it in *source* order but
   not in *time*: `refresh()` is fire-and-forget (`void loadDiskKeys().then(…)`), so its `KEYS_OPEN`
   is registered inside the current callback and necessarily runs after it. Demonstrated on an
   isomorphic reduction:

   ```
   dispatch order: TOAST_PUSH -> KEYS_PRICE_START -> KEYS_OPEN
   KEYS_OPEN lands after KEYS_PRICE_START: true
   ```

   `KEYS_OPEN` resets `keysEditMode` to `"view"` and clears `keysPriceProvider`, so the pricing
   sub-flow is torn down in the same tick it was started. Consequence: every gateway is created
   unpriced, which leaves `--max-budget-usd` inert — the exact outcome the prompt exists to prevent,
   and consistent with `[zone-profile-no-pricing]` firing on the reported run. Ordering established
   by static reading plus the reduction above; not observed against the live component.

2. **CLAUDE.md's stdout-shield sentence is incomplete.** It says `ZONE_TUI_DEBUG=1` routes markers to
   stderr; `stdoutShield.ts:24` accepts `ZONE_TUI_DEBUG=1` **or** `ZONE_VERBOSE_LOGS=1`, matching the
   stderr shield it is described alongside. Worth correcting, because it makes verbose-mode marker
   output look unavailable when it is not — which is precisely the instrument Defect 2 needs.

---

## Recommendation

*This section is the recommendation. Everything above is findings and inferences.*

**Do not fix these together.** Defect 1 is a confirmed, self-contained data-loss bug with a measured
reproduction. Defect 2 is not yet a diagnosis — it is a structural gap plus a shortlist. Shipping a
speculative fix for the second would spend the evidence that the first is ready to be fixed against.

### 1. Fix Defect 1 — merge on update, do not replace (small, high confidence)

The minimal correct change is in `setDiskKey`, not in the view: **preserve the existing row's gateway
fields unless the caller explicitly supplies replacements.** Doing it in `diskKeys.ts` fixes both
callers and any future one, whereas patching `ApiKeysView.tsx:148` to re-spread the row would make
the third caller wrong again — the same trap `savePricing` already had to work around, and its
comment at `:36-42` documents that it had no better option. Keep the deliberate distinction that a
*skipped* cache bucket stays absent rather than becoming `0`; merging row-level fields does not
disturb it.

`docs/deferred-work.md` should record why `setDiskKey`'s replace-in-place existed and what the merge
now guarantees. Two pins are the ones actually missing:

- `E` on a gateway row updates the key and keeps `baseUrl`/`protocol`/`label`/`pricing` — the case
  no test reaches today.
- `E` on a vendor row still writes exactly three fields, so a vendor row cannot acquire gateway
  fields by accident.

Add both to `ApiKeysView.test.tsx` with an explicit `KEYS_OPEN` seed, since the existing `press()`
harness cannot reach the edit path with an empty list. Fix incidental finding 1 in the same pass —
it is three lines (await the refresh, or dispatch `KEYS_PRICE_START` from inside `refresh`'s
continuation) and it is the reason gateways are unpriced in the first place.

### 2. For Defect 2 — read the marker sink before writing any code

Instruments 1, 2 and 5 in the table above are free and use data already on disk on the affected
machine. They separate three mutually exclusive worlds — Zone never issued the request, the
classifier collided with it, or the gateway is simply slow — and each implies a different fix. Ask
for `~/.zone/markers.jsonl` from that machine before anything else.

If it turns out the request *was* issued and the endpoint is just slow, the defect to fix is not a
timeout — it is **Finding 2**. A user staring at a still spinner for fifteen minutes with no way to
tell a slow endpoint from a dead one is the actual product failure, and it is guaranteed for every
gateway user by construction, independent of this endpoint. Two candidate remedies, in order of cost:

- **Cheap and adapter-local:** emit a heartbeat or a `narration` progress event from
  `OpenAIAdapter.createChatCompletion` once the request has been in flight past some threshold, so
  the TUI can say *waiting on the endpoint (Ns)* rather than nothing. This also gives Finding 3's
  missing request-issued marker its natural home.
- **Correct and larger:** route the gateway path through `createChatCompletionStream`, which
  `OpenAIAdapter` already implements and `RecordingLLMClient` already augments with
  `include_usage` gated on protocol rather than vendor (`recordingClient.ts:197-206`). This would
  restore parity with Anthropic's live deltas. It is a real piece of work — the loop's callback
  contract, tool-call assembly across chunks, and mid-stream error handling all have to be built for
  this adapter — and it should not be attempted until instrument 1 has confirmed the request is
  reaching the network at all.

Regardless of outcome, hazard 2 (the uncancelled classifier request) is worth fixing on its own
merits: pass an `AbortController` signal that the 5 s timer trips. It is a few lines, it stops
leaking a connection per run on every slow endpoint, and if it *is* the cause it fixes Defect 2
outright.

Defer hazards 1 and 3 (`prompt_cache_key`, proxy support) to `docs/deferred-work.md`. Both are real
gateway-support gaps and neither is on the critical path for this report.
