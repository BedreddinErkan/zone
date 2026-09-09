# 05 — Subagent UX: Dispatch to Pixel

**Date:** 2026-09-09 · **Scope:** `src/tools/toolExecutor.ts`, `src/llm/subagents.ts`, `src/llm/subagentDispatch.ts`, `src/cli/tui/`, `src/cli/sink.ts`, `AUDIT-subagent-adoption.md` · **Method:** read-only code trace

---

## §1 — Lifecycle

### 1.1 Spawn site

There is exactly **one** subagent spawn site in the entire codebase:

**`src/tools/toolExecutor.ts:1020-1215`** — the `Task` tool branch inside `executeTool()`.

```
toolExecutor.ts:1020  if (toolName === "Task") {
toolExecutor.ts:1022    if (input?.subagent !== undefined) {  // nested guard
toolExecutor.ts:1043    // TODO(PR 5+): staged-writes block
toolExecutor.ts:1068    // Third of three independent locks
toolExecutor.ts:1077    if (getSubagentCallCount(parentRunId) >= effectiveSubagentCap)
toolExecutor.ts:1102    const subagentId = randomUUID();
toolExecutor.ts:1103    incrementSubagentCallCount(parentRunId);
toolExecutor.ts:1106    input?.onStructuredEvent?.({ type: "subagent_started", ... });
toolExecutor.ts:1116    const { runAgentLoop } = await import("../llm/agentLoop.js");
toolExecutor.ts:1134    const subagentResult = await withRequestContext({subagentId, ...}, () =>
toolExecutor.ts:1136      runAgentLoop({ task, subagent: { id, type, parentRunId }, ... })
toolExecutor.ts:1137    );
toolExecutor.ts:1196    input?.onStructuredEvent?.({ type: "subagent_completed", ... });
```

### 1.2 Concurrency model

**Serial only.** The `Task` tool is called from the agent loop's sequential tool-dispatch path. `toolExecutor.ts` awaits `runAgentLoop()` inline (line 1134–1137). There is **no `Promise.all`**, no parallel subagent fan-out. The `MAX_SUBAGENT_CALLS_PER_PARENT_RUN = 2` cap (`subagents.ts:15`) bounds total calls per parent but they execute one-at-a-time.

**Max concurrency: 1 subagent at a time.** The agent loop dispatches tool calls sequentially; a second `Task` call would wait until the first subagent's `runAgentLoop` returns.

### 1.3 Delimitation

Each subagent run is delimited by:

- **`subagentId`**: `randomUUID()` generated at `toolExecutor.ts:1102`. Unique per dispatch.
- **`AsyncLocalStorage` context**: `withRequestContext({ subagentId, subagentType, parentRunId })` at `toolExecutor.ts:1134`. The `ZoneRequestContext` carries `subagentId`, `subagentType`, and `parentRunId` for the duration of the worker's agent loop.
- **`subagent` field on `runAgentLoop` input**: `{ id: subagentId, type: resolvedType, parentRunId }` at `toolExecutor.ts:1158`. This is the structural marker that makes a loop a subagent (and triggers the nested-dispatch guard at line 1022).

### 1.4 Termination

A subagent terminates via the same mechanisms as the parent loop:

- **Natural completion** (`result.success === true`): worker's summary is parsed via `parseWorkerSummary()` or `parseExploreSummary()` (`subagents.ts:208-330`).
- **Iteration cap** (`maxIterationsOverride`): workers get `WORKER_MAX_ITERATIONS = 6` (floor), explores get `EXPLORE_MAX_ITERATIONS = 15` (floor), scaled by plan step count (`subagents.ts:30-32, 59-70`).
- **Token budget exhaustion**: the parent's `tokenBudgetBaseTokens` is forwarded (`toolExecutor.ts:1167`); the subagent shares the parent's token budget.
- **Abort signal**: `input?.abortSignal` is forwarded (`toolExecutor.ts:1166`); Esc in the TUI aborts the parent which aborts the subagent.
- **Failure**: `result.success === false` → status is `"failed"`, the parent receives a JSON result with `success: false`.

