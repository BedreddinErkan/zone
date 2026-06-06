# Provider/Model Routing Audit — anthropic + openai

**Date:** 2026-06-03 · **Scope:** read-only diagnosis (Opus). Sonnet implements.
**Target providers:** {anthropic, openai}. Gemini is being removed — excision list at the end.

---

## 1. Root-cause verdict: ONE structural root (two surfaces), not N point bugs

The divergence — *anthropic main loop completes; OpenAI classifier (gpt-5.4-mini) succeeds; OpenAI **main** loop (gpt-5.4) returns nothing* — is **one structural anti-pattern: completion params are hand-coded per call-site, and only the Anthropic adapter has a normalization layer.** The OpenAI adapter is a thin pass-through. So an OpenAI-shaped request that "works" only works because the *Anthropic* side happens to fix it up; on the real OpenAI path it goes through verbatim and gpt-5.x rejects it.

There are **two independent surfaces** of "same job done two divergent ways":

| # | Surface | Divergence | Symptom |
|---|---------|-----------|---------|
| **A** | LLM completion token param | Anthropic adapter normalizes `max_tokens`↔`max_completion_tokens` (`convertParams.ts:95-100`); OpenAI adapter does **not** (`openaiAdapter.ts:23-35`, `:37-42`). Call-sites hand-code `max_tokens`. | OpenAI main loop **HTTP 400**, run ends `$0`/no-edit/no-error |
| **B** | TUI model display | "Badge" is a one-time raw `process.stdout.write` (`index.tsx:33-48`, called `:228` before Ink mounts); "footer" is reactive Ink state (`StatusBar.tsx`). An unused reactive `Header.tsx` exists but is never mounted. | badge frozen at startup model; footer tracks `/model` |

**Why 924285f "exposed" this:** before 924285f, selecting an OpenAI model with a mismatched provider silently ran on **anthropic** (which normalizes `max_tokens`), so the bug was masked — you got a result, just on the wrong model. 924285f correctly pins `provider=openai` from the model (`config.ts:100-110`), so the request now actually reaches the OpenAI adapter and hits the **pre-existing, long-latent** `max_tokens`-on-gpt-5.x bug. 924285f is internally sound and did **not** regress; it removed the mask. (config.test.ts green; no overcorrection found.)

---

## 2. Captured runtime data (the decisive evidence)

Reproduced against the real OpenAI API with the dogfood key, mirroring the main-loop call shape (`gpt-5.4`, tools, `tool_choice:"auto"`). Temp script run in the dogfood worktree, then deleted.

**Attempt A — `max_tokens: 16384` (exact `agentLoop.ts:2602` shape):**
```
status: 400 | code: unsupported_parameter | type: invalid_request_error | param: max_tokens
message: Unsupported parameter: 'max_tokens' is not supported with this model.
         Use 'max_completion_tokens' instead.
```

**Attempt B — `max_completion_tokens: 64` (classifier shape):**
```
OK | model: gpt-5.4-2026-03-05 | finish_reason: stop | content: "Hi" | usage billed normally
```

**Conclusions from runtime:**
- `gpt-5.4` is a **valid** model (resolves to snapshot `gpt-5.4-2026-03-05`). NOT an invalid-model bug.
- The failure is a **non-retryable HTTP 400** caused purely by the `max_tokens` *parameter spelling*.
- `max_completion_tokens` works on the identical model + tools.

---

## 3. Failure trace — why `$0`, ~11.7s, "no error"

