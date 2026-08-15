# DESIGN — TodoWrite: visible task plan + progress in the TUI

Roadmap #3. Status: **IN PROGRESS** (understand-then-port).

## TL;DR

TodoWrite is **not** a from-scratch build. It is a **fully-shipped capability end-to-end** — a
real agent tool, a system-prompt directive, an in-loop interceptor, a typed data model, three
structured progress events, and a complete **Web-UI sidebar render**. The events even **already
reach the TUI event bus** (`index.tsx:249` is a generic `bus.emit(evt.type, evt)` passthrough).
The single missing piece: `useAgentEvents.ts` subscribes to ~30 bus events and **none of the three
todo events**, so the TUI silently drops them.

> **The work is: add three `bus.on(...)` listeners + a small store slice + one Static checklist
> renderer + one bounded one-line live cursor. No agent change, no new tool, no new prompt tokens,
> no cache impact.** This is a pure TUI *consumer* port of data that already flows.

The only real design problem is **rendering**: a live-updating progress panel is, by nature, a
*live region*, and the TUI's live regions ghost/multiply on resize (only `<Static>` is ghost-immune).
The design below keeps the multi-line checklist in `<Static>` (frozen snapshots) and bounds the
only mutating element to a **single line**.

---

## (a) What exists today

### A.1 — The mechanism is a TOOL (not a derived render)

TodoWrite is an **agent tool the model calls**, exactly like Claude Code's TodoWrite. There is a
second, *opt-in* path that *derives* todos from the planner's `[zone-plan]` steps, but it is gated
off by default. Both paths converge on the same `RunTodo` model and the same three events.

**Tool declaration** — `src/tools/toolDefinitions.ts:45-84`:

```ts
name: "TodoWrite",
strict: true,
description: "Live plan sidebar. Call FIRST for any 2+ step task. Skip for true one-shot requests only.",
parameters: { todos: array(1..12) of {
  id: string,            // stable; reuse across calls to update
  content: string,       // ≤80 char title  (normalized to `text` on the wire)
  description: string|null,
  status: "pending" | "in_progress" | "completed" | "skipped",
}}
```

**System-prompt directive** — `src/llm/agentLoop.ts:1918-1931` (`planProgressBlock`), concatenated
into the assembled system prompt at `agentLoop.ts:516` and passed at `:1956`:

> `PLAN VISIBILITY (TodoWrite): Call TodoWrite once near the start of any task with 2+ tool calls…
> Send the COMPLETE list every call — it replaces the prior list. Exactly ONE step in_progress at
> any moment. Before starting a step, flip it to in_progress…`

The directive is present for **patch archetypes** (the multi-step ones) and absent for the
Q&A/investigation branch (the `?` side of the ternary at `agentLoop.ts:1944`) — correct, since
pure Q&A is one-shot. It lives in the **static, cached** prefix → see cost analysis (§C.1).

**In-loop interceptor** — `src/llm/agentLoop.ts:2955-2997`. TodoWrite is **not** dispatched to
`toolExecutor` (it is listed there only as a startup-guard placeholder, `toolExecutor.ts:169-172`).
The agent loop intercepts it: validates via `validateTodoWriteArgs` (`src/tools/todoWriteValidate.ts`),
normalizes `content → text`, emits `todos_initialized` (first call) or `todo_revised` (subsequent),
and returns `"Plan {initialized|revised} with N step(s)."` to the model. **No disk I/O, no project
mutation** — it is a pure UI-progress emitter plus a coherence scaffold for the model.

### A.2 — Data model

`src/core/todoLifecycle.ts:3-11`:

```ts
export type TodoStatus = "pending" | "in_progress" | "completed" | "skipped";
export type RunTodo = {
  id: string;
  text: string;          // tool's `content`, normalized
  description?: string;
  filesLikely?: string[];
  status: TodoStatus;
};
```