**Nested dispatch is blocked** (`toolExecutor.ts:1022-1026`): if `input?.subagent !== undefined` (i.e., this loop IS a subagent), the `Task` tool is refused with `"Nested subagents are not allowed."`. Additionally, `WORKER_ALLOWED_TOOLS` (`subagents.ts:4-11`) deliberately excludes `"Task"`.

---

## §2 — Event Flow

### 2.1 Event types carrying subagent info

Two structured progress event types carry subagent identity (`agentLifecycleEvents.ts:27-29, 135-136`):

```typescript
SUBAGENT_STRUCTURED_PROGRESS_EVENT_TYPES = [
  "subagent_started",    // payload: subagentId, subagentType, parentRunId, title
  "subagent_completed",  // payload: subagentId, subagentType, parentRunId, subagentStatus, title
]
```

Additionally, the `handoff_report` event type carries `report.summary` from subagent-to-parent handoffs.

### 2.2 Trace: one subagent `tool_call` event from producer to store

**Producer** → `toolExecutor.ts:1106-1113`:
```typescript
input?.onStructuredEvent?.({
  type: "subagent_started",
  title: description.trim().slice(0, 80),
  status: "active",
  subagentId, subagentType: resolvedType, parentRunId,
});
```

**Bridge** → `runLlmPatchFlow.ts` (the `onStructuredEvent` callback): the event is forwarded via `emitStructuredProgress → onProgress` to the TUI's event bus.

**Event bus** → `src/cli/tui/index.tsx:~249`: `bus.emit(evt.type, evt)` — a generic passthrough that forwards ALL progress events to the bus.

**Consumer** → **`useAgentEvents.ts` — NO LISTENER EXISTS.**

This is the critical finding. `useAgentEvents.ts` subscribes to ~30 bus events but has **zero** listeners for `subagent_started`, `subagent_completed`, or `handoff_report`. These events are emitted into the void in the TUI path.

**Headless sink** → `src/cli/sink.ts:329-337`:
```typescript
case "subagent_started":
  if (!quiet) out(`${dim}  ↳ subagent started${reset}`);
case "subagent_completed":
  const status = evt.subagentStatus ?? "done";
  out(`${dim}  ↳ subagent ${status}${reset}`);
```

The headless sink shows a minimal `↳ subagent started` / `↳ subagent completed` with **no subagent type, no title, no task description, no cost**.

### 2.3 Rendering verdict

**Subagent events are suppressed in the TUI.** The events exist, flow through the bus, but no store reducer processes them and no component renders them. The user sees:

- **Inside the subagent's execution:** the subagent's own tool calls and narration are forwarded via shared `onProgress` / `onStructuredEvent` callbacks (`toolExecutor.ts:1160-1164`). These arrive as **flat** `tool_call`, `tool_result`, and `narration` events on the parent's bus — **indistinguishable from the parent's own tool calls**. There is no nesting, no indentation, no visual grouping.
- **At boundaries:** nothing. `subagent_started` and `subagent_completed` are dropped by the TUI.

---

## §3 — Transcript Representation

### 3.1 What the user sees while a subagent runs

The user sees the subagent's individual tool calls rendered as **flat entries in the parent transcript**, exactly as if the parent had made them:

```
▶ read_file(src/auth/login.ts)           ← subagent's read, looks like parent's
● search_in_files(src/, "validateToken") ← subagent's search, looks like parent's
▶ write_file(src/auth/login.ts)          ← subagent's write, looks like parent's
```

**No visual distinction exists.** There is:
- No indentation or nesting indicator
- No "↳ worker:" prefix
- No subagent-type badge
- No collapsed/expandable wrapper
- No separate section or grouping

### 3.2 Spinner label during subagent execution

The spinner label **does not change** to indicate a subagent is running. The subagent's own `SPINNER_START` events share the parent's spinner state. The store guards against mid-run spinner restarts (`store-core.ts:615`):

```typescript
// SPINNER_START (e.g. a nested/subagent loop) keeps the original start.
```

So a subagent's spinner events are absorbed silently — the user sees the parent's existing spinner label, unchanged.

### 3.3 ToolCallGroup and batch collapsing

