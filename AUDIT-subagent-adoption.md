# AUDIT — Subagent dispatch: why adoption is ~0%

Read-only diagnosis. No code changed. Cost is the primary lens throughout.

## Headline

~0% adoption is **mostly correct, with one real latent bug.** Two things are true at once:

1. **Hard exposure gate (the bug):** the `Task` tool is **effectively complex-tier-only.** For
   `medium`-tier tasks — the classifier's *fallback default* and the bulk of real single-feature
   work — `Task` is **filtered out of the toolset entirely**, even though the medium tier *budgets*
   `maxSubagentCalls: 1`. The tier **tool subset** and the tier **subagent budget** contradict each
   other; the budget is dead config. So on a typical task the agent **never sees the tool** — it
   can't adopt what isn't there. This dominates the directive-strength explanation.

2. **Cost makes the gate largely the right outcome anyway:** even where `Task` *is* exposed, a
   dispatch rarely **saves** on a typical Zone task. The worker gets a **fresh context** (no parent
   prompt-cache inheritance), so it **re-reads** files the parent already loaded, and returns a
   **lossy ≤500-char summary** the parent must act on blind. The single best case (bulk same-edit
   fanout) is already served more cheaply by **`multi_edit`**. The genuine win is narrow: a long,
   independent, read-heavy step on a genuinely complex task — which is exactly where it *is* exposed.

**Recommendation (preview):** don't drive broad adoption. **Fix the contradiction** (make the system
honest: either expose `Task` at medium where the budget already permits it, or delete the unreachable
medium budget and document `Task` as complex-only), and only widen exposure behind a measured
complex-task dogfood that proves dispatches actually save. See §D.

---

## A. End-to-end machinery map (tool → dispatch → worker → results → telemetry)

### The tool
`Task` — `src/tools/toolDefinitions.ts:429-459`. 142-char description: *"Delegate to subagent.
worker: multi-file impl (read+write). explore: read-only investigation… Only for non-trivial
tasks."* Params: `subagent_type: "worker"|"explore"`, `description: string`. The description tells the
model the **subagent does not see your conversation history… include all necessary context** — i.e.
the worker starts cold.

### The directive (system prompt)
`TASK SUBAGENTS` block — `agentLoop.ts:553-556`, **582 chars, unconditional in patch mode**
(`assembleAgentSystemPrompt`, not chat/investigation). Verbatim:
> `TASK SUBAGENTS (Task) — dispatch cap: 2/run (WORKER_MAX_ITER=6). GOOD signals: step marked
> subagentEligible: true…; same change across 5+ files (multi_file_fanout…); step requiring 10+
> parent iterations (long_isolated_step…). BAD signals (stay single-thread): 1-2 file edits…
> DISPATCH REASON required — prefix Task description: "multi_file_fanout: …" or "long_isolated_step: …".`

It sits ~60% into the prompt (after PATCH RULES / TEST FAILURES). The dispatch-reason prefix is
parsed by `extractDispatchReason` (`subagentDispatch.ts:32-38`) recognizing
`multi_file_fanout|exploration|long_isolated_step`, else `"manual"`.

### Dispatch path
`Task` call → `toolExecutor.ts:~812-907`: emits `subagent_started`, then recurses via
`runAgentLoop({ task: description.trim(), … })` — **only the description string**, plus a fresh
worker system prompt (`buildWorkerAgentIntro`/`buildExploreAgentIntro`, `agentLoop.ts:741-796`), a
restricted toolset (`WORKER_ALLOWED_TOOLS` = read_file/list_files/search_in_files/apply_patch/
write_file; explore = read-only 4; `subagents.ts:4-12`), the shared `runId`, the parent's
`stagingFiles` (worker edits merge into the parent staging map), and `tokenBudgetBaseTokens` (so the
cumulative cap spans parent+worker). Worker iter caps: worker 6, explore 15. No nested dispatch
(blocked at `toolExecutor.ts:775-782` + `Task` absent from `WORKER_ALLOWED_TOOLS`).

