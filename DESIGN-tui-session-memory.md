# DESIGN — TUI Session Memory (conversation continuity across submissions)

**Status:** Design proposal. Investigation- and adversarially-grounded (6-agent code trace + 4-agent red-team; all load-bearing claims verified against source with file:line). NO code changed.

**Scope:** TUI-first (`src/cli/tui/`, `src/cli/dispatch.ts`, `src/core/runLlmPatchFlow.ts`, `src/llm/agentLoop.ts`). Does **not** touch `src/ui/` (Web UI) or the hosted/server path except by reusing its primitives.

---

## 1. Context

Today the TUI is a **one-shot dispatcher**: each submission mints a fresh `runId` (`index.tsx:176`) and calls `runOneShotInner` with **no `conversationId` and no transcript** (`index.tsx:205`). The cross-run load gate in `runLlmPatchFlow.ts:5107-5158` keys on `input.conversationId`; with it empty, `threadIdForLoad === ""`, so `priorRunSummary` stays `""` and submission #2 starts blind. You cannot say "now also do X" or "no, the other file" — each task is context-isolated.

We want submission #2 to build on #1 **without** destroying Zone's bounded per-task cost profile (the thing that makes the TUI cheap and CI-friendly). The good news, established by the investigation: Zone **already has** a compressed, cache-safe, cost-bounded cross-run memory mechanism on the hosted path. The TUI just doesn't write to it or turn it on. This design **reuses that machinery** and adds the one missing piece (a CLI-side write) plus a neutral framing and an opt-in toggle.

### What already exists (verified)