1. `agentLoop.ts:2602` sends `max_tokens: 16384` to `client.createChatCompletion`.
2. `OpenAIAdapter.createChatCompletion` (`openaiAdapter.ts:23-35`) passes params **verbatim** to the SDK (only adds `reasoning_effort`; no token-param normalization).
3. OpenAI returns **400** (`unsupported_parameter`).
4. `classifyError` (`withExponentialBackoff.ts:61-81`): status 400 (< 500, not 429) → `non_retryable` → `throw err` immediately (`:100`). **No retries** → the 400 is instant; the ~11.7 s is pre-main context assembly (classifier + plan-gen + repo scan/rank), not the call.
5. `RecordingLLMClient` records usage only on a *returned* response; the throw skips it → **`$0`**. (`agentLoop.ts` `recordLLMCall` at `:2636` is also never reached — the throw is at `:2628`.)
6. agentLoop catch (`:2607-2628`) only special-cases `UpstreamUnavailableError`; a `BadRequestError` falls to `throw llmErr` (`:2628`).
7. The throw propagates: `runAgentLoop` (`runLlmPatchFlow.ts:6006`, no local try/catch) → `runOneShotInner` → `runPrompt`'s `catch {}` in `index.tsx` (`runPrompt`, "errors surfaced via eventBus") which **swallows** it. No error event was emitted, so nothing surfaces.
8. `runPrompt`'s `finally` emits a synthetic `agent_loop_complete` → `RUN_DONE`. The TUI shows the run as **done, no patch, no error**.

The classifier survives the same provider because it is the **one** call-site already migrated to `max_completion_tokens` — with a literal code comment naming the exact bug:

> `taskClassifier.ts:426-428` — *"gpt-5.x mini / reasoning-style models reject `max_tokens` — they require `max_completion_tokens`. The OpenAI SDK accepts both fields, so prefer the new spelling everywhere this classifier runs."*

The fix was applied locally to the classifier and never generalized.

---

## 4. Blast radius — every OpenAI-path `max_tokens` sender

All of these 400 on any gpt-5.x (reasoning/`supportsEffort`) model; only `agentLoop` is on the TUI hot path, the rest are latent:

| File:line | Context | Param |
|-----------|---------|-------|
| `src/llm/agentLoop.ts:2602` | **main agent loop** (non-streaming) | `max_tokens: 16384` |
| `src/llm/detectIntent.ts:182` | intent detection | `max_tokens: 50` |
| `src/llm/planFullPatch.ts:715, 926` | patch gen (stream + fallback) | `max_tokens: maxOutputTokens` |
| `src/llm/planFullPatch.ts:1241, 1340` | full-content (stream + fallback) | `max_tokens: maxOutputTokensFull` |

Note: `OpenAIAdapter.createChatCompletionStream` (`:37-42`) is **also** an un-normalized pass-through **and bypasses `withExponentialBackoff` entirely** — streaming `max_tokens` calls 400 the same way, with no retry wrapper.

Contrast (why anthropic is immune): `convertParams.ts:95-100` resolves `max_tokens ?? max_completion_tokens ?? DEFAULT_MAX_TOKENS` into Anthropic's native `max_tokens` — both spellings accepted.

---

## 5. Fix plan (scoped for Sonnet)

### Target shape
**Symmetry between adapters: the OpenAI adapter owns OpenAI param normalization, exactly as `convertParams.ts` owns it for Anthropic.** Call-sites keep sending the unified `max_tokens`; each adapter translates to what its API wants. No call-site special-cases a provider.

### Ordered changes

1. **OpenAI adapter — normalize the token param (primary fix; repairs all 6 call-sites at once).**
   In `src/llm/openaiAdapter.ts`, in **both** `createChatCompletion` (`:23-35`) and `createChatCompletionStream` (`:37-42`), before calling the SDK: if `max_tokens` is present and `max_completion_tokens` is absent, move it (`max_completion_tokens = max_tokens; delete max_tokens`). The SDK + all current OpenAI models accept `max_completion_tokens`; the reasoning models *require* it. Do it in one shared private helper so sync and stream paths can't drift.
   - This is the single source of truth. After it, `agentLoop.ts:2602` etc. need no change to function.

2. **(Optional, clarity) migrate the literal call-sites** `agentLoop.ts:2602`, `detectIntent.ts:182`, `planFullPatch.ts:{715,926,1241,1340}` from `max_tokens:` to `max_completion_tokens:`. Lower priority than #1 — with #1 in place they're cosmetic. Do **not** rely on call-site edits alone (a future caller will reintroduce `max_tokens`); #1 is the guardrail.

