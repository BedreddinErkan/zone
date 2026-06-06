# DESIGN — Plan Mode Redesign (Claude-Code-like)

**Status:** Proposal for review. No implementation yet.
**Scope:** TUI plan mode (Shift+Tab). HTTP `/api/patch` + web UI are intentionally out of scope (left on the existing audit/revision flow for back-compat).

## Why this change

Today's TUI plan mode has two problems:

1. **Cost.** It runs a *separate* scope-audit — an LLM investigation loop plus a judge — on top of plan generation. A small task was observed costing ~$0.22 in pure pre-flight overhead before any real work began.
2. **Capability.** The user can only **accept** or **reject** a plan. There is no way to give feedback and have the agent revise the plan and re-present it; no "approve & auto-run" vs "approve & manually approve each edit" distinction.

Target (mirror Claude Code): plan mode is a **read-only investigation that culminates in the agent proposing a plan** — the plan is the natural output of the investigation, not a separate audit pass — presented with a rich action set including a **feedback → revise** loop. Scope-intelligence is preserved but folded **into** the proposed plan rather than delivered as a separate binary modal.

Decisive discovery: the feedback/re-plan capability is **already half-built**. `generateExecutionPlan` already accepts `previousPlan` + `userFeedback` (`src/llm/executionPlan.ts:87-110`); `planApprovals.ts` already defines `refine`/`feedback` decisions; the dispatch while-loop already exists (`src/cli/dispatch.ts:88-118`). They're stubbed (`continue` at `dispatch.ts:106-109`). So this is mostly *wiring what exists* + *deleting a redundant audit*, not greenfield work.

---

# PART 1 — AUDIT OF CURRENT PLAN MODE

## 1.1 There are TWO plan flows, not one