| Mechanism | Location | Fact |
|---|---|---|
| Compressed summary, **not** replay | `applyRollbackFeedback.ts:316-328`, `:275-307` | `extractPriorRunSummary` returns the single most-recent `{type:"agent_summary"}` event, hard-capped to `PRIOR_RUN_SUMMARY_MAX_BYTES = 2048`. No accretion. |
| Two-layer load | `runLlmPatchFlow.ts:5107-5158` | Supabase (needs `SUPABASE_URL`+`userId`) → **filesystem fallback** `readFsConversationEvents` (`.zone/conversations/<threadId>.jsonl`). Self-host uses the FS layer. |
| Cache-safe injection | `agentLoop.ts:1992-2011` | Summary is prepended to the **first user message** (`userContent`), never the system prompt. `systemContent = baseSystemContent` (byte-stable). |
| FS store primitives | `conversationFilesystemStore.ts:67-110`, `:119-149` | `appendFsConversationEvent` / `readFsConversationEvents` — atomic, never-throw, 50-event rotation, path-traversal-guarded, `isValidThreadId` accepts a UUID. |
| FINAL SUMMARY capture | `runLlmPatchFlow.ts:6326-6332` | `result.patchPreview = "=== AGENT LOOP SUMMARY ===\n" + loop.summary` (the agent's own COMPACT/DETAILED block, verification tag already stripped on the verified path). |

### The two gaps

1. **Write is server-only.** `appendFsConversationEvent` is reachable only via `logRun → persistAgentSummaryToFilesystem` (`runLogging.ts:74-100`), which is gated on `decisionMode === "rolled_back"` and called **only** from `server.ts`/`worker/index.ts`. The CLI/TUI path never writes the JSONL the load would read. (Verified: zero `logRun`/`appendFsConversationEvent` references under `src/cli/`.)
2. **Framing is rollback-flavored.** The existing injection wraps the summary in `"PRIOR RUN CONTEXT — your last attempt... prior context = WHERE the problem is"` and the static directive at `agentLoop.ts:514-518` tells the agent to "start from those errors." Feeding a **successful** run's summary into that frame would make the agent treat a completed task as an unsolved problem and re-investigate it — especially for an *unrelated* submission #2. (Red-team R4: this is the one genuine behavioral side-effect.)

---

## 2. Design

### 2.1 Memory representation

**Phase 1 — single-prior (the core).** The injected memory is exactly **one** event: the previous run's FINAL SUMMARY (`stripBanner(result.patchPreview)`), stored as `{type:"agent_summary", ts, text}`, hard-truncated to ≤2048 bytes. Because each run's `loop.summary` is a *fresh* description of that run's own task (`composer.ts:154` — `verdict.strippedText + summaryAppendix`, no prior-summary concatenation), **there is no run-over-run accretion** — run N's stored summary does not embed run N-1's. Single-prior is sufficient for the stated UX ("now also do X" / "no, the other file" all refer to the immediately prior run).

**Phase 3 — cumulative (optional upgrade).** For longer-range recall ("the auth refactor from 5 tasks ago"), accumulate prior task-prompts + per-run summaries into `DiskSession.accumulatedSessionSummary`, compressed by `summarize()` when it exceeds a byte cap.

**Bounding strategy:**
- Phase 1: free on the read side — `truncatePriorRunSummary` caps the injection at 2048 bytes regardless of write size. **Additionally truncate on write** (disk hygiene: a `detailed` summary targets ~2500 chars > 2048, so cap before append to keep the 50-event file small).
- Phase 3: reuse `summarize()` (`summarizer.ts:96-123`) standalone — wrap the accumulated string in one `ChatCompletionMessageParam` turn, supply a **session-shaped sibling prompt** (the built-in `buildSummarizationPrompt` is run-shaped: "the agent will continue executing after your summary"). **Mandatory guard:** apply a hard byte cap at the injection site — do NOT rely on `summarize()`'s soft "under 600 words" instruction (it is unenforced and the call can fail). Also cap `accumulatedSessionSummary` on write so it cannot grow between compressions.

### 2.2 Threading (exact wiring)

The read path already exists end-to-end; we add a **neutral-framed** field and the **write**.

| # | File / function | Change |
|---|---|---|
| 1 | `src/cli/config.ts` — `CliConfig` | Add `memoryEnabled?: boolean` next to `summaryFormat`. |
| 2 | `src/api/diskModel.ts` — `DiskModelSettings` | Add optional `memoryEnabled?: boolean`. **Keep `version: 2`** (additive optional, like `summaryFormat`). |
| 3 | `src/cli/tui/index.tsx` — startup (`~85`) + `onModelApply` (`~255`) | Hydrate `config.memoryEnabled` from `diskModel`; re-apply on toggle (mirrors `effort`/`summaryFormat`). |
| 4 | `src/cli/tui/index.tsx` — `runPrompt` (`~205`) | When `memoryEnabled`, pass `conversationId: <sessionId captured at submit>` into `runOneShotInner` opts. (dispatch already forwards `opts.conversationId` → `runLlmPatchFlow`, `dispatch.ts:172`.) |
| 5 | `src/core/runLlmPatchFlow.ts` — input + load | Add `priorSessionSummary?: string` input. A small new load (reusing `readFsConversationEvents` + `extractPriorRunSummary` + `truncatePriorRunSummary`) populates it from `.zone/conversations/<sessionId>.jsonl`. **Leave the existing `priorRunSummary`/rollback path untouched** (it is a protected J.5 recovery channel). |
| 6 | `src/llm/agentLoop.ts` — input + `userContent` (`~1992`) | Add `priorSessionSummary?` to `AgentLoopInput`; inject it at the **same `userContent` location** under a **neutral `SESSION MEMORY` header** (no "where the problem is" directive). ~15 lines, cache-safe. |
| 7 | `src/cli/tui/index.tsx` — `runPrompt` write | Capture `const result = await runOneShotInner(...)`; on success + `memoryEnabled`, `appendFsConversationEvent({ repoPath: config.repoPath, threadId: sessionId, event: { type:"agent_summary", ts, text: truncatePriorRunSummary(stripBanner(result.patchPreview)) } })`. |
| 8 | `src/cli/tui/index.tsx` — new helper | `stripBanner(s)`: strip a leading `=== AGENT LOOP SUMMARY ===\n` (and tolerate the legacy `=== LLM PATCH PREVIEW ===` shape at `runLlmPatchFlow.ts:~11095`). |
| 9 | `src/cli/tui/components/Composer.tsx` + store | `/memory` slash command + a small modal/toggle (mirror `/summary`); blocked during an active run. |

**Why a new `priorSessionSummary` field instead of reusing `priorRunSummary`?** The red-team (R4) showed that routing a success summary through the existing `priorRunSummary` → "PRIOR RUN CONTEXT" frame makes the agent re-investigate completed work. A parallel field with a neutral header decouples session-memory from rollback-recovery while still reusing the store, the extract/truncate functions, and the exact cache-safe injection point. This is the one place the original "zero agentLoop changes" goal yields ~15 lines — a deliberate, validated trade.

### 2.3 Persistence

- **Across submissions (Phase 1):** `.zone/conversations/<sessionId>.jsonl` (per-repo, gitignored, 50-event rotation). The TUI's stable `sessionId` (`store.tsx:110`, a UUID generated once and never reassigned) is the `threadId`. The same file is written after each run and read at the start of the next.
- **Across `--resume`:** free. `sessionId` is preserved on resume (`store.tsx:442` `SESSION_RESUME`; `index.tsx` `resumedSessionId`), so the same JSONL file is found — memory continues naturally with no extra wiring.
- **Phase 3 cumulative:** `DiskSession.accumulatedSessionSummary` (`~/.zone/sessions/<ISO>-<uuid8>.json`). Additive optional field persists for free through `buildDiskSession` (`index.tsx:121`, the single write-mapper for all three save sites) and loads for free (`loadLastSession`). Restoration needs parity edits at **both** resume entry points (`buildInitialState` for `--resume`, `SESSION_RESUME` reducer for `/sessions`).

### 2.4 Cache-safe placement (verified — R1 holds)

Inject at `agentLoop.ts:1992` into the **first user message** (`userContent`), alongside where `PRIOR RUN CONTEXT`/`AUDIT CONTEXT` already go, then `input.task`.

- **Breakpoint 1 (static system+tools)** is anchored on the last tool (`convertParams.ts:124-137`); the system stream is extracted separately (`extractSystem`, `:194-214`). The summary lives in a user message → **breakpoint 1 is byte-identical** whether memory is on or off. `assembleAgentSystemPrompt` takes **no** summary parameter (`agentLoop.ts:380-398`) — do **not** add one, and do **not** put the summary where `projectMemoryBlock` goes (system), or it busts the static prefix.
  **Cache-boundary correction (`docs/deferred-work.md` item 161):** breakpoint 1 covers tools
  alone, not system+tools — measured against the per-call usage log. A system-prompt change
  cannot bust a cache keyed on an unchanged tools array; the placement rule above is very
  likely still right, but more plausibly guards breakpoint 2's own cumulative span, not
  breakpoint 1. Unconfirmed this pass — offered as a starting point for re-examination.
- **Breakpoint 2 (conversation)** anchors on the last *non-manifest* user message (`cacheControlHelpers.ts:42-56`). `userContent` is built once before the loop (`agentLoop.ts:1992`, loop starts `:2441`) and never mutated per-iter, so it becomes a **stable cached prefix**; from iter 2 the marker moves forward to tool-result blocks (`convertParams.ts:309-333`). No per-iter bust.
- **Two hard constraints:** (a) the summary must not be prefixed with `## Files already read this run` (the manifest classifier, `cacheControlHelpers.ts:9-21`); (b) keep it small (it is a one-time cache *write* per session on iter 1).

### 2.5 Cost analysis

Let **N** = number of prior submissions in the session.

| Mode | Per-submission memory overhead | Scaling |
|---|---|---|
| **Stateless (today)** | 0 | — |
| **Phase 1 (this design)** | ≤2048 bytes (~512 tok) in the first user message, a one-time cache **write** at ~1.25× input rate on iter 1, then prefix-cached for all later iters. ~sub-cent. **Does not touch the shared tools prefix** (not "system+tools" — item 161). | **O(1)** — independent of N (single-prior + hard 2KB cap). |
| **Phase 3 (cumulative)** | ≤ cap C (e.g. 2–4KB) one-time write, + an occasional `summarize()` call at run-close (cheap model, only when the cap is exceeded). | **O(1)** in N (compression keeps it flat). |
| **Naive transcript-replay (REJECTED)** | Re-sends all prior turns; tool results alone are ~10–50KB/run. | **O(N) → superlinear**: busts breakpoint-2 cache every iter (new content), overflows the context window → triggers intra-run compaction (extra LLM calls) or fails. |

The design is **asymptotically strictly better** than replay and preserves the measured stateless profile exactly when memory is off.

### 2.6 Mode toggle (opt-in, default OFF)

- Persisted in `DiskModelSettings.memoryEnabled` (mirrors `summaryFormat`/`effort`); **absent ⇒ `undefined` ⇒ off**, so existing users and CI are byte-identical to today.
- **Default-off correctness is verified (R3):** when off, no `conversationId` is passed → both load branches no-op → `priorSessionSummary` empty → `agentLoop` takes the no-memory branch. No code path writes or reads the conversation store without the toggle. (`logRun` is unreachable from the TUI; Supabase clients are null without env.)
- Toggle surface: a `/memory` slash command (on/off + status), blocked during an active run like other modals.

### 2.7 UX

- **Turn on:** `/memory on` (persists to `~/.zone/model.json`); stays on across launches.
- **Know it's on:** a small StatusBar pill (e.g. `🧠 memory`) when `memoryEnabled`.
- **Start fresh:** `/memory clear` mints a **new `sessionId`** (and optionally truncates the current `.jsonl`), so the next submission has no prior context — the clean "new conversation" affordance. (Phase 2.)

---

## 3. Phased plan

Each phase is independently landable and testable; smallest valuable slice first.

### Phase 1 — Single-prior session memory (the feature)
**Delivers:** submission #2 sees submission #1's FINAL SUMMARY; opt-in; cost-bounded; cache-safe; survives `--resume`.

Steps: items 1–9 in §2.2. Reuses the store, `extractPriorRunSummary`, `truncatePriorRunSummary`, and the injection location; adds the neutral `priorSessionSummary` field + header (~15 lines in `agentLoop`), the CLI write, `stripBanner`, and the `/memory` toggle.

**Required fixes folded in (from red-team), do NOT skip:**
- **Key the WRITE on `config.repoPath`, not `process.cwd()`** — the read uses `input.repoPath` (`= effectiveConfig.repoPath`); with `--repo`/`ZONE_REPO_PATH` set they diverge and the round-trip silently breaks (R3).
- **Neutral `SESSION MEMORY` framing from day one** — do not reuse the rollback "PRIOR RUN CONTEXT / where the problem is" frame for success summaries (R4).
- **Capture `sessionId` at submit time** (thread it through `onSubmit`→`runPrompt`, or guard on non-null `storeCapture.state`) — `storeCapture.state` is null until `onStateChange` fires, which can drop run #1's write key (R3).
- **Truncate on write** (`truncatePriorRunSummary(stripBanner(...))`) — disk hygiene for `detailed`-format summaries (R2).

**Protected zones / invariants:**
- Do **not** modify the existing `priorRunSummary` / rollback path (J.5 recovery; `applyRollbackFeedback.ts`, `runLlmPatchFlow.ts:5942-5949`).
- Do **not** add the summary to `assembleAgentSystemPrompt` / `systemContent` / `projectMemoryBlock` (busts breakpoint 1 as originally reasoned here; item 161 finds breakpoint 1 covers tools alone, so the more plausible risk is breakpoint 2 — unconfirmed, this constraint is not re-examined here and should still be honored).
- Keep `DiskModelSettings.version === 2` (`loadDiskModel` rejects on mismatch).
- The `[ZONE_VERIFICATION]` tag and verdict derivation are untouched (memory is prompt-input only).

**Tests:** unit — `appendFsConversationEvent` then `readFsConversationEvents`+`extractPriorRunSummary` round-trips a non-rollback `agent_summary`; with `memoryEnabled=false` no write occurs and load no-ops (byte-identical prompt); `stripBanner` handles both banner shapes; write/read key on the same `repoPath` under a simulated `--repo`. Prompt-assembly test — `priorSessionSummary` set ⇒ neutral `SESSION MEMORY` block present in `userContent`, absent in `systemContent`, breakpoint-1 prefix unchanged.

### Phase 2 — Robustness + UX
**Delivers:** the StatusBar memory pill; `/memory clear` (new `sessionId`); optionally persist the summary on **all** terminal states (not just `natural_completion`), distinguishing organic FINAL SUMMARYs from synthesized fallback summaries; optionally surface "memory: on" in the `/sessions` modal.

**Protected zones:** the safety-net `agent_loop_complete` (no `detail`) path — prefer the captured `result.patchPreview` return value over the bus event so a throwing run doesn't poison memory.

**Tests:** `/memory clear` yields empty `priorSessionSummary` next run; pill reflects state.

### Phase 3 — Cumulative multi-run memory (optional)
**Delivers:** recall across the whole session, not just the last run. Accumulate prompts+summaries into `DiskSession.accumulatedSessionSummary`; compress via `summarize()` (session-shaped sibling prompt, cheap model tier, run asynchronously at run-close **before** `saveSession` — not inside the sync SIGINT handler); thread via the same `priorSessionSummary` field.

**Mandatory guards (R2 — Phase 3 breaks the bound without these):**
- Hard-truncate `priorSessionSummary` at the injection site (do not trust `summarize()`'s soft word budget; it is unenforced and the call can fail).
- Cap `accumulatedSessionSummary` on write so it cannot grow unbounded between compressions.

**Protected zones:** resume parity — restore the field at **both** `buildInitialState` (`--resume`) and `SESSION_RESUME` (`/sessions`); `saveSession` is gated on `transcript.length > 0`, so keep the summary in-band with transcript growth.

**Tests:** accumulation + compression keeps injected size ≤ cap across many runs; resume restores the field at both entry points; cost stays O(1) in N.

---

## 4. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Rollback-frame leakage** — success summary read as "where the problem is" → agent re-investigates completed/unrelated work | High (correctness + cost) | Neutral `SESSION MEMORY` framing in **Phase 1** (R4). |
| **repoPath key divergence** — write keyed on `process.cwd()`, read on `input.repoPath`; silent no-memory under `--repo`/`ZONE_REPO_PATH` | High (silent) | Key write on `config.repoPath` (R3). |
| **Summary staleness vs. disk reality** — the agent sees *intent-via-summary* from run N-1, but the working tree may have changed (manual edits between submissions); summary describes what *was* done, not current code state | Medium | Summary is explicitly framed as "prior session context," not ground truth; the agent still reads files. Document that memory is intent, not a code snapshot. |
| **Summary accuracy** — a wrong/over-confident FINAL SUMMARY misleads the next run | Medium | Single-prior bounds blast radius to one run; `/memory clear` resets; summary is advisory context, not a directive. |
| **`detailed` format > 2048B** — head of a detailed summary is tail-truncated on read | Low | Acceptable; `compact` (≤900B) fits whole. Truncate-on-write keeps the file lean. |
| **Cache:** new summary is a per-session cache *write* (not hit) on iter 1 | Low (expected) | Sub-cent, one-time; does not touch the shared static prefix (R1). |
| **Cross-task confusion in one session** — submission #2 on an unrelated task still gets #1's summary | Low/Medium | Neutral framing makes it advisory; `/memory clear` for a clean break; (future) heuristic to skip injection when the new task is clearly unrelated. |
| **Phase 3 unbounded growth** — `summarize()` soft budget unenforced / can fail | High (Phase 3 only) | Hard truncate at injection + cap on write (R2). |
| **No side-effects from `conversationId`** (planner ranking, OpenAI cache key, billing, Supabase) | None (verified) | R4: complete consumer list is debug-log + memory-load + agentLoop-forward + OpenAI cache-key; no write/billing consumer in the TUI path; planner filters to `type:"user"` events which we never write. No guard needed. |

---

## 5. Validation status

- **Investigation:** 6-agent code trace (priorRunSummary e2e, FS store, TUI path, FINAL SUMMARY capture, cache structure, compaction/sessions) — all claims carry file:line + verbatim quotes.
- **Red-team:** 4-agent adversarial review — R1 cache **holds**; R2 cost, R3 round-trip, R4 side-effects **hold-with-caveat**, every caveat folded into the plan above as a required fix.
- The recommended approach satisfies all four hard constraints: **(1)** summary-based & 2KB-capped, not replay; **(2)** injected after the cached static prefix, breakpoints intact; **(3)** opt-in, default off, stateless preserved; **(4)** reuses the existing store + extract/truncate + injection location (the only genuinely new code is the CLI write, a neutral-framed field, and the toggle).