Subagent tool calls are subject to the same read-only batch collapsing as parent calls (`store-core.ts`). A subagent that does 5 consecutive `read_file` calls will appear as a collapsed `read_file ×5` group — **with no indication these were a subagent's reads**. The ToolCallGroup component (`ToolCallGroup.tsx`) has no subagent awareness:

```tsx
// ToolCallGroup.tsx — no subagentId check, no nesting
export function ToolCallGroup({ calls }: ToolCallGroupProps): React.ReactElement {
  const counts = new Map<string, number>();
  for (const call of calls) { /* ... */ }
```

### 3.4 The subagent result in the transcript

When the subagent completes, `toolExecutor.ts:1139-1215` formats the result and emits `subagent_completed`. The result is returned to the agent loop as a normal `tool_result` for the `Task` tool call. The parent sees a `ToolCall` entry for `Task`:

```
✓ Task(Explore the auth module for vulnerabilities)
  └ {"subagentId":"...","status":"completed","summary":"Found 3 issues...","costUsd":0.0023}
```

The `ToolCall` component (`ToolCall.tsx`) renders the raw JSON output. The `formatToolArgs` function truncates the description at 60 chars (`toolCallFormat.ts:33-36`). The JSON result is shown via `formatPreview` as a single truncated line.

**The user sees a single `Task(...)` tool call with a truncated JSON result — no breakdown of what the subagent actually did, how many tool calls it made, or how much it cost.**

---

## §4 — Persistence & Resume

### 4.1 Conversation filesystem store

`conversationFilesystemStore.ts` stores events per **threadId** (the TUI session's `sessionId`). Subagent events are **not written** to this store:

- The TUI path writes only `type:"agent_summary"` events post-run (`index.tsx:~265-278`).
- Subagent `subagent_started` / `subagent_completed` events are emitted via `onStructuredEvent` but are never persisted to the JSONL file.
- The 50-event cap per thread (`conversationFilesystemStore.ts:29`) applies to the session thread, not subagent threads.

**Subagent work is invisible to the session memory system.** A resumed session has no record that subagents ran, what they did, or what they found.

### 4.2 Session resume

`/sessions` and `--resume` reconstruct the session from `DiskSession` records (`diskSessions.ts`). These records contain:

- `transcript`: the TUI transcript (committed entries)
- `startedAt`, `sessionId`
- `modelSettings`

**What is lost on resume:**
- Subagent tool calls appear in the transcript as flat entries (per §3.1), so they survive visually but are **indistinguishable from parent calls**.
- `subagent_started` / `subagent_completed` events are gone (never persisted).
- Subagent cost breakdown is lost (never stored per-subagent in session records).
- The subagent's internal reasoning (thinking blocks, intermediate narration) is lost — only the final ≤500-char summary survives in the `Task` tool result.

### 4.3 Disk session structure

`DiskSession` (`diskSessions.ts`) has no subagent-specific fields. There is no `subagentThreads`, `subagentCosts`, or `subagentResults` field. The session record treats subagent work as opaque tool-call output.

---

## §5 — Cost & Metrics Attribution

### 5.1 Token and cost tracking

Subagent cost IS tracked internally but **aggregated into the parent's totals**:

- `agentLoop.ts:203`: `returns _iterCostAccumulator.total_cost + _subagentCostTotal`
- `SubagentTokenUsage` type (`subagents.ts:115-138`): tracks per-subagent `totalTokens`, `costUsd`, broken down by `worker` and `explore`.
- The `handleSubagentResult` function in `toolEventHandler/handleToolResult.ts` extracts `subagentTokenDelta` and `subagentCostDelta` from the Task tool result.
- `usageTracker.ts:10-11`: usage records carry optional `subagentId` and `subagentType` fields.

**However, the per-subagent breakdown is never surfaced to the user.** The StatusBar shows the parent's aggregate cost (`$X.XXXX`). There is no "subagent: $0.0023 of $0.0456" breakdown.

### 5.2 MetricsModal

`MetricsModal.tsx` shows aggregate KPIs:
- Runs, USD Total, Cache Hit ratio, Degrade Rate, Resumable Rate, P50/P95 latency
- Termination distribution histogram

**No subagent-specific metrics exist.** There is no "subagent dispatches", "subagent cost", "subagent success rate", or "cost per subagent type" row. The modal has no awareness that subagents exist.

### 5.3 Cost visibility gap

The parent's StatusBar cost includes subagent spend (`_subagentCostTotal` is added to the parent's total). A user seeing `$0.05` does not know that `$0.03` of that was a subagent that returned a 500-char summary. There is no way to audit which subagent calls were cost-effective.