Lifecycle helpers (same file): `executionPlanToTodos` (`:13-21`), `startTodo`/`completeTodo`
(`:33-50`, `startTodo` also back-fills earlier `pending`→`completed`), `finalizeTodos`,
`parseTodoProgressMarkers` (`:86-105`, recognizes inline `[step:start:N]`/`[step:done:N]`).
Invariant: **exactly one `in_progress`** (enforced in the validator and by `startTodo`).

### A.3 — The two producers (both already wired)

| Producer | Trigger | Default path? | Code |
|---|---|---|---|
| **Agent `TodoWrite` call** (primary) | Model decides | **Yes — the only live source by default** | `agentLoop.ts:2955-2997` |
| File-write → status auto-advance | A staged write maps to a todo by `filesLikely` | Yes (only once a list exists) | `runLlmPatchFlow.ts:5757,5834` → `startTodoForFile` `:4698-4701` |
| Inline `[step:N]` markers | Model emits marker in text | Yes (fallback) | `agentLoop.ts:2812-2818` |
| **Plan-derived seed** (`initializeTodosFromPlan`) | Orchestrator seeds from `[zone-plan]` steps | **No — gated** `ZONE_PLAN_ORCHESTRATION=1` | `runLlmPatchFlow.ts:5974-6009`, `planOrchestrator.ts:25` |

The decisive comment, `runLlmPatchFlow.ts:5979-5982`:

> *"The default (non-orchestrator) flow leaves the sidebar empty until the agent calls TodoWrite
> in-loop."*

So **on the normal TUI dispatch the live source is the agent calling TodoWrite**; the plan-derived
seed is an opt-in experiment. The TUI consumer is **agnostic** to which producer fired — all roads
emit the same three events.

### A.4 — The three events + payloads

Types — `src/core/agentLifecycleEvents.ts:118-120` and payload fields `:195-203`:

```ts
| "todos_initialized"     // payload: todos: RunTodo[]   (full list)
| "todo_revised"          // payload: todos: RunTodo[]   (full list, replaces prior)
| "todo_status_changed"   // payload: todoId, todoStatus (single delta — no full list)
```

Emit sites — `runLlmPatchFlow.ts`: `emitTodos` (`:4653-4661`), `emitTodoStatus` (`:4663-4672`),
`setTodoStatus` (`:4674-4690`). The agent-loop events are re-bridged in the `onStructuredEvent`
handler at `runLlmPatchFlow.ts:5613-5648` (which also keeps the server-side `runTodos` mirror in
sync). All flow out through `emitStructuredProgress → onProgress`.

**Wire semantics:** init/revise carry the **whole list** (replace); `todo_status_changed` is a
**single-item delta** (`todoId` + `todoStatus`) — the consumer must apply it to its stored list.

### A.5 — Tier gating

`src/tools/tierToolSubsets.ts`: **simple** (5 tools) excludes TodoWrite; **medium** (9) and
**complex** (18) include it. Capability `agent.control` (`builtinCapabilities.ts:40`). So simple
one-file tasks never show a plan (correct); medium/complex multi-step tasks can.

### A.6 — Web UI rendering (the reference to port)

`src/ui/index.html` already renders all of this:

- State: `state.todosByRunId = new Map()` (`:1391`); `setTodosForRun` (`:1610-1625`),
  `updateTodoStatusForRun` (`:1627-1634`), `sanitizeTodoStatus` (`:1552`).
- Render: `renderTodoSidebar()` (`:1637-1673`) — a fixed right-side sidebar, a `done/total`
  counter (`:1658`), one row per todo with status-driven icon (spinner / green ✓ / dim ✗ /
  empty ○) and file badges. CSS `:469-496`. `ensureTodoSidebar` (`:1555-1592`).
- Wire: SSE on `/api/run-replay/:runId` → `handleSSEPayload` routes
  `todos_initialized`/`todo_revised` → `setTodosForRun` and `todo_status_changed` →
  `updateTodoStatusForRun` (`:8882-8889`). **Full-list replace** on init/revise; **single delta**
  on status change — identical semantics to what the TUI will implement.
