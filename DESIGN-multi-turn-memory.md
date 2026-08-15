# DESIGN — Multi-Turn Conversation Memory (Roadmap #1)

**Status:** Design proposal, code-grounded (file:line). NO source changed. Builds on the shipped session-memory primitive. Produced via multi-agent investigation (6 readers + 2 adversarial verifiers) and a design panel (3 proposals → 5 adversarial critiques → synthesis).

**Goal:** move Zone from *dispatcher* (each prompt is an isolated run that sees at most one prior summary) toward *collaborator* — the agent carries the recent **thread** forward so the **next** prompt can course-correct: *"no, change X from before"*, *"now also do Y"*, *"revert that file"*. Cost-conscious throughout; cache-safety is make-or-break.

**Scope line:** v1 = continuity **across dispatches** (course-correct on the *next* prompt). Mid-dispatch interjection (redirect a *running* loop) is explicitly **deferred** — §3.7.

---

## Part 1 — Current architecture (verified)

### 1.1 The single-prior session-memory flow (load → frame → inject)

Each TUI submission is a fresh dispatch (`runId = randomUUID()`, `src/cli/tui/index.tsx:201`); `sessionId` is stable for the whole TUI session (`index.tsx:202-203`). Before the run, the TUI loads **one** prior summary and threads it as a separate field with neutral framing:

- **Load** — `loadSessionSummary(sessionId, config.repoPath)` (`index.tsx:56-64`, called at `:224-230`) → `readFsConversationEvents` → `extractPriorRunSummary` (returns a **single** summary string). Gated on `config.memoryEnabled && sessionId`. Keyed on **`config.repoPath`**, never `process.cwd()`.
- **Thread** — `runOneShotInner(prompt, config, runId, { priorSessionSummary })` (`index.tsx:241`) → `dispatch.ts:170-184` → `runLlmPatchFlow.ts:5955` → `agentLoopBaseInput`. `priorSessionSummary` is a **distinct field** from the rollback-path `priorRunSummary`.
- **Inject** — at `agentLoop.ts:2000-2015` it becomes `sessionMemBlock` and is **string-concatenated into `userContent`** (the first user message), alongside `auditContextBlock` and `input.task`:
  ```
  SESSION MEMORY — context from your prior task in this session:
  <summary>
  END SESSION MEMORY.
  ```
- **Interpret** — a **static, unconditional** directive in the system prompt (`agentLoop.ts:522-526`) tells the agent how to read the block ("advisory context… describes a COMPLETED task — do not re-investigate or re-apply"). It is present byte-for-byte whether or not a summary exists.

**The cache guarantee:** `priorSessionSummary` is **not** a parameter of `assembleAgentSystemPrompt()` (`agentLoop.ts:382-400`). All memory content lives in the user message; the system+tools prefix is byte-identical regardless of memory.

**Cache-boundary correction (`docs/deferred-work.md` item 161), applying to every "system+tools" /
"breakpoint #1" reference in this section (§1.1–§1.5) and to the R1 row in §3's requirements
table:** breakpoint #1 covers tools alone, not system+tools — measured against the per-call usage
log, not assumed. A system-prompt change cannot bust a cache entry keyed on an unchanged tools
array. Keeping memory (and the `TRUST_PHASE1_DIRECTIVE` toggle, below) out of the system prompt is
very likely still the right call, but the mechanism as written throughout this section is wrong:
the more plausible risk is breakpoint #2's own cumulative span, which — per CLAUDE.md's own
account of it — reaches backward through the conversation and, on this reading, through system.
**Unconfirmed this pass** (no new measurement was taken); offered as the starting point for
re-examination, not as settled fact. The existing placement rules and constraints are left as
written and should still be honored.

### 1.2 The conversation event store

`src/core/conversationFilesystemStore.ts` — JSONL at `<repoPath>/.zone/conversations/<threadId>.jsonl`:

- **Event shape** (`:35-44`): `FsConversationEvent { type: "user"|"run"|"agent_summary"|string; ts; text?; decisionMode?; [k:string]: unknown }` — the `type` union **already accepts `"user"`** and arbitrary extra fields (no schema migration needed to add a new event type or field).
- **threadId validation** (`:26`): `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/` — a UUID `sessionId` is valid.
- **Rotation** (`:28-29, 84-103`): `FS_CONVERSATION_MAX_EVENTS = 50`; append trims to the last 49 + new line (read-trim-rewrite, non-atomic).
- `appendFsConversationEvent` returns `boolean` and **never throws** (`:67-110`) — graceful degradation.