---

## §6 — Approvals Inside Subagents

### 6.1 Approval forwarding

Subagent tool calls that require approval (e.g., `run_command` inside a worker) use the **same `onApprovalRequired` callback** as the parent (`toolExecutor.ts:960`). The callback is forwarded unchanged to the subagent's `runAgentLoop` invocation (it is part of the `input` object spread at `toolExecutor.ts:1136`).

**Approvals DO surface in the main TUI** through the same registries. When a subagent's `run_command` needs approval, the parent's `ApprovalModal` fires with the subagent's command. The user sees:

```
┌─ Command approval required ─────────────────────┐
│  $ npm test                                      │
│                                                   │
│  [Y]es  [N]o  [T]rust prefix                     │
└───────────────────────────────────────────────────┘
```

### 6.2 Reentrancy and ordering hazards

**Concurrency constraint: serial execution.** Since subagents execute serially (§1.2), only one subagent can be active at a time. This eliminates the two-subagent-simultaneous-approval scenario.

However, there are ordering hazards:

1. **Approval context loss:** The `ApprovalModal` shows the command but **no indication it came from a subagent**. The user cannot tell whether they're approving a parent command or a subagent command. There is no "↳ worker" prefix, no subagent-type badge.

2. **Abort propagation:** If the user presses Esc to abort while a subagent is running, the parent's `AbortController` fires, which propagates to the subagent via the shared `abortSignal`. This is correct behavior but the user sees no "aborting subagent..." feedback.

3. **Staged-writes block:** `toolExecutor.ts:1043-1052` blocks `Task` dispatch when the parent has staged uncommitted writes. This prevents a subagent from seeing temp-flushed content. The error message is informative: `"Task dispatch is currently not allowed after the parent run has staged uncommitted writes."`.

4. **No question forwarding:** If a subagent's agent loop were to call `ask_user` (the question tool), the question would surface through the parent's question registries. However, `WORKER_ALLOWED_TOOLS` excludes `ask_user` (`subagents.ts:4-11`), so this path is structurally blocked.

---

## §7 — Doc Drift

### 7.1 AUDIT-subagent-adoption.md

| Claim | Status vs Current Code |
|---|---|
| `Task` tool is complex-tier-only | **Confirmed.** `MEDIUM_TIER_TOOLS` (`tierToolSubsets.ts`) does not include `"Task"`. The `effectiveSubagentCap` at `toolExecutor.ts:1073-1077` is the third lock. |
| Medium tier `maxSubagentCalls: 1` is dead config | **Confirmed, unfixed.** `TIER_LIMITS.medium.maxSubagentCalls = 1` exists but is unreachable because `Task` is absent from the medium toolset. |
| Fresh-context worker re-reads files | **Confirmed.** `withRequestContext` at `toolExecutor.ts:1134` creates a new context; the worker's `runAgentLoop` starts with an empty conversation history. |
| Lossy ≤500-char summary | **Confirmed.** `SUMMARY_MAX_CHARS = 500` at `subagents.ts:141`. `truncateSummary()` at `:188-191`. |
| `multi_file_fanout` GOOD signal is obsolete | **Confirmed.** `multi_edit` handles the same use case in one tool call. The directive still references it. |
| 0% adoption rate | **Likely accurate.** The codebase shows 0 `fetch_url` calls and 0 web search requests in telemetry. No evidence of Task dispatches in production records. |
| `[zone-subagent-dispatched]` gated on `result.success` | **Disputed.** CLAUDE.md states it fires for both success and failure. The AUDIT may be outdated. |
| No `forceTier="medium"` test | **Confirmed gap.** The gate test suite tests simple and complex but not medium. |