- Tests: `src/ui/index.test.ts` ("renders mixed todo statuses…", "shows todos for the active
  thread run…").

### A.7 — The TUI gap (one sentence)

`src/cli/tui/index.tsx:245-249` already forwards **every** progress event to the bus
(`bus.emit(evt.type, evt)`), so `todos_initialized` / `todo_revised` / `todo_status_changed`
**already arrive at the bus**. But `src/cli/tui/hooks/useAgentEvents.ts` (bus.on block `:268-303`)
has **no listener for any of them** — they are emitted into the void. The headless sink also no-ops
them (`src/cli/sink.ts:386-388`). That absent subscription is the whole feature.

---

## (b) Relation to existing plan / progress mechanisms

| Mechanism | What it is | Timing | Relation to TodoWrite |
|---|---|---|---|
| **`[zone-plan]` / `executionPlan`** | Upfront LLM plan: `{title, description, filesLikely}[]` (`executionPlan.ts:7-23`) | Pre-execution | **Superset of structure, subset of lifecycle.** A plan step has no `status`; `executionPlanToTodos` adds `status` to make a `RunTodo`. Plan steps feed the *opt-in* derived producer; they also drive the scope-guard. |
| **`plan_summary` event** | "Plan generated" + file list + step count (`server.ts:3687-3703`, payload `agentLifecycleEvents.ts:264-266`) | Pre-execution | A one-shot **preview**, not live progress. Could optionally seed a "plan preview" line; orthogonal to todos. |
| **Plan mode + `PlanReadyModal`** | Shift+Tab plan mode → `plan_ready_for_approval` → modal (`planApprovals.ts:86-96`; TUI handler `useAgentEvents.ts:229-242`; reducer `store.tsx:495-505`) | Pre-execution **approval gate** | **Complementary, not overlapping.** PlanReadyModal = *approve the plan before running*. TodoWrite = *watch the plan execute*. plan → (approve) → execute-with-live-todos. |
| **`PlanModal` / `scope_revision_proposed`** | Mid-run scope under/over-scope revision approval (`useAgentEvents.ts:244-265`) | Mid-execution **approval** | Unrelated to progress rendering; a different modal flow. |
| **TUI.10.M (background / long-running-command progress)** | Backlog thread: surface live progress for long ops; `CommandTail.tsx` (last-N lines, `:5-21`) is its existing bounded-output primitive | During execution | **This panel is the structured-task instance of TUI.10.M.** The plan/progress render is exactly "show live progress of a long multi-step run." It should reuse TUI.10.M's bounded-tail discipline (cap height, never grow unboundedly). |

**Is TodoWrite the same as plan steps?** Same *shape*, different *lifecycle*: plan steps are static
upfront artifacts; todos are the same fields **plus a mutable `status`**, and (on the default path)
are **authored live by the agent**, not derived from the plan. **The gap is purely a TUI
live-progress rendering gap — the data already exists and already flows to the bus.** No new agent
capability is required.

---

## (c) TUI integration design

### C.1 — Data source + cost/cache (the top lens)

**Decision: consume the existing three events. Add no tool, no directive, no agent change.**

Cost/cache consequence of the port itself: **exactly zero new prompt or cache tokens.**

- The TodoWrite tool schema and the `planProgressBlock` directive (~900 chars) are **already in
  every patch-mode run** regardless of surface — the server/Web path already pays for them. They sit
  in the **static, per-run-stable system prefix**, so under Anthropic prompt caching they are part of
  breakpoint #1 and amortize to ≈ $0/run after the first iteration (cache-aware math per the
  prompt-cost note in CLAUDE.md; do **not** use naive base-rate math here).
  **Cache-boundary correction (`docs/deferred-work.md` item 161):** breakpoint #1 covers tools
  alone, not the full system prefix — measured against the per-call usage log. The **tool schema**
  half of this claim is correct (schemas are exactly what breakpoint #1 caches); the
  **`planProgressBlock` directive** half is not, since it is injected into the system prompt, not
  the tools array. Whether it still amortizes to ≈$0/run via breakpoint #2 (which plausibly
  includes system cumulatively once it exists) is unconfirmed this pass — the cost conclusion is
  very likely still directionally right, but not for the stated reason.