### Worker model routing (U.2.A)
`modelRouting.ts` defaults: `worker: "claude-haiku-4-5"` (Anthropic) / `"gpt-5.4-mini"` (OpenAI).
Selection (`toolExecutor.ts:~867-875`): worker inherits the parent's `modelOverride.standard` if set
(e.g. a quality preset forces Sonnet), else the role default (**Haiku**). Explore runs use the
default agent model.

### Results back to parent
Worker returns a JSON summary (`formatSubagentToolResultForParent` / `formatSubagentSummaryForParent`,
`subagents.ts:220-228`): `{ subagentId, status, summary (≤500 chars), tokenUsage, costUsd,
filesModified, notes }`. `handleSubagentResult` (`subagentDispatch.ts:104-163`, called from
`handleToolResult.ts:~85-130`) merges `filesModified` into the parent set and propagates worker
tokens/cost into the parent budget (`TokenBudgetMeter.recordSubagentResult`). **The parent re-ingests
the summary JSON as the tool result — not the worker's reads or diffs.**

### Telemetry
- `[zone-subagent-dispatched]` (`subagentDispatch.ts:62`, via `handleToolResult.ts:21`) — **gated on
  `name === "Task" && result.success`.** Payload: `{ subagentType, workerModel, dispatchReason, iter }`.
  **This is the adoption counter.**
- `[zone-subagent-token-propagated]` / `[zone-subagent-cost-propagated]` — accounting.
- `subagent_started` / `subagent_completed` structured events (`toolExecutor.ts:~855,~936`) → TUI sink
  renders `↳ subagent started` / `↳ subagent <status>` (`sink.ts:345-354`). Phase F streams the
  worker's tool-input deltas tagged by `subagentId`.

---

## B. Root-cause diagnosis (ranked)

### #1 — `Task` is not in the toolset for simple/medium tasks (hard gate). **Dominant.**

Filter resolution in `agentLoop.ts:1608-1647`:
```
tierFilterFromClassifier = tierToolFilter(tier)            // medium → { allowToolNames: MEDIUM_TIER_TOOLS }
effectiveFilter = input.capabilityFilter ?? tierFilterFromClassifier ?? …
resolvedTools  = resolveToolList(effectiveFilter)          // allowlist → only the named tools
toolsForLLM    = resolvedTools without (excludeTools | (taskBlockedByBudget && "Task"))
```
`MEDIUM_TIER_TOOLS` (`tierToolSubsets.ts:14-24`) is a 9-tool **allowlist that does not contain
`Task`.** `allowToolNames` is positive (`capabilities.ts:31` "must appear in `allowToolNames`"), so
`resolveToolList` returns only those 9 — `Task` is gone **before** the `maxSubagentCalls` gate is even
consulted (line 1643 is moot). The only rescue would be the dispatcher passing an *exclude-based*
`input.capabilityFilter` (which bypasses the tier allowlist). It doesn't, for any patch archetype:

| Tier | Archetype | pipeline → `_dispatcherExcludeTools` | `effectiveFilter` | `Task` exposed? |
|---|---|---|---|---|
| simple | any | budget=0 + simple allowlist | simple allowlist | **No** |
| medium | targeted_fix | allowSub=**true**, allowScope=**true** → **undefined** | **medium allowlist** | **No** |
| medium | refactor | same → undefined | medium allowlist | **No** |
| medium | debug | no pipeline → undefined | medium allowlist | **No** |
| medium | complex_multi_file | no pipeline → undefined | medium allowlist | **No** |
| medium | question/investigation | readOnly → excludes Task + writes | exclude-based | No |
| complex | any | (no tier allowlist) | **undefined → full toolset** | **Yes** |