Plan mode is entered **only** via Shift+Tab (`App.tsx:122-126` → `MODE_CYCLE`, cycling `normal → autoAccept → plan → normal`; reducer guard at `store.tsx:499-506` no-ops while a modal/approval is open). There is **no `/plan` slash command** and **no on-screen documentation** of Shift+Tab (it's absent from `/help` in `Composer.tsx:48-58`).

Once `mode === "plan"`, the run hits an **XOR switch on an undocumented env var** (`dispatch.ts:85`) selecting between two structurally independent flows:

| | **OLD / default path** (`ZONE_PLAN_APPROVAL_CYCLE` unset) | **NEW path** (`=== "1"`) |
|---|---|---|
| dispatch branch | `dispatch.ts:121-144` | `dispatch.ts:86-120` |
| What runs | `runAuditPipeline({ forceAudit:true })` — the expensive triple | `requestPlanApproval` — cheap, no audit |
| State machine | `src/llm/revisionApprovals.ts` | `src/llm/planApprovals.ts` |
| TUI modal | `PlanModal.tsx` — title "Plan Review", keys **A / R** | `PlanReadyModal.tsx` — title "Ready to code?", keys **1/2/3/4/Esc** |
| Store field | `planProposal` / `modalView:"plan"` | `planReadyProposal` / `modalView:"plan_ready"` |
| HTTP endpoint | `POST /api/approve-revision` (web UI speaks this) | none (TUI-only) |

**The expensive forced-audit path is the default.** The cheap "Ready to code?" path exists but is off unless an env var the TUI can't set is `"1"`. This is the root of both complaints.

**Naming trap:** `PlanModal` / `planProposal` / `PLAN_PROPOSED` are the **scope-revision** surface; `PlanReadyModal` / `planReadyProposal` / `PLAN_READY_*` are the **plan-approval** surface. `PlanPanel.tsx` is unrelated (the live TodoWrite checklist).

## 1.2 The cost path — the audit is a separate set of LLM passes

In the default path, a single small task fires **up to four LLM round-trips before `runLlmPatchFlow` even starts**:

| # | Call | Source | Model (TUI path) | Shape |
|---|------|--------|------------------|-------|
| 0 | repo summary | `preparePlanContext` (`dispatch.ts:70`) | provider default | 0–1 completion |
| 1 | execution plan | `generateExecutionPlan` (`dispatch.ts:76`) | `standard` → **Haiku** | 1 cheap JSON completion |
| 2 | **scope investigation** | `investigateScope` → `runAgentLoop({mode:"investigation"})` (`auditPipeline.ts:124`) | `investigator` → **Sonnet** | **full agent loop, up to 6 iters** ← dominant |
| 3 | **scope judge** | `runScopeJudge` (`auditPipeline.ts:163`) | `high` → **Sonnet** | 1 completion (plan + findings) |
| 4 | the actual work | `runLlmPatchFlow` (`dispatch.ts:170`) | user's model | the real task |

**Rows #2 and #3 are the ~$0.22 of overhead.** The plan (#1, Haiku) is cheap; the audit re-investigates the repo at Sonnet tier and a Sonnet judge re-grades it. Two compounding bugs make small tasks worse:

1. **Low-risk skip is structurally unreachable in the TUI path.** `dispatch.ts:123-138` calls `runAuditPipeline` **without `preClassifiedTask`**, and `isLowRiskPlan` returns `false` whenever `classification` is null (`auditMode.ts:26`). So `forceAudit:true` + no classification ⇒ the full audit **always** runs, even for a one-file typo. (The HTTP path at `server.ts:3748` passes it, so it *can* skip — the TUI can't.)
2. **Pre-flight ignores the user's model.** `generateExecutionPlan` and `runAuditPipeline` run *outside* the `withRequestContext` wrapper that only wraps `runLlmPatchFlow` (`dispatch.ts:164-186`). `getRequestContext()` is `AsyncLocalStorage`-backed, so `modelOverride` is `undefined` there → the audit hard-codes Sonnet regardless of `--model`. (The `auditMode.ts:31` "Haiku-downgraded to ~$0.04" comment is **stale** — that downgrade was reverted in `8fd6d85`.)

`suggest_scope_change` (`toolDefinitions.ts:~500`) is the audit investigation's escalation mechanism — in `AUDIT_ALLOWED_TOOLS` only, captured as `agentSuggestedRevision` in `investigationFlow.ts`, funneled into `requestRevisionApproval`.

## 1.3 The two approval state machines

Both are near-identical promise+timeout+abort skeletons that **share no state**:

- **`revisionApprovals.ts`** (OLD/default path). `RevisionProposal {type: under_scope|over_scope|mixed, reason, originalPlan, revisedPlanSummary, missing/unnecessaryFiles}`; decisions `approve|reject|auto_apply|timeout`. Only live caller: `auditPipeline.ts:201`. Semantics asymmetry: in auditPipeline a `reject` *proceeds with the original plan*, but in TUI plan mode `dispatch.ts:140-143` turns `reject` into a **run abort**. Binary accept/reject — **no feedback channel**.

- **`planApprovals.ts`** (NEW path). `PlanReadyProposal {objective, steps[]}`; decisions **`accept_all | manual | refine | feedback | reject | timeout`**. The richer set already exists — but `refine`/`feedback` are stubs in dispatch (`:106-109` `continue`, re-showing the same plan), and the modal footer says "(stub)" (`PlanReadyModal.tsx:61`).

Outside plan mode, a `scope_revision_proposed` event is **silently auto-rejected** with a transcript warning (`useAgentEvents.ts:287-290`).

## 1.4 Execution gating

**All gating is upstream of the agent loop** — grep confirms `agentLoop.ts` has *no* plan/revision logic (its only approval await is `requestCommandApproval` for shell commands). The mechanism is a plain `await` on the approval promise **before** `runLlmPatchFlow` (`dispatch.ts:63-145`), bridged to the modal via the EventBus. Approve → fall through with `preGeneratedPlan: planForExecution`; reject → `ac.abort()` + `{ok:false, reason:"plan_rejected_by_user"}`. Dead import: `runLlmPatchFlow.ts:128` imports `requestRevisionApproval` but only uses the type.

## 1.5 Bonus defects found (cheap to fix alongside)

- `PlanModal` captures `unnecessaryFiles` in state but **never renders it** (only `missingFiles`).
- `SESSION_RESUME` nulls `planReadyProposal` but **not** `planProposal` (`store.tsx:480-497`); since `App.tsx:163` gates the modal on `planProposal !== null`, an orphaned scope-revision modal can survive a resume.
- `manual` does **not** gate edits — per `planApprovals.ts:18`, edits auto-apply; only commands are gated. True per-edit approval does not exist (see §2.3).

---

# PART 2 — DESIGN

## 2.1 The one idea

Collapse the **plan-gen + investigate + judge** triple into **one read-only investigation whose structured output *is* the plan**, then gate it with the (already-built) `planApprovals` modal extended to five actions, with feedback feeding a re-plan loop that stays in plan mode. Scope-intelligence stops being a separate adversarial pass and becomes **content of the plan** the user can correct.

## 2.2 Plan as the natural output of investigation — and the cost reasoning

Today plan mode pays for two investigations: `preparePlanContext` reads the repo to summarize it, `generateExecutionPlan` makes a *blind* plan from that summary (it sees file *paths*, not contents — `executionPlan.ts:98`), then `investigateScope` reads the repo *again* at Sonnet tier to check the plan, and `runScopeJudge` grades it. The "feature already built" catch only works because that second investigation actually reads code.

**Redesign:** run **one** read-only investigation, driven by the task, culminating in proposing the plan — Claude Code's ExitPlanMode shape. Reuse the existing read-only loop: `investigateScope`/`investigationFlow.ts` already runs `runAgentLoop({mode:"investigation", capabilityFilter: AUDIT_ALLOWED_TOOLS})`. Repoint its goal from *"audit this pre-made plan"* to *"investigate and propose a plan,"* and replace the `suggest_scope_change` emission with a `propose_plan` structured output carrying the `ExecutionPlan` shape (+ scope notes, §2.5).

Cost reasoning:
- **Delete** the judge (#3) and the redundant blind plan-gen (#1); the duplicate repo read (#0) folds into the one investigation.
- The single investigation **self-terminates** on small tasks (reads 1–2 files, emits a 2-step plan) — unlike today's forced 6-iter Sonnet audit the TUI can never skip. Most of the $0.22 was that unskippable, always-max audit.
- Run it **under `withRequestContext`** with the user's selected model (fixes the silent-Sonnet bug) → predictable cost matching the user's choice.
- Net: "investigate→plan + work" (one pre-flight pass that *produces* the artifact) instead of "plan + investigate + judge + work" (three passes of overhead).

**Lighter alternative** (if we avoid touching `investigationFlow`): keep `generateExecutionPlan` but feed it real file *contents* for the top relevant files so it can detect "already implemented," and drop only the judge. Cheaper to build, weaker scope detection. **Recommended: the investigation-based approach** — it's the only one that faithfully preserves the scope-catch the user wants, and it is what "plan = output of investigation" means.

## 2.3 The action set (mapped to current code)

Extend `planApprovals.ts` and `PlanReadyModal.tsx`:

| # | Action (Claude-Code parity) | `PlanDecision` | Behavior | Status |
|---|---|---|---|---|
| 1 | **Approve & auto-run** | `accept_all` | `setTrustAllForRun(runId)` → execute, no further prompts | KEEP (`dispatch.ts:110-113`) |
| 2 | **Approve & manually approve each edit** | `manual` | Execute with command approvals on; **edits gated too** | REFACTOR — see gap |
| 3 | **Give feedback → revise & re-present** | `feedback` | Capture feedback text → re-plan → re-show modal, stay in plan mode | WIRE (enum+loop exist, stubbed) |
| 4 | **Approve-with-feedback ("change X, then run")** | `approve_with_feedback` *(new)* | Capture feedback → re-plan once → execute revised plan without re-showing | ADD (one enum value) |
| 5 | **Reject / cancel** | `reject` | `ac.abort()` + `plan_rejected_by_user` | KEEP (`dispatch.ts:102-105`) |

`refine` (regenerate, no feedback) can stay as optional or fold into `feedback` with empty text.

**The one real gap — action #2.** Zone's atomic patch flow is all-or-nothing (`applyLlmPatches.ts` stages into a Map, then `finalizeStaging` flushes at once). No per-edit approval exists; `manual` gates only commands. Options:
- **Interim (recommended v1):** `manual` = gate commands as today **+** show the staged unified diff with a single confirm before `finalizeStaging` flushes. One approval, full visibility, no atomic-flow surgery.
- **Full (follow-up):** per-`apply_patch` approval gate inside the loop. Defer; own roadmap item.

## 2.4 The feedback/refine loop and its state machine

The re-plan primitive **already exists**: `generateExecutionPlan({ task, repoSummary, relevantFiles, previousPlan, userFeedback })` (`executionPlan.ts:87-110`) prepends feedback as the primary revision directive and returns a revised plan. The loop scaffold already exists (`dispatch.ts:88-118`). Work = (a) capture feedback text in the modal, (b) replace the `continue` stub with a real re-plan.

```
investigate → plan, ctx{repoSummary, relevantFiles}   // ONE investigation
loop:
  emit plan_ready_for_approval(plan)
  (decision, feedbackText) = await requestPlanApproval
  switch decision:
    accept_all            → setTrustAllForRun; break          // execute
    manual                → break                              // execute (gated)
    feedback              → plan = generateExecutionPlan({...ctx, previousPlan: plan, userFeedback: feedbackText}); continue  // STAY in plan mode
    approve_with_feedback → plan = generateExecutionPlan({...ctx, previousPlan: plan, userFeedback: feedbackText}); break     // execute revised
    reject | timeout      → ac.abort(); return plan_rejected_by_user
```

Key property: re-plan reuses the **cached** `repoSummary` + `relevantFiles` from the first investigation, so each feedback round is **one cheap standard-tier call**, not a fresh investigation. Iterates until approve/reject — the missing capability, delivered.

**State machine choice:** extend `planApprovals.ts`; do **not** reuse `revisionApprovals.ts`. The plan-approval machine already has the richer enum and the right proposal shape; revisionApprovals is binary and load-bearing for the HTTP/web path (leave it there untouched). Add to `planApprovals`: `approve_with_feedback` to `PlanDecision`, and a `feedback?: string` threaded through `resolvePlanApproval` and the request/resolve events. The modal gains a small text-input sub-mode (reuse the Composer input primitives) for actions 3/4 — today it emits a decision with no text.

## 2.5 Folding scope-intelligence into the plan

Delete the separate judge + the over_scope binary modal **for the TUI path**. The investigation emits scope findings as **plan content**:

- Add a `scopeNotes` / `alreadyImplemented` field (extend `ExecutionPlan` or carry alongside) — e.g. *"Pagination already exists in `searchService.ts`; I'll only add the UI control, not the backend."* `scopeSummary` already exists (`executionPlan.ts:22`) — widen its use.
- `PlanReadyModal` renders these notes prominently so the user sees the agent's scope reasoning **as the plan**, and corrects it via feedback (action 3) — strictly more capable than accept/reject.
- Preserves the value that recently caught an already-built feature, delivered through the richer flow instead of a separate judge pass.

`revisionApprovals.ts`, `PlanModal.tsx`, `/api/approve-revision`, and `runScopeJudge` **stay** for the HTTP `/api/patch` path (the web UI speaks `scope_revision_proposed`) — removed only as the **TUI plan-mode** gate, not deleted globally.

## 2.6 File-level keep / refactor / remove

| File | Change |
|---|---|
| `src/cli/dispatch.ts` (63-145) | **REFACTOR.** Replace env-XOR + forced-audit block with: one `investigateAndPlan()` under `withRequestContext`, then the extended approval loop. Remove `runAuditPipeline` from plan mode. Pass classified task. |
| `src/llm/investigationFlow.ts` / `auditPipeline.ts` | **REFACTOR.** Add `investigateAndPlan` entry — read-only loop with goal "propose a plan", emits `propose_plan`. Keep `runAuditPipeline` for HTTP. |
| `src/llm/executionPlan.ts` | **KEEP + extend.** Feedback path present; add `scopeNotes`/`alreadyImplemented`. Reused for cheap re-plan rounds. |
| `src/llm/planApprovals.ts` | **EXTEND.** Add `approve_with_feedback`; thread `feedback?: string`. |
| `src/cli/tui/components/PlanReadyModal.tsx` | **EXTEND.** 5 actions; feedback text-input sub-mode; render scope notes; drop "(stub)". |
| `src/cli/tui/store.tsx` / `useAgentEvents.ts` | **EXTEND.** Carry `feedback` through resolve; render scope notes; fix `SESSION_RESUME` `planProposal` leak. |
| `src/tools/toolDefinitions.ts` | **REFACTOR.** Repurpose `suggest_scope_change` → `propose_plan` (or add) in the investigation toolset. |
| `src/llm/scopeJudge.ts` | **REMOVE from plan path** (keep iff HTTP still wants it; else delete). |
| `revisionApprovals.ts`, `PlanModal.tsx`, `/api/approve-revision` | **KEEP** for HTTP/web; **unwire from TUI plan mode**. |
| `ZONE_PLAN_APPROVAL_CYCLE` | **REMOVE** the XOR; new flow is the unconditional default. |

## 2.7 Flag / migration / back-compat

- New flow becomes the **default and only** TUI plan-mode path; delete `ZONE_PLAN_APPROVAL_CYCLE` (repoint tests in `dispatch.test.ts:267+`).
- Optional one-release escape hatch `ZONE_PLAN_LEGACY_AUDIT=1` to restore the forced-audit path if a regression surfaces, then remove.
- HTTP `/api/patch` + web UI **unchanged** (still `runAuditPipeline` + `revisionApprovals`). TUI-scoped change. No persisted-config migration (env-only flag today).
- Clear UX debt: document Shift+Tab in `/help`; consider a `/plan` affordance.

## 2.8 Test strategy

- **Unit — re-plan:** `generateExecutionPlan({previousPlan, userFeedback})` returns a plan reflecting the feedback (the feedbackSection path, `executionPlan.ts:102`).
- **State machine:** `planApprovals` resolves each of the 5 decisions; `approve_with_feedback` carries `feedback`; timeout/abort still reject.
- **Dispatch loop:** mock `requestPlanApproval` → `feedback` then `accept_all`; assert `generateExecutionPlan` called twice (re-plan with `previousPlan`), then `runLlmPatchFlow` runs with the revised plan. Cover `manual`/`accept_all`/`reject`.
- **Cost regression (guards the whole point):** in TUI plan mode, assert **`runScopeJudge` and the audit `investigateScope` are never called**, and the plan investigation runs **once** under `withRequestContext` (honors model override).
- **TUI:** `PlanReadyModal` feedback sub-mode emits decision+text; renders scope notes; `useAgentEvents` wiring (named-const `bus.on/off`); `SESSION_RESUME` clears `planProposal`.
- Reuse the `toolExecutorMock` fixture; respect the flaky-tsc-timeout caveat (re-run in isolation before blaming a change).

## 2.9 Risks & tradeoffs

- **Loss of the independent judge.** The investigation agent both forms *and* self-asserts the plan — no adversarial second opinion. Mitigation: scope notes surfaced for human review + the feedback loop is a stronger correction channel than accept/reject. Trades an automated critic for human-in-the-loop refine — acceptable for an interactive TUI.
- **First-plan latency.** A read-only loop is slower than one JSON completion for the *first* plan, but cheaper than today's plan+investigate+judge and self-terminating on small tasks.
- **Feedback-round cost.** One `generateExecutionPlan` per round — bounded and cheap **only if** cached investigation context is reused (design requires this). A naive re-investigate-per-round erases the savings.
- **Action #2 partial.** Interim = single pre-flush diff confirm; true per-edit gating fights the atomic flow and is deferred. Don't over-promise in UI copy.
- **Two-surface divergence.** TUI and HTTP/web use different plan mechanisms post-change. Intentional; a later pass can unify the web UI.

## 2.10 Suggested phasing

1. **Cost fix first (small, high-value):** wire `feedback`/`approve_with_feedback` into the existing dispatch loop using `generateExecutionPlan`'s feedback path; flip the default off the forced-audit path; run under `withRequestContext`. Eliminates the $0.22 and ships the feedback loop with minimal surface change.
2. **Investigation-produces-plan:** repoint `investigateScope` → `investigateAndPlan` with `propose_plan`; fold scope notes in.
3. **Modal polish + per-edit diff confirm + docs/`/help`.**

---

# PART 3 — PHASE 2 DESIGN: investigation-produces-plan (cost-first)

**Status:** Design for review (Phase 1 + the DF-* polish shipped). No code changes in this section.
**Author's note:** grounded in current code with file:line citations. CLI-only — the scope-revision/web chain is dead (see §3.7) and must not be revived.

## 3.0 The central constraint

Phase 1 existed to kill the **unskippable** ~$0.22 forced audit (6-iter Sonnet `investigateScope` + Sonnet `runScopeJudge`, which also ignored `--model`). Phase 2 reintroduces an investigation, so the design is judged on one axis above all: **does it deliver content-aware plans + scope-catch + step-streaming without recreating that cost?** Every decision below is in service of that.

The legacy cost had four drivers (`auditPipeline.ts`): (1) 6 iterations, (2) Sonnet hardcoded, (3) a **second** high-tier judge call, (4) unskippable (dispatch never passed `preClassifiedTask`, so `isLowRiskPlan` always returned false — `auditMode.ts:25`). Phase 2 neutralizes all four: tight cap, user's model, **no judge**, gated/opt-in.

## 3.1 What we already have (reuse surface)

- **`preparePlanContext` is FREE** (`preparePlanContext.ts` — pure file I/O + one `rg`, zero LLM tokens; `userApiKey`/`provider` are vestigial). It returns ranked **paths** (`projectSummary`, `relevantFilePaths`, top-8) but **discards file content** (read only inside the ranker). This is the investigation's free seed — the agent doesn't need to *search*, only *read* known files.
- **`generateExecutionPlan` is content-blind** (`executionPlan.ts:98,121-122` — prompt embeds paths only). It already honors the model override (`getModelName("standard", provider, ctx?.modelOverride)`, `:96-97`) and already accepts `previousPlan`/`userFeedback`/`archetype`. This is the cheap fallback + the "quick" path.
- **The agentic read-only loop exists** (`investigateScope` → `runAgentLoop({mode:"investigation", capabilityFilter: read-only, maxIterationsOverride})`, `investigationFlow.ts:177-247`). It already streams `tool_call`/`tool_result`/`narration` via `onProgress` and captures structured output via `onStructuredEvent` (`:206-246`), and extracts a final ```json block (`extractPhase1Findings`, `:84-110`). This is the investigation engine — reuse it, don't rebuild.
- **Streaming plumbing is complete** (`tool_call`+`tool_result`+`narration` → `onProgress` → bus (`index.tsx:256`) → `useAgentEvents` → store → `Transcript`/`ToolCall`). **No new event type needed.** The only gap: dispatch's plan-gen calls (`dispatch.ts:81-99`) pass **no** progress sink, so their work is silent today.
- **Approval + feedback UX is done** (Phase 1: `planApprovals.ts` + `PlanReadyModal.tsx` + the dispatch re-plan loop). Scope-catch plugs into this, not a new modal.
- **DF-11 spinner** (`plan_generation_started` → `SPINNER_START`; `SPINNER_STOP` already fires in `handlePlanReadyForApprovalExported`).

## 3.2 The model-override bug (fix first — it's a standalone correctness bug)

Investigation mode pins the model and ignores the user's selection. Three co-located sites in `agentLoop.ts` (`2572-2574`, `2132-2134`, `3503-3505`):

```ts
const modelName = isInvestigationMode
  ? getModelForRole("investigator", client.provider)               // ← ignores requestCtx.modelOverride
  : getModelName("high", client.provider, requestCtx?.modelOverride);
```

`getModelForRole("investigator", …)` (`modelRouting.ts:46-53`) returns Sonnet/gpt-5.4 and its `override` param is a per-role map never wired to the request context (`ZoneRequestContext.modelOverride` is `{high?,standard?}`, `openaiContext.ts:8` — disjoint shape, no `investigator` field).

**Fix (3-line, backward-compatible):** make the investigation arm resolve through the override, falling back to the same default:
```ts
const modelName = getModelName("high", client.provider, requestCtx?.modelOverride);
```
For anthropic, `getModelName("high")` default = `claude-sonnet-4-6` = the old investigator default; for openai, `gpt-5.4` = same. So **server/no-override callers are unchanged** (`requestCtx` undefined → high default), while any caller under `withRequestContext({modelOverride})` (the TUI) now honors `--model`. This is a no-op for `/init` and `/api/investigate` (no modelOverride in context today) and fixes a latent bug independent of Phase 2. Guard with a test asserting investigation uses the override when present, the high default otherwise.

## 3.3 The investigation→plan engine (`runPlanInvestigation`, net-new, thin)

New `src/llm/planInvestigation.ts` — a thin wrapper over the existing loop (mirrors `investigateScope`, does NOT touch `auditPipeline`/`scopeJudge`):

```
runPlanInvestigation({ task, repoPath, runId, relevantFiles, repoSummary, userApiKey, provider, onProgress, abortSignal }):
  runAgentLoop({
    task: PLAN_INVESTIGATION_PROMPT(task, relevantFiles),   // "Read the listed files, then output an ExecutionPlan as JSON"
    mode: "investigation",                                   // read-only toolset, streams tool_call/narration
    capabilityFilter: read-only (read_file/search_in_files/list_files/find_references),
    maxIterationsOverride: PLAN_INVESTIGATION_ITER_CAP,      // 4 — see §3.6
    onToolCall / onToolResult / onStructuredEvent: forward to onProgress (step-streaming, exactly as investigateScope:189-246),
  })
  → parse the loop's final synthesis as JSON → executionPlanSchema.parse  (reuse extractJson + zod from executionPlan.ts)
  → on parse failure: FALLBACK to generateExecutionPlan({ task, repoSummary, relevantFiles: filesAlreadyRead, ... })  // always yields a plan, bounds failure cost
```

Key choices:
- **Seeded, not searching.** The prompt lists `relevantFiles` (free from `preparePlanContext`) and says "read these, follow imports only if needed, then emit the plan." Converts open-ended exploration into bounded read-then-synthesize — the dominant cost lever.
- **Plan = final synthesis JSON**, parsed with the existing `executionPlanSchema`. Reuses the read-only loop's natural termination (the final no-tool synthesis call, `agentLoop.ts:3494-3525`). No new `propose_plan` tool, no agentLoop tool-handling changes.
- **Runs under `withRequestContext(planGenCtx, …)`** (same wrapper dispatch already uses for plan-gen, `dispatch.ts:81,91`) so it bills on the user's model (requires §3.2).
- **Fallback guarantees a plan** and caps the worst case at "investigation tokens + one `generateExecutionPlan`".

## 3.4 Scope-catch — annotate, do NOT interrupt (no judge, no revision modal)

The legacy judge + `suggest_scope_change` + `requestRevisionApproval` + `PlanModal` chain is **CLI-dead** (§3.7) and is a second LLM call. Phase 2 **folds scope-intelligence into the plan itself**:

- Extend `ExecutionPlan` (`executionPlan.ts:7-23`) + `executionPlanSchema` with **`scopeNotes?: string`** (and/or `alreadyImplemented?: string[]`). The investigation, having read the code, writes e.g. *"Pagination already exists in `searchService.ts:88`; plan covers only the UI control."* into this field as part of its JSON output.
- `PlanReadyModal.tsx` renders `scopeNotes` prominently (a dim "Scope:" block above the footer). The user reacts via the **existing feedback loop** ([3] give feedback / [4] feedback+run) — which already re-plans. Scope mismatch → surfaced in the plan → corrected by feedback. **Zero new approval machinery, zero second LLM call.**

This is strictly cheaper and simpler than the legacy judge, and more capable than its binary accept/reject (the user can steer with text). It also matches §2.5 of this doc.

## 3.5 Step-streaming — thread the callback, reuse the chain

The investigation's reads/reasoning stream to the TUI by **passing `progressCallback` into `runPlanInvestigation`** (today `dispatch.ts:81-99` passes none). The events (`tool_call`, `tool_result`, `narration`) already flow end-to-end and render in `Transcript`/`ToolCall`. Composition:

```
plan_generation_started → SPINNER_START ("Planning…")        [DF-11, already shipped]
  ↓ investigation runs, streaming:
  tool_call "read_file searchService.ts ✓"  (Transcript)      [existing render path]
  narration "Pagination already handled here…" (Transcript)   [existing render path]
  ↓ plan emitted →
plan_ready_for_approval → SPINNER_STOP + PlanReadyModal       [already wired]
```

No new event type. v1 lets the investigation's tool-call lines persist in the transcript (simplest, reuses everything); collapsing them Claude-Code-style when the modal appears is a Phase 3 polish item.

## 3.6 Cost analysis (estimates; state assumptions)

Assumptions: Sonnet $3/$15 per M in/out (cached prefix ~$0.30/M); Haiku $1/$5. "Typical small task": 2-4 target files; `preparePlanContext` ranks ~5-8 files ≈ ~1.5K tokens each. **All paths bill on the user's selected model** (so the variable is *tokens*, not a tier jump).

| Path | LLM calls | Est. (Sonnet user) | Est. (Haiku user) | Scope-catch | Step-stream |
|---|---|---|---|---|---|
| Phase 1 blind (today's quick) | 1 completion, paths only | **~$0.026** | ~$0.009 | ✗ | ✗ |
| **Quick+content** (Option B, §3.8) | 1 completion, top-5 file bodies in prompt | **~$0.05** | ~$0.016 | ✓ (soft) | reasoning prose only |
| **Investigate** (Option A, §3.3, 4-iter, no judge) | bounded read loop, final JSON | **~$0.10** | ~$0.03 | ✓ (autonomous) | ✓ (file-read steps) |
| Legacy forced audit (retired) | 6-iter Sonnet + Sonnet judge | ~$0.22 | n/a (ignored --model) | ✓ | partial |

Investigate is **~55% cheaper than legacy**, skippable, honors `--model`, and drops the judge. The 4-iter cap (vs legacy 6) + seeded reads are why.

## 3.7 Gating — opt-in, default cheap (never unconditional)

Unconditional investigation = the legacy trap. Recommendation:
- Add **`planDepth: "quick" | "investigate"`** to `DiskModelSettings` (`diskModel.ts`), default **`"quick"`** — same pattern as `effort`/`summaryFormat`. A small `/plandepth` modal (or fold into an existing settings modal) toggles it.
- `"quick"` → cheap path (today's blind completion, or the content-aware Option B if §3.8 is adopted).
- `"investigate"` → `runPlanInvestigation`.
- **Optional auto-escalation (v2):** when `planDepth="quick"` but `relevantFilePaths.length ≥ N` (free signal) and the task isn't trivial, suggest/auto-bump to investigate. Start with explicit opt-in to avoid cost surprises; tune later.

This guarantees the common trivial task stays at ~$0.03 and the expensive path runs only when asked.

## 3.8 Honest assessment + recommended split

Full agentic investigation (Option A) is the **only** path that delivers true "watch it read files" step-streaming and autonomous scope-catch — but it is inherently more expensive and more complex than a single completion. If cost/simplicity is paramount, **Option B (content-aware single-shot)** delivers scope-catch at ~$0.05/one call with near-zero new machinery (just put the top-N ranked files' content into `generateExecutionPlan`'s prompt — `executionPlan.ts:121`), streaming only reasoning prose.

**Recommended rollout (honors both the feature ask and the cost constraint):**
- **Default = Option B as "quick"** → universal content-aware scope-catch, cheap, low-risk, tiny diff.
- **Opt-in = Option A as "investigate"** → true step-streaming + autonomous scope-catch for hard/multi-file tasks, gated by `planDepth`.

Both bill on the user's model; both fold scope into the plan (no judge); neither is unconditional.

## 3.9 Reuse map

| Reuse as-is | Adapt / extend | Net-new | Retire (leave dead, don't revive) |
|---|---|---|---|
| `runAgentLoop` (mode:"investigation"), read-only filter; `tool_call`/`tool_result`/`narration` stream chain; `preparePlanContext` (free seed); `executionPlanSchema` + `extractJson`; `planApprovals`+`PlanReadyModal`+feedback loop; `withRequestContext`; DF-11 spinner | `executionPlan.ts` (+`scopeNotes`; reuse as fallback + quick path); `agentLoop.ts` model arm (§3.2); `PlanReadyModal` (render scope notes); `diskModel.ts` (`planDepth`); `dispatch.ts` (call investigation, thread `progressCallback`) | `src/llm/planInvestigation.ts` (`runPlanInvestigation`); `/plandepth` toggle | `scopeJudge.ts`, `revisionApprovals.ts`, `PlanModal.tsx`, `/api/approve-revision`, `suggest_scope_change` consumer — all CLI-dead behind `ZONE_PLAN_LEGACY_AUDIT`/web-only |

## 3.10 Files to change (grouped)

- **Model fix (do first, standalone):** `agentLoop.ts` (3 sites, §3.2) + a model-routing test.
- **Investigation engine:** new `src/llm/planInvestigation.ts`; `executionPlan.ts` (`scopeNotes` on type+schema; export reusable fallback); `src/cli/dispatch.ts` (in plan block: when `planDepth==="investigate"`, call `runPlanInvestigation` under `withRequestContext`, thread `progressCallback`; the re-plan feedback loop calls it too).
- **Scope-notes UI:** `PlanReadyModal.tsx` (render `scopeNotes`); `planApprovals.ts` + `agentLifecycleEvents.ts` (carry scope notes on `plan_ready_for_approval`); `useAgentEvents.ts` (`handlePlanReadyForApprovalExported` passes them through); store `planReadyProposal` shape.
- **Gating:** `diskModel.ts` (`planDepth`); a slash modal; `dispatch.ts` reads it.
- **Streaming:** mostly free (callback threading); verify plan-investigation `tool_call`s render in `Transcript`.
- **Quick+content (if §3.8 adopted):** `executionPlan.ts` only (include top-N file bodies in the prompt).
- **Tests:** model-override arm; `runPlanInvestigation` (mock loop → valid JSON parsed; invalid JSON → `generateExecutionPlan` fallback); scope-notes render in `PlanReadyModal`; depth gate routing in `dispatch.test.ts`; cost-regression guard (investigate path makes NO `runScopeJudge`/`runAuditPipeline` call).

## 3.11 Risks & open questions

- **Final-synthesis JSON reliability** — model may emit prose or malformed JSON. Mitigation: zod parse + `generateExecutionPlan` fallback on the read files (always yields a plan; bounds cost).
- **Transcript clutter** — streamed plan-investigation tool calls persist in scrollback. v1 accepts; collapsing is polish.
- **Per-model cache rates** — an Opus user pays Opus prefix rates for the investigation. Intended tradeoff, not a regression.
- **Auto-escalation tuning** — start opt-in (no auto) to avoid cost surprises.
- **Dead-code cleanup** — `scopeJudge`/`revisionApprovals`/`PlanModal`/`/api/approve-revision` are now doubly-dead for CLI; deleting them is a separate cleanup (risky re: web parity — out of Phase 2 scope).

## 3.12 Interaction with Phase 3 (per-edit diff confirm)

Sequential and independent. Phase 2 ends when the plan (with scope notes) is approved via `PlanReadyModal`; Phase 3 governs execution edits inside `runLlmPatchFlow`. The single seam: Phase 2's **`manual`** decision (approve & manually approve each edit) is exactly the entry point Phase 3's per-edit diff confirm builds on — already threaded (`accept_all`→`setTrustAllForRun`; `manual`→normal gating). No conflict.