- The TUI is a **pure event consumer**. Events already cross the `onProgress → bus.emit` seam
  (`index.tsx:249`). Adding `bus.on` listeners is client-side React only — **no LLM round-trips, no
  schema, no per-update token overhead.**

> **Derive-vs-tool verdict:** the question is moot — the tool already exists *and* is the live
> source. We are not choosing to add a tool; we are choosing to *render data the tool already
> emits*. If TodoWrite adoption proves low (a risk it shares with subagents — see §E), the cheap
> lever is to flip the **already-built** `initializeTodosFromPlan` seed onto the default path (derive
> from `[zone-plan]`, ~free, no new tokens) — but that is a follow-on behavior change, not part of
> this port.

### C.2 — Rendering model (respecting the Ink live-region / `<Static>` / ghost lessons)

The hard constraint (CLAUDE.md "TUI.10 polish" + `Transcript.tsx:55-85`): **`<Static>` is
ghost-immune** (each item rendered once, never re-rendered on resize); the **live region**
(`liveTail` narration `◆` + tool-call `○`, plus the `Spinner`) **re-renders every frame and
ghosts/multiplies on resize** — mitigated only by `<Box flexGrow={1}>` + an explicit
`style={{ width: stdout.columns }}` and by **keeping live regions short**.

A naive "live sidebar panel" is a **tall mutating live region** → the exact ghost-row footgun. The
design splits the feature so the mutating part is bounded to one line:

**Recommended: "frozen checklist in `<Static>` + one-line live cursor."**

1. **On `todos_initialized` / `todo_revised`** → append **one `<Static>` transcript entry** that
   renders the full checklist *as of that moment* (a `plan_snapshot`). Ghost-immune, chronologically
   placed ("here's the plan" right where the agent declared it). On revise, a second snapshot lands
   ("plan revised") — natural diff in scrollback.

   ```
   ▌ Plan (0/3)
   ▶ Locate the failing test
   ○ Patch the bug
   ○ Re-run the suite
   ```

2. **Between snapshots** → a **single-line** live cursor rendered above the Composer, reading
   `state.todos`, showing the current `in_progress` step and a counter. **Exactly one line**,
   width-truncated — same risk profile as the existing one-line `liveToolCall` (`○`) and `Spinner`,
   both of which already work:

   ```
   ▶ Step 2/3 · Patch the bug
   ```

3. **On run completion** (`agent_loop_complete`) → append a **final `plan_snapshot`** showing the
   resolved checklist (`✓`/`✗`/`⊘ skipped`) and clear the live cursor.

This delivers "see the plan + live progress" while the only per-frame-mutating element is **one
bounded line**. The multi-line checklist only ever exists as **immutable Static snapshots**.

**Status glyphs** (match Web UI semantics): `pending ○` · `in_progress ▶` (cyan) ·
`completed ✓` (green) · `skipped ⊘` (dim).

**Rejected alternatives:**

- **Tall live panel (Web-UI-style sidebar mirrored as a live region).** Cleanest visually, but it is
  a multi-line mutating live region → ghosts/multiplies on resize in the no-alt-screen native-scrollback
  model Zone uses (`render { alternateScreen: false }`). This is precisely the TUI.10 footgun. **Rejected.**
- **Pure `<Static>` log (append a line per status change).** Ghost-proof and trivial, but a 3–5 step
  run emits ~10 status deltas → noisy log, and no "where am I now" view. Kept only as the ultra-safe
  fallback if the one-line cursor ever misbehaves.
- **Fold progress into the `Spinner` label** (e.g. spinner text = "Step 2/3 · Patch the bug"). Zero
  new live region. Viable conservative variant, but the spinner label is already multiplexed by many
  events (`useAgentEvents.ts:170-172`), so a dedicated one-line cursor is cleaner. Offered as the
  fallback for the live element.

### C.3 — Store shape

`src/cli/tui/store.tsx`:

- **State** (extend `StoreState` `:51-99`, init in `buildInitialState` `:101-152`):
  `todos: RunTodo[]` (current live list, init `[]`). Import `RunTodo`/`TodoStatus` (type-only) from
  `src/core/todoLifecycle.ts`.
- **TranscriptEntry** (extend the union `:32-38`): add
  `{ kind: "plan_snapshot"; todos: RunTodo[]; label: string }` — carries the frozen list for Static.
- **Actions** (extend `StoreAction` `:154-241`):
  - `{ type: "TODOS_SET"; todos: RunTodo[] }` — from init/revise. Reducer: set `state.todos` **and**
    append a `plan_snapshot` entry (label "Plan"/"Plan revised").
  - `{ type: "TODO_STATUS_SET"; todoId: string; status: TodoStatus }` — from `todo_status_changed`.
    Reducer: map the matching id; when setting `in_progress`, flip any *other* `in_progress`→`completed`
    to preserve the single-active invariant (the wire sends only a delta, mirror `startTodo` locally).
  - Reset `todos: []` on the next run start (`agent_loop_start` / `USER_PROMPT`); the final snapshot is
    appended on completion before reset. `/clear` already nukes Static via `transcriptGeneration`.

### C.4 — Event wiring

`src/cli/tui/hooks/useAgentEvents.ts` — add three handlers + `bus.on`/`bus.off`. **Use named const
handlers** (not inline lambdas) so `bus.off` removes the same reference — this is a known footgun in
this file (the compaction handlers `:296-303` already follow the named-const pattern for exactly this
reason):

```ts
function handleTodosInit(evt)   { dispatch({ type: "TODOS_SET", todos: evt.todos ?? [] }); }
function handleTodoRevised(evt) { dispatch({ type: "TODOS_SET", todos: evt.todos ?? [] }); }
function handleTodoStatus(evt)  { if (evt.todoId) dispatch({ type: "TODO_STATUS_SET",
                                    todoId: evt.todoId, status: evt.todoStatus }); }
bus.on("todos_initialized",  handleTodosInit);
bus.on("todo_revised",       handleTodoRevised);
bus.on("todo_status_changed",handleTodoStatus);
// …mirror in the cleanup return with bus.off(same refs)
```

### C.5 — Components

- **`PlanSnapshot.tsx`** (new) — renders a `plan_snapshot` entry inside `<Static>` via the
  `renderEntry` dispatcher in `Transcript.tsx:9-53`. A header (`▌ Plan (done/total)`) + one `<Text>`
  line per todo with glyph + title. Wrap content `<Text>` in `<Box flexGrow={1}>` (the recurring
  Yoga width fix); it inherits the Static `style={{ width: stdout.columns }}` already on the
  container (`Transcript.tsx:66`). Truncate titles to width.
- **`PlanCursor.tsx`** (new) — the one-line live element. Mount in `App.tsx` render tree
  (`:169-179`), adjacent to `<Spinner/>`, **only when `state.todos.length > 0` and run is running**.
  Reads `state.todos`, renders `▶ Step M/N · <in_progress title>` (or `N/N done`). One `<Text>` in a
  `<Box flexGrow={1}>`; truncate to `stdout.columns`.
- **`toolCallFormat.ts`** already maps `TodoWrite → "Todo"` and marks it `BORING_ON_SUCCESS`, so the
  raw tool-call line stays muted — the snapshot/cursor are the real surface. No change needed there.

---

## (d) Phased plan + file touchpoints