Evidence the exclude set is empty for the dispatchable archetypes: `TARGETED_FIX_PIPELINE` /
`REFACTOR_PIPELINE` set `allowSubagentDispatch: true` **and** `allowScopeRevision: true`, no
`readOnlyPipeline` (`archetypeDispatcher.ts:59-85`); the builder
(`runLlmPatchFlow.ts:~5908-5922`) only adds to the set when those are false, so it returns `undefined`
→ no `capabilityFilter` → the medium allowlist applies → `Task` filtered.

**The contradiction:** `TIER_LIMITS.medium.maxSubagentCalls = 1` (`tierLimits.ts`) advertises a
dispatch budget the tool subset makes unreachable. Corroborating tell: the gate test suite proves
`forceTier="simple"` → `Task` absent and `forceTier="complex"` → `Task` present
(`agentLoop.subagentBudgetGate.test.ts` T.1/T.2), but **there is no `medium` test** — the silent
exclusion lives in the untested middle. Net: on the classifier's *default* tier, the agent never sees
`Task`. **This alone explains ~0% far more than directive placement.**

### #2 — Even when exposed, dispatch usually isn't the cheaper choice. **Secondary, but reinforcing.**
See §C. A fresh-context worker re-reads files and returns a lossy summary; `multi_edit` already
covers the best fanout case. So the agent on a *complex* task (where `Task` IS exposed) frequently —
and **correctly** — declines. This is a genuine effectiveness/cost ceiling, not just frequency.

### #3 — Directive describes a tool that's usually absent. **Tertiary.**
The `TASK SUBAGENTS` block is present and unconditional in patch mode (good), but for every
simple/medium run it documents a capability **not in the toolset** — wasted prompt bytes and a small
coherence cost, never an adoption driver. (Contrast TodoWrite's `planProgressBlock`, whose tool *is*
in the medium subset — so its directive describes something callable, and adoption followed.)

### Frequency vs effectiveness
The ~0% is **frequency** (Task absent for simple/medium) compounded by **effectiveness** (when present
at complex, dispatch rarely wins on cost). When a dispatch *does* fire (tests / a hand-built complex
fanout), the mechanism works — files merge, tokens/cost propagate, no-recursion holds. So it's not
broken; it's **unexposed where common and unattractive where exposed.**

---

## C. Cost analysis (primary lens)

**Per-dispatch shape.** A worker is a *fresh* `runAgentLoop` seeded with only the `description`
string + worker system prompt (~1.2 KB) + 5 tool schemas. It does **not** inherit the parent's
prompt cache or already-read files (`toolExecutor.ts` passes `task: description.trim()` only). So:

- **Re-read tax:** any file the parent already read, the worker must **re-read** — fresh input
  tokens, at Haiku rate. The parent's expensive context isn't reused; it's partially *re-acquired*.
- **Worker model:** Haiku 4.5 by default (≈ order-of-magnitude cheaper input, ~3× cheaper output than
  Sonnet; far cheaper than Opus). Within its own ≤6 iters the worker caches its own prefix; the first
  iter pays it uncached (small).
- **Summary round-trip:** result is a ≤500-char JSON summary. The parent acts on the summary +
  `filesModified`, **not** the worker's diffs/reads — a coordination/quality tax (possible rework if
  the summary is insufficient).

**SAVE vs ADD.**
- **Saves** only when the subtask is (a) genuinely independent of parent context, (b) read-heavy /
  long (≥10 parent-iters of grind), and (c) big enough that *Haiku tokens for re-read + work* <
  *Sonnet/Opus tokens to do it inline*. That's the `long_isolated_step` case — and it's plausibly net
  positive there.
- **Adds / neutral** for the typical medium task: small scope, needs parent context (→ re-read tax),
  dispatch overhead (worker prefix + cold reads) and the lossy-summary tax exceed the inline cost.
- **Cannibalized win:** the headline `multi_file_fanout` (same edit across N files) is already done by
  **`multi_edit`** in *one* tool call on the parent (CLAUDE.md: `multi_edit` cross-file, `805e39f`) —
  cheaper than spinning a worker that re-reads all N files. So the directive's strongest "GOOD signal"
  is largely obsolete.