**The writer gap (critical).** In the TUI path the store is written **only** with `type:"agent_summary"` events post-run (`index.tsx:265-278`). The **user's prompt is never persisted to the filesystem store** — only the (optional) Supabase path writes `type:"user"`/`type:"run"` events (`src/api/runLogging.ts:211-229`). So today the FS thread cannot reconstruct *what the user asked* across turns. Multi-turn course-correction is impossible without closing this.

> Aside: `runLlmPatchFlow` already hydrates `conversationHistory = fsEvents.slice(-10)` (`runLlmPatchFlow.ts:5140-5156`) — but it feeds **only `plannerStep`** (`:6679`), never the agent loop's user message. The agent itself sees nothing beyond the single `priorSessionSummary`.

### 1.3 Compression primitives (`src/llm/applyRollbackFeedback.ts`)

- `extractPriorRunSummary(messages)` (`:316-328`) — scans newest-first, returns the **first** `agent_summary`'s text (truncated). Single match; **early-returns `""` on the first empty summary** (`:324`) — a footgun for a multi-turn walker.
- `truncatePriorRunSummary(s)` (`:292-307`) — 2048-byte cap (`PRIOR_RUN_SUMMARY_MAX_BYTES = 2048`, `:276`). **Its contract is to find, prioritize, and isolate the `APPLY_ROLLED_BACK` marker**, dropping the prelude on overflow. Reusing it for a *neutral* window would surface rollback-marker text under a neutral header — a framing-drift bug. v1 adds a **dedicated neutral truncator** instead.

### 1.4 The dispatch lifecycle — single-prior confirmed (adversarially verified)

Confirmed: today the **only** cross-turn context reaching the LLM in the TUI flow is the single `priorSessionSummary`. There is no multi-turn message accumulation; each dispatch starts `responseInput = [system, user]` fresh (`agentLoop.ts:2017-2027`). `conversationId` is **not** threaded by the TUI (`index.tsx:224` comment) and is used only as the OpenAI prompt-cache key (`buildOpenAIPromptCacheKey`, `agentLoop.ts:2523-2526`) — never to inject history. The rollback `priorRunSummary` path (Supabase/FS via `conversationId`) is **separate** and dormant for the TUI.

### 1.5 The cache architecture — the make-or-break seam

`src/llm/anthropicAdapter/convertParams.ts` + `cacheControlHelpers.ts`:

- **Breakpoint #1** (`convertParams.ts:124-144`): `cache_control` on system+tools (~3879-tok prefix). **Byte-sensitive to `systemContent`.** *(Covers tools alone, not system+tools — see the correction at §1.1.)*
- **Breakpoint #2** (`cacheControlHelpers.ts:34-70`): marks the **last persistent** user message, **skipping** the per-iter manifest message.
- **Where a window MUST go:** concatenated into the **first user message** (`userContent`), which sits **inside** breakpoint #2's prefix → cache-**written once** (iter 0), cache-**read** for iters 1..N. Pushing it as a **separate `role:"user"` message busts breakpoint #2**; putting it in the **system prompt busts breakpoint #1**. *(As reasoned when written — see the correction at §1.1: breakpoint #1 is tools-only, so the more plausible risk of a system-prompt placement is breakpoint #2, not #1. The rule — keep it out of the system prompt — is unaffected either way.)*

**Verified cache anti-pattern (do not imitate):** when `auditFindings` exist, the static `TRUST_PHASE1_DIRECTIVE` is toggled **into the system prompt** (`agentLoop.ts:375-380, 577, 1937`) — its *presence* changes system bytes and busts breakpoint #1. The SESSION MEMORY directive (`:522-526`) is the **correct** pattern: **unconditional**, so its presence never changes. The design must add **zero** presence-keyed system toggles. *(The breakpoint attribution — see the correction at §1.1 — is unconfirmed; whichever breakpoint is actually at risk, the rule — no presence-keyed system toggles — is unaffected.)*

### 1.6 Cost-model numbers

`chars/4` token heuristic throughout. Context windows (`models.ts:75-101`): Sonnet/Opus **1M**, Haiku **200k**, GPT-5.x **128k**, 200k fallback. Compaction triggers at **75%** of the window (`ContextCompactor.ts:153`). A single prior summary = ≤2048 B ≈ **512 tok**.

---

## Part 2 — The gap

Today the agent sees only the **last** run's compressed summary, neutrally framed — not the **thread**. Three things are missing for real iterative refinement:

1. **The user's prior intent is not persisted** (the writer gap, §1.2). "Change X from before" has no referent if X was never stored.
2. **Only one turn** is carried, not a recent window.
3. **No file-scoped anchor** — "revert that file"/"also touch the same files" needs the concrete paths the prior turn changed.

### Granularity decision — the minimum for course-correction

Per completed turn, store exactly three signals plus a neutral outcome:

- **`userPrompt`** — the anaphora **anchor** ("X from before"). Tightly capped (≤256 B); it is a referent, not content to reproduce.
- **`summary`** — *what actually happened* (already produced as `patchPreview`), so the agent does not re-investigate. Neutral-truncated ≤2048 B.
- **`changedFiles`** — concrete paths (≤12), the single field that resolves file-scoped redirects. **Free** from `fileDiffs.map(d => d.filePath)` (already computed at `index.tsx:284`).
- **`outcome`** — a *neutral* enum (`applied | no_change | answered | reverted`) derived from `decisionMode`, never the raw `rolled_back` string.

**Deliberately NOT stored:** tool-call traces, per-iter detail, token counts, full diffs — unbounded, re-derivable, and irrelevant to redirection.

---

## Part 3 — Design (v1)

### 3.1 Chosen approach

**Spine — one atomic `{type:"turn"}` event per completed dispatch.** A turn is a single JSONL line, so it is **atomic in the log by construction**: the 50-event rotation can only ever drop a *complete oldest turn* (never split a turn's user-half from its summary-half), and a single **post-run** write eliminates the fire-and-forget submit-vs-post-run race (`onSubmit = void runPrompt`, `index.tsx`). This dominates a two-event (`user` + `agent_summary`) model on both cost (half the writes) and correctness (nothing to pair, nothing to mis-bind).

**Grafted on:** `changedFiles` for file-scoped redirection; the **minimal-diff seam discipline** — ride the *exact* existing `priorSessionSummary` seam, change only the builder and the loader, and keep a **standing cache-invariant test** as the guard.

**Rejected:** reusing `truncatePriorRunSummary` for the neutral window (surfaces rollback markers — §1.3). v1 adds a dedicated `truncateSessionTurn`.

### 3.2 Turn-record schema

One event appended per completed dispatch to `<config.repoPath>/.zone/conversations/<sessionId>.jsonl`:

```jsonc
{
  "type": "turn",
  "ts": 1733270400000,          // Date.now()
  "runId": "<uuid>",            // ordering-tie disambiguation (in scope at index.tsx:201); NOT for pairing
  "userPrompt": "<=256B>",      // anaphora anchor — tightly capped
  "summary": "<=2048B>",        // what happened — neutral-truncated (NOT truncatePriorRunSummary)
  "changedFiles": ["src/a.ts"], // <=12 paths — resolves file-scoped redirects
  "outcome": "applied"          // neutral enum: applied | no_change | answered | reverted
}
```

No store changes: `type:"turn"` and the free-form fields are already accepted (`conversationFilesystemStore.ts:36,43`).

### 3.3 Bounded-window shape + token math

**Tiered, hard-capped on the *assembled* string.** Builder walks `type:"turn"` events newest-first:

- **Tier A (K = 1, newest, high fidelity):** full `userPrompt` + neutral-truncated `summary` (≤2048 B) + `changedFiles`. Worst case ≈ 3.0 KB.
- **Tier B (older turns, compressed to one line each):** `earlier you asked to "<≤80 chars>"; files: a.ts, b.ts` — **intent + paths only, summary dropped, no outcome tag** (framing-drift guard). ≤200 B each.
- **Hard global cap `SESSION_WINDOW_MAX_BYTES = 4096`** (≈1024 tok) on the **final assembled string including framing**: assemble Tier A, prepend Tier B newest→older until the next line would exceed 4096 B, then stop (oldest silently dropped, newest-wins).
- **Single-turn-over-cap guarantee:** if Tier A alone exceeds 4096 B, **degrade Tier A's summary to fit** — the newest turn is always representable; never emit nothing for a non-empty session.
- **Empty session / post-Clear:** returns `""` → `sessionMemBlock === ""` → msg[0] byte-identical to today's cold start.

**Token math (`chars/4`):** worst-case assembled window ≈ 4096 B + ~120 B framing ≈ **~1054 tok**; typical ≈ **500–700 tok**; vs today's single summary (≤512 tok) that is **+~540 tok worst case**, often near-neutral. **Cost is O(1) in turn count** — a 2-turn and a 40-turn session inject the same ≤4096 B blob. Compaction headroom (0.7% of Haiku's 150k trigger) is **context-only reassurance, not the cost argument** (that is cache amortization, §3.6).

