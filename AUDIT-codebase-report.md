# Zone Codebase Audit Report

**Version:** 2.3.0 | **Date:** 2026-09-09 | **Source files:** 963 `.ts`/`.tsx` | **~105k LOC**

---

## 1. Module Map

Every top-level directory under `src/`, its responsibility, approximate non-test LOC, and dependency direction.

| Module | LOC | Responsibility | Depends On |
|--------|-----|---------------|------------|
| **cli** | 6,736 | CLI entry, arg parsing, TUI (Ink/React), dispatch orchestration, user-facing output | core, llm, api, tools, engine, repo, utils, types, hooks, mcp, visual, memory, snapshots, remote, usage, billing |
| **core** | 23,245 | Agent orchestration: `runLlmPatchFlow` (11.5k LOC monolith), event lifecycle, patch conversion, verification, scoring, decision traces | llm, tools, api, engine, repo, prompts, utils, types, semantic, patch, ast |
| **llm** | 24,707 | LLM adapters (OpenAI/Anthropic), agent loop, model registry, token budgets, subagent dispatch, compaction, planning, task classification | api, core, tools, repo, utils, types, engine, prompts |
| **tools** | 6,365 | Tool definitions, executor (read/write/search/patch/shell), scope guard, background process registry | utils, types, api, core |
| **api** | 2,950 | Disk persistence: trust store, API keys, sessions, approvals (command/edit/staged/trust), MCP config, hooks config, run envelopes, model settings, image upload | utils, types, mcp |
| **engine** | 2,554 | Decision engine: patch correctness validation, quality scoring, scope validation, safety level resolution, contradiction detection | utils, types |
| **repo** | 3,523 | Repository analysis: file scanning, dependency graph, framework detection, git integration, file ranking, project structure detection | utils, types, embeddings |
| **mcp** | 354 | MCP (Model Context Protocol) client manager — single file wrapping `@modelcontextprotocol/sdk` | api |
| **remote** | 927 | WebSocket remote control server + adapter for driving sessions from external clients | utils, types |
| **memory** | 312 | Init flow (first-run repo analysis), memory persistence | core, llm, utils |
| **embeddings** | 560 | Embedding generation and repository indexing (Babel AST + chunked) | utils |
| **prompts** | 550 | Prompt templates for full-patch, preview, feature planning | types |
| **patch** | 1,297 | Patch parsing, risk analysis, conversion helpers | utils, types |
| **patch-generation** | 524 | Patch generation orchestration (distinct from core's runLlmPatchFlow) | llm, core, types |
| **ast** | 993 | AST-based patch fallback using Babel parser/traverse/generator | utils |
| **snapshots** | 425 | Git snapshot store for undo/rollback | utils |
| **semantic** | 384 | Semantic risk detection rules and scoring | types |
| **hooks** | 444 | User hook runner (pre/post-tool shell commands), trust verification | api, utils |
| **audit** | 442 | Decision audit snapshots | types, utils |
| **usage** | 904 | Usage tracking and cost metering | api, utils |
| **visual** | 141 | Tier/settings resolution for visual display | api |
| **billing** | 194 | Conversation cost repository | utils |
| **ci** | 250 | CI result evaluation | utils |
| **feedback** | 187 | Feedback report generation | utils |
| **apply** | 163 | Patch application to filesystem | utils |
| **types** | 451 | Shared type definitions (agent, conversation, mode, patch, project, risk, schema) | — |
| **utils** | 947 | Logging, marker sink, debug helpers | — |

### Dependency Direction (simplified)

```
cli ──→ core ──→ llm ──→ tools ──→ utils
 │       │        │                    ↑
 │       │        ├─→ api ─────────────┘
 │       │        │    ├─→ mcp
 │       │        │    └─→ types
 │       │        ├─→ engine
 │       │        ├─→ repo ──→ embeddings
 │       │        ├─→ prompts
 │       │        └─→ semantic, patch, ast
 │       ├─→ api, tools, engine, repo, hooks, mcp, memory, snapshots, remote, usage, billing, visual
 └─→ utils, types (leaf modules)
```

### Circular Dependencies

| Cycle | Severity | Evidence |
|-------|----------|----------|
| **core ↔ llm** | **HIGH** | `core/runLlmPatchFlow.ts` (11,540 LOC) calls `llm/agentLoop.ts` for the agent loop, plan generation, provider access. `llm/agentLoop.ts` (6,175+ LOC) imports from `core/buildVerifyDiagnostic.ts`, `core/fileDiff.ts`, `core/agentLifecycleEvents.ts`, `core/todoLifecycle.ts`. These two files form the system's heart but create a deep bidirectional coupling. |
| **llm ↔ tools** | **HIGH** | `llm/agentLoop.ts` calls `tools/toolExecutor.ts` (`executeTool`, `withStagingTempFlush`). `tools/toolExecutor.ts` calls back into `llm/agentLoop.ts` (`runAgentLoop`, `classifyFailure`, `finalizeStaging`, `parsePatchBlocks`). |
| **core ↔ tools** | **MEDIUM** | `core/` imports `tools/toolExecutor.ts` (`checkPathBoundary`), `tools/toolDefinitions.ts` (`ZONE_TOOLS`), `tools/toolRegistry.ts`, `tools/capabilities.ts`. `tools/` imports `core/buildEnv.ts`, `core/todoLifecycle.ts`, `core/buildVerifyDiagnostic.ts`. |
| **core ↔ engine** | **MEDIUM** | `core/` imports engine for quality scoring, correctness validation, micro-edit protection, design-system signals. `engine/` imports `core/runLlmPatchFlow.ts` (`DeveloperPatchScope`, `buildDeterministicFallbackPatch`). |
| **core ↔ repo** | **MEDIUM** | `core/runLlmPatchFlow.ts` imports `scanRepo`, `rankRelevantFiles`, `detectFramework`. `repo/` imports `core/intentAwareScore.ts` and `core/taskIntentParser.ts`. |
| **llm ↔ hooks** | LOW | `llm/` uses hooks for pre/post-tool-use interception. `hooks/` references `core/buildEnv` and `api/diskHooks` but not `llm` directly. |
| **llm ↔ cli** | LOW | `llm/` imports `cli/config.ts` (`loadCliConfig`). `cli/` imports heavily from `llm/`. Asymmetric — the llm→cli direction is thin. |
| **llm ↔ memory** | LOW | `llm/agentLoop.ts` imports `memory/projectMemory.ts`. `memory/initFlow.ts` imports `llm/investigationFlow.ts`. |
| **llm ↔ api** | LOW | `llm/` imports `api/diskRunEnvelope.ts`, approval modules. `api/` re-exports from `llm/planApprovals.ts`. Mostly types and re-exports. |
| **cli ↔ api** | LOW | `cli/` imports many api modules. `api/stagedApprovals.ts` imports `cli/tui/hooks/useAgentEvents.ts`. Thin reverse direction. |

### Leaf Modules (no cross-module dependencies)

`ci/`, `patch-generation/`, `semantic/`, `snapshots/` — fully self-contained, importing only from `node_modules` or within themselves.

### Notable: `dist/` imports

`ast/` and `repo/` import from compiled `dist/` output (e.g., `dist/tools/toolExecutor.js`) rather than TypeScript source, suggesting build-time coupling or test-only usage that bypasses the normal dependency graph.

---

## 2. TUI Stack

### Rendering Library

**Ink v7.0.3** (React-for-terminals) with **React 19.2.0**. Ink renders a React component tree to stdout using Yoga flexbox layout.

- JSX configured via `"jsx": "react-jsx"` in tsconfig.json
- Build: plain `tsc` (no bundler for TUI — ships compiled JS)
- Testing: `ink-testing-library` v4.0.0 with `vitest`

### Render Loop

| Aspect | Location |
|--------|----------|
| `runTui()` entry | `src/cli/tui/index.tsx:911` — the async function that orchestrates startup |
| React tree mount | `src/cli/tui/index.tsx:1361` — `render(<ErrorBoundary><App .../></ErrorBoundary>, { exitOnCtrlC: false, alternateScreen: false })` |
| `waitUntilExit()` | `src/cli/tui/index.tsx:1430` — the TUI blocks here until Ink unmounts |
| `App` (store wrapper) | `src/cli/tui/App.tsx:328` — wraps everything in `<StoreProvider>`, passes initial values |
| `AppInner` (UI logic) | `src/cli/tui/App.tsx:101` — the real component: hooks, modal stack, layout (`<Box flexDirection="column">`) |
| Store provider | `src/cli/tui/store.tsx:25` — `StoreProvider` wraps children in React context with `useReducer` |

### Inline-Scrollback vs Alternate-Screen

**Inline scrollback** — explicitly configured at `src/cli/tui/index.tsx:1410`:

```typescript
{ exitOnCtrlC: false, alternateScreen: false }
```

This means Zone renders into the terminal's normal scroll buffer. When the process exits, the output remains visible (like `git log`, not like `vim`). The `alternateScreen: false` flag is deliberate — Ink defaults to alternate screen, and Zone opts out.

### Stdout Shield

`src/cli/tui/stdoutShield.ts` monkey-patches `process.stdout.write` and `process.stderr.write` to intercept telemetry markers (`[tag]` lines) and result lines (`✓`/`✗`/`⚠`) that would otherwise interleave with Ink's output. These are either swallowed or routed to stderr. This is necessary because the agent loop's callback chain sometimes writes to stdout outside the React tree.

### What Triggers Redraws

| Trigger | Mechanism | Location |
|---------|-----------|----------|
| **Store dispatch** | `useReducer` in `StoreProvider` — every `StoreAction` dispatch produces new state → React re-renders the tree | `store.tsx:21` |
| **Event bus → dispatch** | `useAgentEvents` hook subscribes to `bus.on(...)` for ~40 event types, translates to `StoreAction[]` via `eventToActions()`, calls `dispatch()` | `hooks/useAgentEvents.ts:186-300` |
| **Narration debounce** | 200ms debounce timer on narration text events before dispatching `TRANSCRIPT_APPEND_NARRATION` | `hooks/useAgentEvents.ts:194-202` |
| **Streaming answer debounce** | 200ms debounce on `chat_chunk` events before `STREAMING_ANSWER_SET` | `hooks/useAgentEvents.ts:204-219` |
| **Spinner animation** | `setInterval` at 100ms in `Spinner.tsx:20` cycling box-drawing frame characters; only active when `state.spinner?.active` | `components/Spinner.tsx:20` |
| **Status bar tick** | `setInterval` at 1000ms in `StatusBar.tsx:98` to update elapsed time display; guarded: only when `runState === "running"` and no approval modal blocking | `components/StatusBar.tsx:98` |
| **Terminal resize** | `process.stdout.on("resize")` → 100ms debounce → clear screen (`\x1b[2J\x1b[3J\x1b[H`) + `TRANSCRIPT_REMOUNT` (bumps `<Static>` key to force re-emission at new width) | `index.tsx:1415-1432`, logic in `resize.ts:47` |
| **Metrics auto-refresh** | `setInterval` at 60,000ms in `MetricsModal.tsx:51`; only active when modal is open with auto-refresh enabled | `components/MetricsModal.tsx:51` |

There is **no requestAnimationFrame** and **no explicit forceUpdate** — all redraws flow through React's standard reconciliation triggered by `dispatch()`.

---

## 3. Event Pipeline: `tool_call` from Producer to Pixel

### Complete Hop Trace

```
[1] PRODUCER: Agent loop emits tool_call
    File: src/core/runLlmPatchFlow.ts:5620
    Code: emitStructuredProgress({ type: "tool_call", title, status: "active" })
    Also: src/core/runLlmPatchFlow.ts:5626 (onToolCall callback from agentLoop)

[2] emitStructuredProgress closure
    File: src/core/runLlmPatchFlow.ts:4477-4493
    Stamps runId + ts onto the event, calls input.onProgress({ stage, progress })

[3] onProgress callback (TUI bridge)
    File: src/cli/tui/index.tsx:551-557
    Code: const onProgress = (update) => { const evt = update.progress; bus.emit(evt.type, evt); }
    Translates the callback-based progress into EventEmitter emissions

[4] EventBus (Node.js EventEmitter)
    File: src/cli/eventBus.ts:1-33
    Implementation: new EventEmitter() with setMaxListeners(50)
    Pattern: pub/sub — emit(type, event) → all registered handlers fire synchronously

[5] useAgentEvents subscription
    File: src/cli/tui/hooks/useAgentEvents.ts:274
    Code: bus.on("tool_call", flushFirst)
    The "flushFirst" handler flushes any pending narration buffer first, then processes

[6] eventToActions translator
    File: src/cli/tui/hooks/eventToActions.ts:86-100
    Code: case "tool_call" → actions: [NARRATION_COMMIT, TOOL_CALL_OPEN { toolName, args, patch }]
    Pure function: event → { actions: StoreAction[], intents: ResolverIntent[] }

[7] React dispatch
    File: src/cli/tui/hooks/useAgentEvents.ts:225
    Code: applyActions(actions) → for (const a of actions) dispatch(a)
    Triggers React useReducer reconciliation

[8] Store reducer
    File: src/cli/tui/store-core.ts (reducer function, ~1438 LOC)
    TOOL_CALL_OPEN: flushes read-only batch, opens new tool_call transcript entry
    State mutation: immutable — returns new StoreState via spread

[9] Transcript component
    File: src/cli/tui/components/Transcript.tsx:1-165
    Renders <Static> items for committed entries + live tail for in-progress
    tool_call entries render via <ToolCall> component

[10] ToolCall component → pixel
    File: src/cli/tui/components/ToolCall.tsx:1-89
    Renders: tool name, args, patch diff, result status glyphs
    Ink converts React elements to ANSI escape sequences → stdout
```

### Queues and Buffers in the Pipeline

| Buffer | Location | Purpose |
|--------|----------|---------|
| **Narration buffer** (`localBuffer` ref) | `useAgentEvents.ts:183` | Accumulates text fragments, debounced 200ms flush to avoid per-character dispatches |
| **Streaming answer buffer** (`streamingAnswerBuffer` ref) | `useAgentEvents.ts:182` | Accumulates chat_chunk deltas, debounced 200ms, wholesale replace of `liveTail.streamingAnswer` |
| **Read-only batch** (`pendingReadOnlyBatch`) | `store-core.ts:61-72` | Collapses consecutive read-only tool calls into one `tool_call_group` transcript entry |
| **Narration accumulator** (`liveTail.narrationBuffer`) | `store-core.ts` | Holds uncommitted narration text until `NARRATION_COMMIT` action flushes it to transcript |

### Backpressure Behavior

**There is no explicit backpressure mechanism.** The pipeline is:

1. **Synchronous event bus**: `EventEmitter.emit()` fires all listeners synchronously. If the React dispatch is slow, the agent loop blocks until all listeners return.
2. **Debounced text**: The 200ms debounce on narration/streaming is the only throttle — it coalesces rapid-fire text events into single dispatches.
3. **No queue depth limit**: Events are not buffered in a bounded queue. If events arrive faster than React can reconcile, they accumulate in the EventEmitter's listener call stack.
4. **React batching**: React 19 batches state updates automatically, so multiple rapid dispatches in the same microtask are coalesced into one render.

The practical risk: a fast agent loop emitting thousands of events/sec could cause memory growth in the transcript array (which is unbounded) or create visible UI lag if dispatches outpace rendering.

### Complete 18-Hop Trace (tool call + result)

```
── TOOL CALL (open) ──────────────────────────────────────────────────
 [1]  agentLoop.ts:5185    input.onToolCall?.(name, parsedArgs)
 [2]  runLlmPatchFlow.ts:5667  emitStructuredProgress({ type: "tool_call", ... })
 [3]  runLlmPatchFlow.ts:4489  input.onProgress?.({ stage, progress })
 [4]  tui/index.tsx:555    bus.emit(evt.type, evt)
 [5]  eventBus.ts:17       emitter.emit(type, event) [synchronous]
 [6]  useAgentEvents.ts:274 bus.on("tool_call", flushFirst)
 [7]  useAgentEvents.ts:240 flushBuffer() + eventToActions(evt, ctx)
 [8]  eventToActions.ts:139 → [NARRATION_COMMIT, TOOL_CALL_OPEN]
 [9]  store-core.ts:645    TOOL_CALL_OPEN → state.liveTail.currentToolCall = {...}
[10]  Transcript.tsx:157   liveToolCall && <Text dimColor>...</Text>

── TOOL EXECUTES ─────────────────────────────────────────────────────
[11]  agentLoop.ts:5381    executeTool(name, args, ...) returns result
[12]  runLlmPatchFlow.ts:5716  emitStructuredProgress({ type: "tool_result", ... })
[13]  tui/index.tsx:555    bus.emit("tool_result", evt)
[14]  useAgentEvents.ts:254 bus.on("tool_result", simple)
[15]  eventToActions.ts:160 → [TOOL_RESULT_PUSH, TOOL_CALL_CLOSE]
[16]  store-core.ts:659    TOOL_RESULT_PUSH → transcript.push({ kind: "tool_call", ... })
      store-core.ts:693    TOOL_CALL_CLOSE → liveTail.currentToolCall = null
[17]  Transcript.tsx:44-48  <ToolCall toolName={...} results={...} />
[18]  ToolCall.tsx:33      Renders glyph + name + args + diff/preview → ANSI → stdout
```

---

## 4. State Management

### Architecture: Hybrid — Centralized UI Store + Scattered Registries

Zone uses a **single `useReducer` store** as the primary state container for the TUI, following the Flux/Redux pattern. However, behind it there are at least **eight independent in-memory registries** (module-level `Map` singletons) for cross-process communication protocols, plus filesystem-backed stores for durable persistence. There is no unified state container that spans the whole application.

### Top 10 State Holders

| # | State Holder | File:Line | Type | Key Mutators |
|---|-------------|-----------|------|-------------|
| 1 | **`StoreState`** (central UI store) | `cli/tui/store-core.ts` + `cli/tui/store.tsx:25` | React `useReducer` + Context | `reducer()` handles ~120 action types. Dispatched from 3 paths: (a) `useAgentEvents` hook during runs, (b) `storeCapture.dispatch` imperative bridge from `index.tsx` (21 call sites), (c) React components via `useStore()` |
| 2 | **6 approval/question registries** | `api/commandApprovals.ts:201`, `api/editApprovals.ts:10`, `api/stagedApprovals.ts:26`, `api/questionApprovals.ts:37`, `llm/planApprovals.ts:70`, `llm/revisionApprovals.ts:32` | Module-level `new Map()` singletons | Agent loop calls `request*()` → inserts Promise into Map. TUI calls `resolve*()` → deletes from Map, resolves Promise, unblocking agent loop. These are the **primary scattered state holders**. |
| 3 | **`agentLoop` local state** | `llm/agentLoop.ts:3580-3640` | Function-local per-run | `wireMessages` (LLM conversation history, mutated via `applyAppendOps` at lines 4368/5313/5517/5533), `TokenBudgetMeter`, `DetectorState`, staging `Map`, `breakdownEvents[]`, iteration counters |
| 4 | **`runLlmPatchFlow` local state** | `core/runLlmPatchFlow.ts` | Function-local (11.5k LOC) | `beforeByFile` Map, `runTodos[]`, `filesModified` Set, `stagedFiles` — accumulated across tool calls |
| 5 | **`CliConfig` (mutable object)** | `cli/config.ts` | Object mutated in-place | `onModelApply` callback in `index.tsx:1390-1401` mutates `config.model`, `config.provider`, `config.effort`. Not reactive — changes take effect on next run |
| 6 | **`AsyncLocalStorage` request context** | `llm/openaiContext.ts:21` | `AsyncLocalStorage<ZoneRequestContext>` | `withRequestContext()` wraps async ops. Carries userId, runId, subagentId, effort, API key through call stack |
| 7 | **`runCommandCaches`** | `tools/toolExecutor.ts:174` | Module-level `Map<string, PerRunCache>` | `executeTool()` populates on `run_command`. `clearCommandCacheForRun()` deletes on run end |
| 8 | **`conversationFilesystemStore`** | `core/conversationFilesystemStore.ts` | Disk JSONL at `.zone/conversations/` | `appendFsConversationEvent()`, `readFsConversationEvents()` — capped at 50 events per thread |
| 9 | **Snapshot store** | `snapshots/snapshotStore.ts` | Disk at `~/.zone/snapshots/` | `createSnapshot()` after tool flush, `restoreSnapshot()` for undo. SHA-256 integrity in `manifest.json` |
| 10 | **Project memory** | `memory/projectMemory.ts` | Disk at `.zone/memory.md` | `appendMemory()`, `deleteMemoryEntry()` — FIFO capped at 20 entries. Injected into agent system prompt |

### State Flow Analysis

| Pattern | Where Used |
|---------|-----------|
| **Top-down via React Context** | `StoreProvider` → `useStore()` hook → all components access `state` + `dispatch` |
| **Event-driven (EventBus bridge)** | Agent loop → `onProgress` callback → `bus.emit()` → `useAgentEvents` handler → `eventToActions()` → `dispatch()`. The agent loop is **not** inside the React tree. |
| **Promise-based (approval registries)** | Agent loop calls `request*()` → parks on Promise in module-level Map. TUI shows modal. User responds → TUI calls `resolve*()` → resolves Promise, unblocks loop. Bidirectional async protocol. |
| **Callback injection** | Parent (`index.tsx`) passes `onSubmit`, `onModelApply`, `onUndoRequest` callbacks down through props |
| **Imperative dispatch bridge** | `storeCapture.dispatch` — the TUI index captures the dispatch function via `onDispatchCapture` (line 1406) and uses it from outside React for toasts, undo, resize, etc. (21 call sites) |
| **Direct disk I/O** | `api/disk*.ts` modules read/write JSON files synchronously; called from both TUI event handlers and agent loop |
| **Refs for transient UI state** | `useRef` in `useAgentEvents` for debounce buffers, streaming accumulators — never trigger renders |

### Three Distinct "Conversation Histories"

| History | Location | Scope | Mutator |
|---------|----------|-------|---------|
| **LLM conversation** | `agentLoop.ts` — `wireMessages` | Per-run, function-local | `applyAppendOps` in agent loop for-body |
| **UI transcript** | `store-core.ts` — `state.transcript` | Per-session, React state | Reducer via `dispatch` from event bus |
| **Durable conversation** | `conversationFilesystemStore.ts` | Cross-session, disk JSONL | `appendFsConversationEvent()` from `_runPromptImpl` |

### Key Observation

The architecture is **clean in the UI layer** (single store, pure reducer, unidirectional data flow) but **scattered in the orchestration layer**: 6 module-level Map singletons for approval/question protocols, function-scoped mutable state in `runLlmPatchFlow.ts` (11,540 LOC), and a mutable `CliConfig` object threaded through closures. The store only sees events that the orchestration layer chooses to emit.

---

## 5. Component Inventory

### Top-Level Components

| Name | File | LOC | Modal/Inline | Purpose |
|------|------|-----|-------------|---------|
| App | `cli/tui/App.tsx` | 353 | Inline | Root component — composes all panels, handles keyboard input, manages modal visibility |
| Transcript | `cli/tui/components/Transcript.tsx` | 165 | Inline | Scrollable history of tool calls, narrations, errors, and assistant responses using Ink `<Static>` |
| Composer | `cli/tui/components/Composer.tsx` | 777 | Inline | Main input field with multi-line editing, image attachment, slash commands, at-file completion |
| StatusBar | `cli/tui/components/StatusBar.tsx` | 136 | Inline | Bottom bar showing model, cost, iteration count, token budget ratio, run duration |
| Spinner | `cli/tui/components/Spinner.tsx` | 29 | Inline | Animated spinner with label text (planning, generating, etc.) |
| Toast | `cli/tui/components/Toast.tsx` | 28 | Inline | Auto-dismissing notification (info/warning/error) overlay |

### Modal Components

| Name | File | LOC | Modal/Inline | Purpose |
|------|------|-----|-------------|---------|
| ApprovalModal | `cli/tui/components/ApprovalModal.tsx` | 75 | **Modal** | Command/edit approval prompt (y/n) with command display |
| TrustModal | `cli/tui/components/TrustModal.tsx` | 39 | **Modal** | Trust grant prompt for new project directories |
| HookTrustModal | `cli/tui/components/HookTrustModal.tsx` | 67 | **Modal** | Trust approval for user hooks configuration |
| McpTrustModal | `cli/tui/components/McpTrustModal.tsx` | 76 | **Modal** | Trust approval for MCP server configuration |
| ModelModal | `cli/tui/components/ModelModal.tsx` | 187 | **Modal** | Model picker: catalog list, free-text custom model, gateway selection |
| EffortModal | `cli/tui/components/EffortModal.tsx` | 84 | **Modal** | Effort level picker (low/medium/high) |
| SummaryModal | `cli/tui/components/SummaryModal.tsx` | 70 | **Modal** | Summary format picker (compact/detailed) |
| PlanModeModal | `cli/tui/components/PlanModeModal.tsx` | 71 | **Modal** | Plan depth picker (investigate/quick/strict) |
| SessionMemoryModal | `cli/tui/components/SessionMemoryModal.tsx` | 81 | **Modal** | Session memory toggle and clear |
| MetricsModal | `cli/tui/components/MetricsModal.tsx` | 154 | **Modal** | Live usage metrics: tokens, cost, cache hit rate, iteration breakdown |
| LimitsModal | `cli/tui/components/LimitsModal.tsx` | 69 | **Modal** | Daily USD cap configuration |
| PlanModal | `cli/tui/components/PlanModal.tsx` | 49 | **Modal** | Scope revision approval/rejection |
| PlanActionPrompt | `cli/tui/components/PlanActionPrompt.tsx` | 129 | **Modal** | Plan-ready approval gate with steps, risk hints, scope summary |
| StagedDiffModal | `cli/tui/components/StagedDiffModal.tsx` | 117 | **Modal** | Staged file diff review before commit |
| CommitModal | `cli/tui/components/CommitModal.tsx` | 117 | **Modal** | Git commit message editor and confirmation |
| FeedbackModal | `cli/tui/components/FeedbackModal.tsx` | 117 | **Modal** | Bug report / feedback submission with log attachment |
| UndoModal | `cli/tui/components/UndoModal.tsx` | 69 | **Modal** | Snapshot undo confirmation with drifted file list |
| SessionsModal | `cli/tui/components/SessionsModal.tsx` | 78 | **Modal** | Session history browser for resume |

### View Components

| Name | File | LOC | Modal/Inline | Purpose |
|------|------|-----|-------------|---------|
| PermissionsView | `cli/tui/components/PermissionsView.tsx` | 47 | **Modal** | Trust prefix management (add/remove trusted paths) |
| ApiKeysView | `cli/tui/components/ApiKeysView.tsx` | 299 | **Modal** | API key management: add, edit, delete, pricing configuration |
| PlanPanel | `cli/tui/components/PlanPanel.tsx` | 33 | Inline | Compact plan step list shown during execution |
| QuestionPanel | `cli/tui/components/QuestionPanel.tsx` | 52 | Inline | Agent question display when loop is parked on ask_user |

### Content Components

| Name | File | LOC | Modal/Inline | Purpose |
|------|------|-----|-------------|---------|
| ToolCall | `cli/tui/components/ToolCall.tsx` | 89 | Inline | Single tool call rendering: name, args, patch diff, result status |
| ToolCallGroup | `cli/tui/components/ToolCallGroup.tsx` | 65 | Inline | Collapsed batch of read-only tool calls (e.g., "5 reads") |
| DiffView | `cli/tui/components/DiffView.tsx` | 73 | Inline | Unified diff display with +/- coloring |
| MarkdownText | `cli/tui/components/MarkdownText.tsx` | 95 | Inline | Markdown rendering (headings, lists, code blocks, bold/italic) |
| CommandTail | `cli/tui/components/CommandTail.tsx` | 44 | Inline | Truncated command output for shell tool results |
| PlanBody | `cli/tui/components/PlanBody.tsx` | 130 | Inline | Plan steps rendering with file associations |
| ErrorLine | `cli/tui/components/ErrorLine.tsx` | 6 | Inline | Red error text line |
| DimLine | `cli/tui/components/DimLine.tsx` | 5 | Inline | Dimmed/gray helper text |
| ErrorBoundary | `cli/tui/components/ErrorBoundary.tsx` | 24 | Inline | React error boundary with crash handler |

### Non-TSX TUI Support

| Name | File | LOC | Purpose |
|------|------|-----|---------|
| store-core (reducer) | `cli/tui/store-core.ts` | 1,438 | Central state type definitions, `buildInitialState()`, `reducer()` — the largest single TUI file |
| store (provider) | `cli/tui/store.tsx` | 33 | React context provider wrapping useReducer |
| eventToActions | `cli/tui/hooks/eventToActions.ts` | 433 | Pure function mapping `ZoneStructuredProgressEvent` → `StoreAction[]` |
| useAgentEvents | `cli/tui/hooks/useAgentEvents.ts` | 368 | React hook that subscribes to EventBus and dispatches store actions |
| index (entry) | `cli/tui/index.tsx` | 1,479 | CLI startup: config loading, Ink render, session management, progress bridge |

### Internal Components

| Name | File | LOC | Modal/Inline | Purpose |
|------|------|-----|-------------|---------|
| SlashCommandPalette | `cli/tui/components/Composer.tsx` (line ~131) | ~50 | Inline | Slash-command autocomplete dropdown. Not exported — used only within Composer. |

### Component Hierarchy

```
App (StoreProvider > AppInner)
 ├── Transcript (<Static> committed entries)
 │    ├── ToolCall (+ embedded DiffView, CommandTail)
 │    ├── ToolCallGroup
 │    ├── ErrorLine
 │    ├── MarkdownText
 │    ├── PlanBody
 │    └── DiffView (in post_execute_diffs entries)
 ├── Spinner
 ├── [Conditional modals block]
 │    ├── Toast (auto-dismiss overlay)
 │    ├── ApprovalModal
 │    ├── TrustModal / HookTrustModal / McpTrustModal
 │    ├── PermissionsView / ApiKeysView
 │    ├── SessionsModal
 │    ├── ModelModal / EffortModal / SummaryModal / PlanModeModal / SessionMemoryModal
 │    ├── MetricsModal / LimitsModal
 │    ├── CommitModal / FeedbackModal / UndoModal
 │    ├── PlanModal / StagedDiffModal (+ DiffView)
 │    └── PlanActionPrompt
 ├── Composer
 │    └── SlashCommandPalette (internal)
 ├── QuestionPanel
 ├── PlanPanel (conditional, during runs)
 └── StatusBar
```

### Reusable vs One-Off

- **Reusable** (used by multiple parents): `DiffView`, `CommandTail`, `MarkdownText`, `PlanBody`, `ToolCall`, `ToolCallGroup`, `ErrorLine`, `DimLine`
- **One-off** (rendered in exactly one place in `AppInner`): All modals, `Composer`, `StatusBar`, `Spinner`, `Transcript`, `PlanPanel`, `QuestionPanel`, `PlanActionPrompt`, `Toast`

### Summary Statistics

- **Total components:** 39 `.tsx` files (excluding tests), plus 1 internal component
- **Total UI LOC:** ~5,800
- **Modal components:** 18 (46%)
- **Inline components:** 17 (44%)
- **Support files:** 4 (~2,300 LOC)
- **Largest component:** `Composer.tsx` at 777 LOC
- **Largest support file:** `store-core.ts` at 1,437 LOC

---

## Appendix: Key Architectural Observations

### Strengths
1. **Clean UI state management** — The `useReducer` + Context approach is idiomatic React. Every visual element reads from a single `StoreState` — no component maintains parallel UI state.
2. **Well-typed event system** — `ZoneStructuredProgressEvent` is a comprehensive discriminated union covering ~50 event types with strong typing end-to-end.
3. **Explicit trust/security model** — Disk-based trust store with per-project approval, hook trust hashing, and MCP trust verification form a layered security boundary.
4. **Inline scrollback** — The `alternateScreen: false` choice means output survives process exit, which is correct for a coding agent.
5. **Three-path dispatch** — The event bus handler, imperative bridge, and component dispatch paths all funnel through the same reducer, preventing state divergence.

### Risks
1. **God function**: `runLlmPatchFlow.ts` at 11,540 LOC is the single largest file and handles orchestration, tool execution, event emission, snapshot management, and more. This is the highest-risk refactoring target.
2. **core ↔ llm ↔ tools coupling triangle**: These three modules (54k LOC combined) form a HIGH-severity circular dependency triangle. `agentLoop.ts` (6,175 LOC) and `toolExecutor.ts` (3,763 LOC) have bidirectional value imports, making independent testing and refactoring difficult.
3. **6 scattered approval registries**: The `request*()/resolve*()` protocol uses 6 independent module-level `Map` singletons for approvals/questions. A bug in any one registry (e.g., missing cleanup on abort) silently hangs the agent loop.
4. **No backpressure**: The event pipeline has no flow control between the agent loop and the UI. The only throttle is a 200ms debounce on text events. A fast loop could overwhelm the React reconciler.
5. **Unbounded transcript**: `TranscriptEntry[]` grows without limit during long sessions — no compaction or eviction on the UI side (the LLM context compacts, but the React transcript does not).
6. **Synchronous EventEmitter**: All bus listeners fire synchronously — a slow listener blocks the agent loop's progress callback, and `setMaxListeners(50)` is a diagnostic threshold, not a queue limit.
7. **Mutable CliConfig**: The config object is mutated in-place by `onModelApply` and `applyDiskKeyFallbacks`. Changes take effect on next run, not the current one — creating a subtle split between the store's mirror and the authoritative config.