| Phase | Scope | Files | Tests |
|---|---|---|---|
| **1 — Store slice** | `todos` state, `TODOS_SET`/`TODO_STATUS_SET`, `plan_snapshot` entry kind, single-active invariant, reset-on-new-run | `src/cli/tui/store.tsx` | `store.test.tsx`: set/replace/delta/invariant/reset |
| **2 — Event wiring** | three `bus.on` handlers (named consts) + cleanup | `src/cli/tui/hooks/useAgentEvents.ts` | reducer-dispatch unit test; assert init/revise/delta paths |
| **3 — Static snapshot** | `plan_snapshot` render + `renderEntry` case | `src/cli/tui/components/PlanSnapshot.tsx`, `components/Transcript.tsx` | `transcript.test.tsx` at `renderTranscriptAt(60)` and `(80)` (the columns=100 default masks squeeze bugs — CLAUDE.md) |
| **4 — Live cursor** | one-line `PlanCursor`, mount + visibility gate | `src/cli/tui/components/PlanCursor.tsx`, `App.tsx` | render test: one line; truncates at 60 cols; hidden when empty |
| **5 — Lifecycle** | reset on run start, final snapshot on `agent_loop_complete`, `/clear` parity | `store.tsx`, `useAgentEvents.ts` | resume + clear + complete sequences |
| **6 — (optional) headless parity** | print a compact plan line in the CLI sink instead of no-op | `src/cli/sink.ts:386-388` | sink test |
| **7 — (optional, separate) derive-on-default** | flip `initializeTodosFromPlan` onto the default path if adoption is low | `runLlmPatchFlow.ts` (gated) | behavior-change; needs its own decision |

Phases 1–5 are the feature. 6–7 are opt-in follow-ons. No source touched outside `src/cli/tui/**`
for the core (1–5) — confirming "pure consumer."

---

## (e) Risk table

| Risk | Severity | Mitigation |
|---|---|---|
| **Tall live panel ghosts/multiplies on resize** (no-alt-screen scrollback) | High | Multi-line checklist lives **only in `<Static>`** (frozen snapshots). The single mutating element is **one line** (`PlanCursor`). |
| **One-line cursor re-render artifacts** | Low | Bound to one line; `<Box flexGrow={1}>` + truncate to `stdout.columns`; same proven profile as `liveToolCall`/`Spinner`. Fallback: fold into Spinner label (§C.2). |
| **`bus.off` removes nothing** (reference-equality footgun) | Med | Named-const handlers, mirrored in cleanup — the existing file convention (`useAgentEvents.ts:296-303`). |
| **Noise from per-status Static appends** | Med | Snapshot only on init/revise/complete; status deltas drive the live cursor, **not** Static. |
| **Single-`in_progress` invariant broken by deltas** | Med | `todo_status_changed` is a single delta; reducer flips stray `in_progress`→`completed` locally (mirror `startTodo`). |
| **Cost if it were tool-based** | None (already paid) | Tool schema + ~900-char directive are in the **cached static prefix** on every patch run already; marginal ≈ $0. TUI port adds **zero** tokens (consumer only). Cache breakpoint #1 untouched *(the tool-schema half of this is correct; the directive half is a system-prompt injection, not breakpoint #1 — see the correction in §(f) above)*. |
| **Derive-vs-tool mis-decision** | Low | Tool already exists *and* is the default live source; we render existing events. Derive-from-`[zone-plan]` is the cheap **fallback** if adoption is low (Phase 7), not the primary. |
| **Low TodoWrite adoption** (model underuses it, like subagents at 0%) | Med | Directive already nudges; if telemetry shows low usage, enable the already-built `initializeTodosFromPlan` seed on the default path (Phase 7) so the panel populates from the planner even without a TodoWrite call. |
| **Simple-tier runs show nothing** | None (correct) | Simple tier lacks TodoWrite; panel renders only when `todos` non-empty — graceful no-op. |
| **Resume / `/clear` leave stale todos** | Low | Reset `todos: []` on run start; `/clear` already remounts Static via `transcriptGeneration`. |

---

## Open decisions (for Bedo)

1. **Live element:** dedicated one-line `PlanCursor` (recommended) vs fold into the `Spinner` label
   (ultra-conservative). Both bounded to one line.
2. **Per-step Static breadcrumbs:** snapshot-only (recommended, quiet) vs also append a `✓ <title>`
   line to Static as each step completes (more Claude-Code-like, noisier).
3. **Phase 7 (derive-on-default):** ship the consumer first, measure TodoWrite adoption, then decide
   whether to flip the `[zone-plan]`-derived seed onto the default path. Out of scope for the port.