### 7.2 DESIGN docs mentioning subagents

| Document | Subagent Content | Status |
|---|---|---|
| `DESIGN-todowrite-tui.md` | Uses subagent 0% adoption as cautionary analogy for TodoWrite risk | **Reference only** — no subagent design |
| `DESIGN-tui-resize-fix.md` | Incidental mention of "sub-agent" (refers to AI coding assistant, not Task tool) | **Not relevant** |
| All other DESIGN-*.md | No subagent content | N/A |

### 7.3 CLAUDE.md subagent claims

| Claim | Status |
|---|---|
| Three independent locks (subset, budget gate, runtime cap) | **Implemented, documented at each site** (deferred-work.md item 176 closed) |
| `subagentEligible` + dispatch-reason vocabulary in system prompt | **Implemented** — 582 chars, gated on `subagentEligible` |
| `DISPATCH_REASON_PREFIXES` is single source of truth | **Implemented** — `subagentDispatch.ts:51-55`, enforced by `dispatchReasonAgreement.test.ts` |
| TASK SUBAGENTS block is a protected zone | **Implemented** — listed in protected zones |

### 7.4 deferred-work.md subagent items

| Item | Status |
|---|---|
| #176 — Three enforcement points documented | **Closed** |
| #178 — Subagent-eligibility criteria cost with no consumer below complex | **Open** — 889+1476 chars paid every run, no instrument to measure value |
| #222 — Subagent dispatch can silently default to `"openai"` provider | **Open, unfixed** — reachable under headless mode |

---

## §8 — Top 10 Subagent-Visibility Weaknesses

### 1. Subagent events are silently dropped in the TUI

**Impact: Critical** — The user has zero awareness that a subagent started or completed.

**Evidence:** `useAgentEvents.ts` has no `bus.on("subagent_started")` or `bus.on("subagent_completed")` listener. The events arrive at the bus (`index.tsx:~249`) but are consumed by nothing. The headless sink shows `↳ subagent started` (`sink.ts:329-330`) but even that is minimal.

**Fix:** Add two `bus.on` listeners that dispatch `SPINNER_LABEL` updates (e.g., "↳ Worker: exploring auth module") and commit a `subagent_summary` transcript entry on completion.

---

### 2. Subagent tool calls are indistinguishable from parent calls

**Impact: High** — The transcript is a flat stream; the user cannot tell which tool calls belong to the parent and which to a subagent.

**Evidence:** `toolExecutor.ts:1160-1164` forwards `onProgress` / `onStructuredEvent` to the subagent's `runAgentLoop`. The subagent's tool_call events arrive on the parent's bus with no `subagentId` tag in the TranscriptEntry. `Transcript.tsx` renders all entries identically.

**Fix:** Tag subagent events with `subagentId` in the TranscriptEntry; render with indentation (e.g., `  ↳`) or a distinct border/glyph.

---

### 3. No per-subagent cost breakdown visible to the user

**Impact: High** — Subagent spend is silently absorbed into the parent's cost total.

**Evidence:** `agentLoop.ts:203` adds `_subagentCostTotal` to the parent's cost. `SubagentTokenUsage` tracks per-type usage (`subagents.ts:115-138`). `MetricsModal.tsx` has no subagent rows. StatusBar shows aggregate `$X.XXXX` only.

**Fix:** Render subagent cost in the Task tool result line: `✓ Task(...) — $0.0023 (worker, 4 iters)`. Add a subagent-cost row to MetricsModal.

---

### 4. Subagent result is a truncated JSON blob

**Impact: Medium-High** — The Task tool result shown to the user is raw JSON with a 500-char summary, not a human-readable report.

**Evidence:** `formatSubagentToolResultForParent()` returns `{ success, output: JSON.stringify(summary) }` (`subagents.ts:257-263`). `ToolCall.tsx` renders this via `formatPreview()` which truncates to one line. The user sees `{"subagentId":"...","status":"completed","summary":"Found 3..."}`.

**Fix:** Render a structured result: status glyph + summary + files modified + cost, instead of raw JSON.

---

### 5. No subagent progress indication during execution