3. **Streaming retry gap (defense-in-depth):** wrap `createChatCompletionStream` in `withExponentialBackoff` like the non-streaming path, so transient 5xx/429 on stream calls get the same treatment. (Independent of the 400 fix; flagged because the audit surfaced it.)

4. **TUI badge — make it reactive (surface B).**
   The visible "badge" is the raw `writeBannerToStdout` model line (`index.tsx:33-48`, called `:228` once before Ink mounts) — it can never react. A correct reactive `Header.tsx` already exists (reads `state.statusBar.model`) but is never mounted in `App.tsx`. Fix: mount `<Header/>` in the **dynamic** region of `App.tsx` (NOT inside the `<Static>` transcript block in `Transcript.tsx:61-69`), and drop the model line from `writeBannerToStdout` (keep version/cwd splash if desired). `MODEL_APPLY` already updates `statusBar.model` (`store.tsx:512-523`), so the badge then tracks `/model` for free — same source as the footer.

### Tests that would have caught each failure
- **Adapter completion-parity (would have caught A):** unit-test `OpenAIAdapter.createChatCompletion` with a mocked SDK; pass `{max_tokens: N}`, assert the SDK receives `max_completion_tokens: N` and **no** `max_tokens`. Mirror an Anthropic-adapter test asserting either spelling resolves to native `max_tokens`. A cross-adapter parity table (`max_tokens` in → valid request out) locks the symmetry.
- **Badge-tracks-model (would have caught B):** render the TUI store + `<Header/>`, dispatch `MODEL_APPLY({model:"gpt-5.4"})`, assert the rendered badge text contains `gpt-5.4`. (Pairs with the existing footer/StatusBar coverage.)

---

## 6. Gemini excision points (for the removal pass — not analyzed, just located)

**Core types/routing:** `src/llm/types.ts:9` (LLMProvider union) · `src/llm/modelRouting.ts:10,46-54,63` (RoutingProvider, GEMINI_DEFAULTS, getModelForRole case) · `src/llm/models.ts:56-62` (MODEL_CATALOG.gemini) · `src/llm/modelRegistry.ts:9,33,44` · `src/llm/openaiClient.ts:88-89,101` (getModelName gemini branch).
**Factory/keys:** `src/llm/factory.ts:7,20-22,48-49,127-154` (GEMINI_BASE_URL, gemini case, resolveGeminiApiKey) · `src/cli/config.ts:15,47,68,94-95,114,132,147,152` (geminiApiKey, resolveProvider, validateCliConfig) · `src/cli/dispatch.ts:64,160` · `src/api/diskKeys.ts:5` · `src/api/diskModel.ts:10`.
**Usage/recording/classifier:** `src/llm/recordingClient.ts:45,113` (toProviderName, stream_options) · `src/usage/pricing.ts:8,34-38` · `src/llm/taskClassifier.ts:255-256,364` (ZONE_CLASSIFIER_MODEL_GEMINI).
**Server/UI:** `src/api/server.ts:452` (header validation) · `src/cli/tui/App.tsx:38,46` · `src/cli/tui/components/ModelModal.tsx:53,68` · `src/cli/tui/components/ApiKeysView.tsx:32` · `src/ui/index.html` (catalog + dropdown).
**Tests:** config.test.ts, factory.test.ts, modelRouting.test.ts, modelRegistry.test.ts, models.test.ts, openaiClient.test.ts, recordingClient.test.ts, pricing.test.ts, diskKeys.test.ts, ui/index.test.ts, buildEnv.test.ts.
**KEEP:** `src/core/buildEnv.ts` `GEMINI_API_KEY` stripping is defense-in-depth env hygiene — harmless to leave, or drop with the rest; not load-bearing for removal.

---

## 7. One-line summary
The OpenAI main loop dies on a non-retryable HTTP 400 because `agentLoop.ts:2602` hand-codes `max_tokens` (gpt-5.x demands `max_completion_tokens`) and the OpenAI adapter — unlike the Anthropic adapter's `convertParams` — does no param normalization; fix it once in the adapter (plus wire the reactive `Header` for the stale badge), and add adapter completion-parity + badge-tracks-model tests.