### 3.4 Phased plan (file touchpoints)

**Phase 1 — Persist the atomic turn record.** `src/cli/tui/index.tsx`, replacing the existing `agent_summary` write (~`:265-278`) with a single `{type:"turn"}` write in the **same post-run, awaited position** (never at submit time). `prompt` and `runId` are in scope; key on **`config.repoPath`**; derive `changedFiles` from `runResult.fileDiffs`; `summary = truncateSessionTurn(stripBanner(patchPreview))` (or `""` for question/no_change); `outcome` from a neutral `deriveNeutralOutcome(runResult)`. Check the boolean return under `ZONE_TUI_DEBUG=1` instead of discarding it. *Cache impact: none (pure FS append).*

**Phase 2 — Neutral truncator + pure window builder (new `src/llm/sessionWindow.ts`).**
- `truncateSessionTurn(text): string` — byte-slice to ≤2048 B keeping the **tail**, prepend a short notice, and **strip any surviving `APPLY_ROLLED_BACK`** → `"(no net change remained during that turn)"`. Never special-cases the marker.
- `buildSessionWindow(events): string` — **pure, synchronous, no `Date.now()`/random** (byte-identical output for the same events → within-run cache stability). Filters `type:"turn"`, newest-first, Tier A + Tier B under `SESSION_WINDOW_MAX_BYTES`, single-turn degrade, `""` on zero turns. **Skips empty events and keeps scanning** (does *not* inherit `extractPriorRunSummary`'s `:324` early-return).
- Constants: `SESSION_WINDOW_MAX_BYTES = 4096`, `USER_PROMPT_MAX_BYTES = 256`, `MAX_CHANGED_FILES = 12`.

**Phase 3 — Wire the loader to the builder.** `src/cli/tui/index.tsx:56-64`: `loadSessionSummary` → `loadSessionWindow` calling `buildSessionWindow(readFsConversationEvents(...))`. Call site (`:228`) only renames; gating and `config.repoPath` keying unchanged. The `priorSessionSummary` plumbing (`:241` → `dispatch.ts:170-184` → `runLlmPatchFlow.ts:5955`) is **untouched** — the same field carries a richer string. `extractPriorRunSummary` stays exported (Supabase/HTTP path unaffected).

**Phase 4 — Pluralize framing + suppress double-injection (one finalized commit).** `src/llm/agentLoop.ts`:
- (a) Injected header (`:2002`): `"…prior task in this session:"` → `"…earlier turns in this session:"`.
- (b) Static directive (`:522-526`): pluralize, keep the "COMPLETED — do not re-investigate or re-apply" guard **verbatim**, keep **unconditional**. **Derive the header string and the directive's quoted trigger from a single shared `SESSION_MEMORY_HEADER` constant** so they cannot desync.
- (c) Double-injection suppression (`:2006-2015`): when `sessionMemBlock` is non-empty, suppress the separate `PRIOR RUN CONTEXT` block for the same thread so the newest summary appears **at most once**. Belt-and-suspenders: in `runLlmPatchFlow.ts:~5138`, when `priorSessionSummary` is supplied, skip the `extractPriorRunSummary` FS fallback.
- *Cache impact: a one-time static-prefix change on deploy (one cold-cache run), then re-stable. Directive stays unconditional → no recurring bust. (c) is user-message-only.*

**Phase 5 — Clear GC, resume reconciliation, tests.**
- `/session Clear` already mints a new `sessionId` → empty window; **add** best-effort delete of the prior `sessionId`'s `.jsonl` (bounds file *count* across Clears; never-throw).
- `--resume` reconciliation test with `cwd !== repoPath` (window loads on `config.repoPath`, `loadLastSession` on `process.cwd()` at `index.tsx:118`).
- Tests (extend `agentLoop.sessionMemory.test.ts` + new `sessionWindow.test.ts`): **cache invariant** (`assembleAgentSystemPrompt()` byte-identical for empty / 1-turn / 3-turn windows — make-or-break); empty-window cold-start byte-identity; **anti-redo** (window output contains none of `{APPLY_ROLLED_BACK, rolled_back, reverted, "where the problem", "problem is"}`); **builder purity** (same input → identical output); cap + single-turn degrade; empty-summary skip-and-continue; **repoPath grep** (fail on `process.cwd()`); `threadId` validity.

### 3.5 Cache-safety proof

The window's only LLM-visible bytes are in `userContent` (`agentLoop.ts:2000-2015`); never in `assembleAgentSystemPrompt()`, never in `systemContent`.

- **Breakpoint #1** stays byte-identical: no system-prompt input changes with window presence/length/content; the directive is unconditional; the Phase-4 wording edit is a one-time static change, not a presence toggle (the explicit inverse of the `auditFindings → TRUST_PHASE1_DIRECTIVE` anti-pattern). *(As reasoned when written — see the correction at §1.1: breakpoint #1 is tools-only, so a system-prompt-input change would not have touched it regardless. The design's own choice to keep the directive unconditional is unaffected.)*
- **Breakpoint #2:** the window sits in the persistent first user message, **inside** the cached prefix; built **once** before `responseInput` assembly and **never mutated mid-loop** (`buildSessionWindow` is pure) → write iter 0, read iters 1..N.
- **`isFirstAndTiny` (`cacheControlHelpers.ts:63-70`):** an empty window yields the same cold-start msg[0] as today, preserving existing breakpoint-#2-skip behavior.
- **OpenAI/Gemini (honesty clause):** cache amortization is **Anthropic-only**; the TUI doesn't thread `conversationId` and `runId` is fresh per dispatch, so there is no cross-dispatch window cache there — the window is paid full price each dispatch (still cheap at ~500–1000 tok). Cross-provider caching is a separate `conversationId=sessionId` follow-up, **out of v1**.

### 3.6 Cost estimate (cache-aware)

Worst-case ~1054 input tokens in msg[0], inside breakpoint #2's cached prefix. Anthropic, 13-iter Sonnet dispatch (input ~$3/M; cache-write ~1.25×; cache-read ~0.1×):

- Write (iter 0): 1054 × $3.75/M ≈ **$0.0040**.
- Reads (iters 1–12): 1054 × 12 × $0.30/M ≈ **$0.0038**.
- **Per-dispatch lifetime ≈ $0.0077** — under one cent, **flat in turn count**.

Marginal over today's single summary: **+~$0.002/dispatch worst case**, often near-zero. Naive accounting (1054 × 13 × $3/M ≈ $0.041) overstates ~5× — the cache-math conflation the cost memo warns against. The window does not touch the dominant per-iter `run_command`/`search_in_files`/`read_file` accumulation lever; its only material cost risk is **busting the cache** (a step-function), foreclosed by §3.5 + the standing byte-identical test.

### 3.7 v1 vs deferred

**In v1:** cross-dispatch continuity (course-correct on the next prompt, incl. file-scoped "revert that"); atomic single-event turn records; tiered ≤4096 B window; neutral framing; double-injection suppression; orphaned-file GC; resume/repoPath reconciliation; the cache-invariant regression test.

**Deferred — mid-dispatch interjection** (redirect a *running* loop). Three independent, cache-/control-flow-invasive subsystems: (1) mutating `responseInput` mid-loop **busts breakpoint #2 on every interjection**; (2) it needs an **in-run input channel** — today **Esc aborts** (`App.tsx` `RUN_ABORTED`), there is none; (3) it needs **mid-run re-planning** (the plan is fixed at dispatch start). v1 operates at **dispatch boundaries only**, where the proven seam already guarantees cache safety — delivering ~90% of the value at ~5% of the complexity.

**Deferred — cross-provider (OpenAI/Gemini) cross-dispatch cache:** thread `conversationId=sessionId`; must avoid re-enabling the rollback-framing loader (`index.tsx:224` warns); not coupled to v1.

---

## Part 4 — Risk table

| # | Risk | Severity | Why it bites here | Mitigation |
|---|------|----------|-------------------|------------|
| R1 | **Cache busting via system-prompt toggle** (make-or-break) | **Critical** | Any future edit keying system content on window presence (the `auditFindings → TRUST_PHASE1_DIRECTIVE` anti-pattern, `agentLoop.ts:577`) turns sub-cent cost into a full ~3879-tok prefix re-write every iter *(breakpoint attribution unconfirmed — see the correction at §1.1; the mitigation holds regardless)* | Window bytes live **only** in `userContent`; directive (`:522-526`) stays **unconditional + byte-stable**; **standing test** asserts `assembleAgentSystemPrompt()` byte-identical for empty/1-turn/3-turn; comment tag: "edit this text in ONE commit only — every wording change is a global cold-cache reset" |
| R2 | **Within-run breakpoint-#2 bust** | High | A builder called per-iter, or an embedded timestamp/"as of iter N", mutates msg[0] every iteration | `buildSessionWindow` is **pure** (no `Date.now`/random), built **once** before `responseInput` assembly; unit test: same input → byte-identical output |
| R3 | **Cost blow-up / double-injection** | High | `sessionMemBlock` + the separate `PRIOR RUN CONTEXT` block both inject the newest summary (`:2006-2015`) | Phase 4(c) suppresses `PRIOR RUN CONTEXT` when `sessionMemBlock` non-empty (test: newest summary appears **at most once**); global **4096 B assembled-window cap** makes cost O(1) in turns |
| R4 | **Framing drift → re-do** | High | Reusing `truncatePriorRunSummary` surfaces `APPLY_ROLLED_BACK` under a neutral header; `decisionMode` tags re-import rollback vocabulary | **New `truncateSessionTurn`** strips surviving markers → "(no net change remained…)"; older turns rendered **intent + paths only**, no outcome tag; directive keeps "do not re-investigate or re-apply" verbatim; anti-redo regression test forbids rollback vocabulary in window output |
| R5 | **repoPath vs cwd** | High | `config.repoPath` diverges from `process.cwd()` under `--repo`/`ZONE_REPO_PATH` (`config.ts:82`); copying the SIGTERM/diskTrust `process.cwd()` pattern (`index.tsx:83`) would write to the wrong dir → permanently empty window | New write **and** load use `config.repoPath` verbatim (copy `:228`/`:272-273`, never `:83`/`:118`); test greps the write site and **fails on `process.cwd()`**; resume-path reconciliation test |
| R6 | **Writer correctness / fire-and-forget race** | High | `onSubmit = void runPrompt`; a submit-time write could race the prior turn's post-run write via the non-atomic read-trim-rewrite (`store:84-109`) | **Single event written post-run only** — no two-write race, no interleave; `runId` for ordering-tie disambiguation; boolean return checked under `ZONE_TUI_DEBUG=1` |
| R7 | **Rotation pair-split** | Medium (eliminated) | A 50-line cap dropping a turn's user-half but keeping its summary-half → mis-pairing | **Single atomic `{type:"turn"}` event** = a turn is one line; rotation drops only a **complete oldest turn**; cap is turn-aligned (~50 turns) |
| R8 | **Orphan / aborted / no-summary turns** | Medium | Question/no_change/aborted dispatches produce no `patchPreview` | Post-run write records the turn with `summary:""` + neutral `outcome`; aborted runs (no `runResult`) record nothing (no fabricated state); builder skips empty-summary events and continues |
| R9 | **Empty-summary loader short-circuit** | Medium | `extractPriorRunSummary` returns `""` on the first empty summary (`:324`), hiding older history | New builder walks raw events and **skips-and-continues**; unit test: `[turn(summary=""), turn(summary="real")]` → window contains "real" |
| R10 | **Orphaned `.jsonl` growth across Clears** | Low | Each Clear mints a new `sessionId`; old files never deleted → unbounded file *count* | Phase 5: best-effort delete/prune the prior `sessionId`'s file on `SESSION_MEMORY_CLEAR` (never-throw) |
| R11 | **Single-turn-over-cap starves the window** | Low | A pathological newest summary near 4096 B leaves no room | Builder **degrades Tier A's summary to fit** — newest turn always representable |
| R12 | **threadId invalidity (silent empty window)** | Low | A future `sessionId` minting change breaking `THREAD_ID_PATTERN` makes every window silently empty | Test asserts live `sessionId` minting satisfies `THREAD_ID_PATTERN` |
| R13 | **Misdirection: compaction headroom as the cost defense** | Low | Citing "<1% of Haiku's trigger" obscures the real cache-bust risk (R1) | Compaction headroom documented as **context only**; the cost defense is cache amortization (§3.6); the binding risk is R1 |

---

**Net shape:** one atomic turn event written post-run; a pure, tiered, 4096 B-capped neutral window builder; injected unchanged through the proven `priorSessionSummary` seam into the first user message; the static directive pluralized once and kept unconditional; the newest summary de-duplicated against the rollback block. Every adversarial non-negotiable is honored — window bytes live only in `userContent`; the directive stays unconditional and byte-stable; the newest summary appears at most once; the window is built once and never mutated mid-loop; turns are atomic in the log; load and write key on `config.repoPath`; empty windows are byte-identical to today's cold start; and no rollback vocabulary reaches the rendered window.