**Impact: Medium-High** — While a subagent runs (potentially 6-15 iterations), the spinner label stays at the parent's last label. No "Step 3/6" or iteration counter for the subagent.

**Evidence:** `store-core.ts:615` — `SPINNER_START` during a subagent is absorbed: "keeps the original start." The subagent's own `narration` events flow to the parent's transcript, but there is no "Worker: 3/6 iterations" indicator.

**Fix:** Add a `subagent_progress` spinner label format: `"↳ Worker 3/6 · read_file(auth/login.ts)"`.

---

### 6. Approval modal has no subagent context

**Impact: Medium** — When a subagent's command needs approval, the modal shows the command but no indication it came from a worker.

**Evidence:** `ApprovalModal.tsx` renders `command` with no subagent prefix. The `onApprovalRequired` callback forwarded to the subagent (`toolExecutor.ts:1136`) carries no subagent metadata. The user sees `$ npm test` with no context about who is requesting it.

**Fix:** Thread `subagentId` and `subagentType` through the approval request; render `"↳ Worker requests: $ npm test"`.

---

### 7. Subagent work is lost on session resume

**Impact: Medium** — After resume, subagent tool calls survive as flat transcript entries but their structure (which calls were the subagent's, what the summary was, what it cost) is unrecoverable.

**Evidence:** `conversationFilesystemStore.ts` writes only `agent_summary` events. No subagent-specific events are persisted. `DiskSession` has no subagent fields.

**Fix:** Persist `subagent_started` / `subagent_completed` events to the JSONL thread file. Add a `subagentThreads` field to `DiskSession`.

---

### 8. The `Task` tool's medium-tier budget is dead config

**Impact: Medium** — `TIER_LIMITS.medium.maxSubagentCalls = 1` is unreachable because `Task` is absent from `MEDIUM_TIER_TOOLS`. This is a latent bug that could confuse future developers.

**Evidence:** `AUDIT-subagent-adoption.md` — confirmed. `tierToolSubsets.ts` medium allowlist has 9 tools, none is `"Task"`. No `forceTier="medium"` test exists.

**Fix:** Set `TIER_LIMITS.medium.maxSubagentCalls = 0` to match reality, add the missing medium-tier test, document `Task` as intentionally complex-tier-only.

---

### 9. No subagent dispatch count in the UI

**Impact: Low-Medium** — The user cannot see how many subagent calls have been made in the current run (the budget is 2 max, but the counter is invisible).

**Evidence:** `subagentCallCounts` map (`subagents.ts:91`) is internal. No event or store state exposes the count to the TUI. The StatusBar has no "subagents: 1/2" indicator.

**Fix:** Emit the count via `subagent_started` event payload; render in StatusBar or as a toast: "Subagent 1/2 dispatched".

---

### 10. Provider mismatch risk for subagent dispatch

**Impact: Low-Medium** — `toolExecutor.ts:1123-1127` defaults to `"openai"` when no request context exists. This is reachable under headless mode (`--output-format json`).

**Evidence:** `deferred-work.md` item 222 — "the fallback disagrees with the request path's `"anthropic"` for the same empty context." The comment at `toolExecutor.ts:1123` acknowledges this: `"`fallback: "openai"` is THIS site's own historical default."`

**Fix:** Default to `"anthropic"` (matching the project-wide default flip), or require `withRequestContext` at all production entry points.

---

## Appendix — Comparison: Current vs Nested-Task Model

| Aspect | Current (flat) | Nested-task model (target) |
|---|---|---|
| Transcript layout | Flat stream, subagent calls indistinguishable | Expandable per-subagent section with header |
| Start/complete events | Dropped in TUI | Rendered as section header + summary line |
| Cost attribution | Aggregate only | Per-subagent cost line in section header |
| Progress indication | None | Iteration counter in spinner label |
| Approval context | No subagent indication | "↳ Worker requests:" prefix |
| Resume | Subagent structure lost | Structured events persisted to JSONL |
| Metrics | No subagent rows | Dispatch count, success rate, cost per type |
| Parallel indicators | N/A (serial only) | N/A until parallel dispatch is built |