**Conclusion:** broad adoption would, on the current task mix, **add cost more often than it saves.**
The existing complex-tier-only exposure is *accidentally* the cost-right envelope. Driving adoption is
only worth it if a measured complex dogfood shows real savings on the `long_isolated_step` shape.

---

## D. Recommendation

**Do not drive broad adoption. Fix the contradiction, then gate any widening on measured savings.**

**Phase 0 — make the system honest (small, correctness).** The medium `maxSubagentCalls: 1` is
unreachable dead config. Pick one:
- **0a (recommended): delete the dead budget + document complex-only.** Set
  `TIER_LIMITS.medium.maxSubagentCalls = 0` (matches reality) and add a one-line comment that `Task`
  is intentionally complex-tier-only (exposure via the full toolset at complex; medium/simple use the
  allowlists). Add the missing `forceTier="medium"` → `Task` absent test to lock it. Net: the budget
  and the toolset stop contradicting each other; ~0% at medium becomes *by design*, not by accident.
- **0b (only if §E proves savings): genuinely expose `Task` at medium.** Add `"Task"` to
  `MEDIUM_TIER_TOOLS` (or have the targeted_fix/refactor pipelines pass an exclude-based filter so the
  full toolset shows). This is the *real* "drive adoption" lever — but it should not ship until §E
  shows complex dispatches actually save, because it widens the cost-negative surface.

**Phase 1 (only after 0b, if pursued) — strengthen the signal where it's callable.** Tie the
directive to the plan: surface `subagentEligible` on plan steps into the prompt only when a step is
flagged, and trim the obsolete `multi_file_fanout` "GOOD signal" (redirect bulk same-edits to
`multi_edit`). Don't relocate the directive earlier until the tool is actually in the medium toolset
— prominence for an absent tool is pure waste.

If §E shows complex dispatches do **not** save (likely for the current mix): **stop at Phase 0a.**
That is the honest outcome — subagents are correctly idle, and the only defect is the dead budget.

---

## E. Measurement plan (the adoption checkpoint)

**Signal (cheapest):** `grep '\[zone-subagent-dispatched\]'` over the run log — one line per
successful dispatch, with `dispatchReason`. In the TUI, watch for `↳ subagent started` /
`↳ subagent <status>` (`sink.ts:345-354`). Cost/benefit from the paired
`[zone-subagent-token-propagated]` / `[zone-subagent-cost-propagated]` lines + the run's
`[zone-archetype] finalCostUsd`.

**Before/after task (must classify complex so `Task` is exposed today):** a long, read-heavy,
*independent* step — e.g. *"Read and summarize how the auth/session/billing subsystems each handle
token refresh (read-only), then implement a new unified refreshToken() and update call sites."* The
summarize-3-subsystems half is a clean `explore`/`long_isolated_step` candidate; the implement half
stays on the parent. Avoid pure renames (those go to `multi_edit` and won't — and shouldn't —
dispatch).

**Procedure:**
1. **Baseline (today, complex):** run it, `grep` the dispatch counter (expect 0–1), record
   `finalCostUsd` and wall-clock.
2. **Confirm exposure:** verify `Task` is in the toolset at complex (it is, per T.2) — so a 0 here is
   a *choice*, not a gate. (Optionally run the same task `forceTier="medium"` to demonstrate `Task` is
   absent — the bug, live.)
3. **If 0b is implemented:** re-run; confirm `[zone-subagent-dispatched]` fires on the explore step;
   compare `finalCostUsd` with vs without (env-toggle the dispatcher) — adopt 0b **only if the worker
   path is cheaper**, not merely active.

The decision rule: **adoption is worth driving only if (2)/(3) show a dispatch that lowers
`finalCostUsd` on the `long_isolated_step` shape. Otherwise ship Phase 0a and leave subagents
correctly dormant.**
