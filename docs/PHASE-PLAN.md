
---

**`docs/PHASE-PLAN.md`:**

```markdown
# PHASE-PLAN.md — Zone TUI Redesign v2

**Date:** 2026-09-10 · **Scope:** Implementation roadmap for TARGET-ARCHITECTURE.md · **Status:** Approved

---

## Phase 0 — Quick Wins (Master-Ready)

**Scope:** 4 smallest-fix items from 03-debt §3 that are clean, low-risk, and can merge to master independently of the redesign campaign.

**Items:**

1. **Orphaned `planProposal` on SESSION_RESUME** (debt #10)
   - File: `src/cli/tui/store-core.ts:787-819`
   - Change: Add `planProposal: null` to the `SESSION_RESUME` reducer alongside `planReadyProposal: null`.
   - Effort: 5 min
   - Risk: Low (reducer change, no component touch)

2. **Shift+Tab undocumented in `/help`** (debt #2)
   - File: `src/cli/tui/components/Composer.tsx:72-82`
   - Change: Add `"  Shift+Tab   cycle mode (normal → auto-accept → plan)"` to `HELP_LINES` array.
   - Effort: 2 min
   - Risk: None (help text only)

3. **Plan mode forced audit default** (debt #3)
   - File: `src/cli/tui/index.tsx` or `src/cli/dispatch.ts`
   - Change: `process.env.ZONE_PLAN_APPROVAL_CYCLE ??= "1"` at entry point, defaulting to the cheap path.
   - Effort: 5 min
   - Risk: Low (env var default, user can override)

4. **No session memory indicator** (debt #6)
   - File: `src/cli/tui/components/StatusBar.tsx`
   - Change: Add `[M]` pill when `state.modelSettings?.memoryEnabled === true`, mirroring the `[W]` pattern for web search.
   - Effort: 15 min
   - Risk: Low (StatusBar addition)

**Gate:**
- `npm test` green
- Manual smoke: open `/help`, verify Shift+Tab line; open `/keys`, verify no layout shift; start a run with memory enabled, verify `[M]` pill appears; trigger plan mode, verify cost is ~$0.05 not ~$0.22 for a small task.

**Branch:** Can merge to master as a standalone PR, or fold into `feat/tui-redesign` commit 1.

---

## Phase 1 — Golden Harness

**Scope:** Build the event replay test infrastructure that will serve as the regression detector for all subsequent phases.

**Deliverables:**

1. **Replay harness** (`src/cli/tui/__tests__/replayHarness.ts`)
   - Accepts a recorded `ZoneStructuredProgressEvent[]` + initial `StoreState`
   - Pipes each event through `eventToActions()` and the store reducer
   - Renders the resulting tree with `ink-testing-library`
   - Returns `lastFrame()` for snapshot assertion

2. **Golden fixtures** (`src/cli/tui/__tests__/fixtures/`)
   - `run-with-tool-calls.jsonl`: a run with 3 tool calls + narration + diff
   - `approval-modal-cycle.jsonl`: approval modal open/resolve cycle
   - `resize-sequence.jsonl`: resize event sequence (narrowing + widening)

3. **Snapshot tests** (`src/cli/tui/__tests__/golden.test.tsx`)
   - One test per fixture, asserting `lastFrame()` matches stored snapshot
   - Flood test: emit 10,000 synthetic events, assert reducer completes without throwing and transcript length equals expected count

**Gate:**
- `npm test` green (existing 5875 + new golden tests)
- Golden snapshots committed to repo (human-reviewed for correctness)

**Files created:**
- `src/cli/tui/__tests__/replayHarness.ts`
- `src/cli/tui/__tests__/fixtures/*.jsonl`
- `src/cli/tui/__tests__/golden.test.tsx`
- `src/cli/tui/__tests__/__snapshots__/golden.test.tsx.snap`

---

## Phase 2 — Gramer + OverlayLayer

**Scope:** Implement the unshipped portions of `DESIGN-tui9-layout.md` plus the gramer primitifleri from TARGET-ARCHITECTURE.md §2.

**Sub-phases:**

### 2a — Design tokens + lint rule

- Add `spacing` and `width` tokens to `src/cli/tui/theme.ts`
- Unify `role.accent` to `#22B3C4` (was `"cyan"` named color)
- Extend `tokenCoverage.test.ts` to fail on numeric padding literals and hard-coded widths
- Migrate all `paddingX={1}` / `paddingX={2}` / `width="70%"` to token references

**Gate:** `npm test` green, zero token violations in `.tsx` files.

### 2b — Layout primitives

- Create `src/cli/tui/components/primitives/` directory
- Implement: `OverlayShell`, `KeyHints`, `Row`, `SectionTitle`, `ListItem`, `IndentedWrap`, `Panel`
- Each primitive is a pure, stateless component
- Add unit tests for each primitive (render + keyboard handling)

**Gate:** `npm test` green, all primitives have 100% line coverage.

### 2c — OverlayLayer + selectIsBlockingModalOpen

- Add `selectIsBlockingModalOpen` selector to `store-core.ts`
- Add `overlayStack: OverlayId[]` to `StoreState`
- Add `OVERLAY_PUSH` / `OVERLAY_POP` actions to reducer
- Create `OverlayLayer` component that renders the top of the stack
- Migrate 3 representative modals to use `OverlayShell` (Model, ApiKeys, Metrics)
- Update `App.tsx` to render `OverlayLayer` in the `ActiveOutput` slot when `selectIsBlockingModalOpen` is true; hide `Composer` in that state

**Gate:** `npm test` green, manual smoke: open `/model`, verify Composer disappears, StatusBar remains visible, Esc closes modal and Composer reappears.

### 2d — Migrate remaining 15 modals

- Migrate all remaining modals to `OverlayShell`
- Remove inline border/title/footer from each modal component
- Central Esc handler in `OverlayShell`

**Gate:** `npm test` green, manual smoke: open each modal, verify consistent geometry, verify Esc closes top-most overlay.

### 2e — Anomaly fixes

- `ApiKeysView` border color: `caution` → `accent` (debt §4 consistency)
- `CommitModal` / `FeedbackModal`: add `OverlayShell` wrapper (currently borderless)
- `PlanActionPrompt`: convert from always-mounted to conditional mount (debt §4)

**Gate:** `npm test` green, no behavioral regressions.

**Files modified:**
- `src/cli/tui/theme.ts`
- `src/cli/tui/themeCoverage.test.ts`
- `src/cli/tui/store-core.ts`
- `src/cli/tui/App.tsx`
- `src/cli/tui/components/*.tsx` (all 18 modals)
- `src/cli/tui/components/primitives/*.tsx` (new)

---

## Phase 3 — Keybinding Grammar + Central Esc

**Scope:** Standardize the keybinding verb map per TARGET-ARCHITECTURE.md §5.

**Sub-phases:**

### 3a — Verb standardization

- `HookTrustModal.tsx`: `a` → `y` for approve
- `McpTrustModal.tsx`: `a` → `y` for approve
- `KeyHints` footer updated to reflect `y` not `a`
- Update `/help` to document the standard verbs

**Gate:** `npm test` green, manual smoke: trigger hook trust and MCP trust modals, verify `y` approves.

### 3b — Central Esc handler

- `OverlayShell` registers a global `useInput` that checks `state.overlayStack`
- On Esc, dispatch `OVERLAY_POP` to close the top overlay
- If stack is empty, Esc falls through to `App.tsx`'s run-abort logic
- Remove modal-specific Esc handlers from each modal

**Gate:** `npm test` green, manual smoke: open nested overlays (e.g., `/model` → custom model input), verify Esc closes one at a time.

### 3c — Keybinding conflict detection test

- Create `src/cli/tui/keybindingRegistry.test.ts`
- Enumerate all `useInput` handlers across components
- Assert no two handlers claim the same key in the same context
- Fail on conflict

**Gate:** `npm test` green, no conflicts detected.

**Files modified:**
- `src/cli/tui/components/HookTrustModal.tsx`
- `src/cli/tui/components/McpTrustModal.tsx`
- `src/cli/tui/components/primitives/OverlayShell.tsx`
- `src/cli/tui/components/Composer.tsx` (`HELP_LINES` update)
- `src/cli/tui/keybindingRegistry.test.ts` (new)

---

## Phase 4 — Backpressure + Transcript Cap

**Scope:** Implement `uiScheduler` and transcript lifecycle per TARGET-ARCHITECTURE.md §4.

**Sub-phases:**

### 4a — uiScheduler

- Create `src/cli/tui/uiScheduler.ts`
- Bounded ring buffer (512 slots)
- Priority lane for user-blocking events (approval, question, subagent boundaries)
- Coalesce lane for text deltas (200ms debounce, current behavior preserved)
- Batch lane for tool calls (16ms tick)
- Overflow telemetry event

**Gate:** Unit tests for scheduler (enqueue, flush, priority bypass, overflow), `npm test` green.

### 4b — Wire scheduler into event pipeline

- `src/cli/tui/index.tsx`: replace direct `bus.emit()` with `scheduler.enqueue()`
- `useAgentEvents.ts`: replace `bus.on()` with `scheduler.subscribe()`
- Verify all 40 event types flow correctly through the scheduler

**Gate:** `npm test` green, golden replay tests pass (Phase 1 fixtures replayed through scheduler).

### 4c — Transcript cap

- Add `TRANSCRIPT_CAP = 500` and `COMPACT_THRESHOLD = 400` to `store-core.ts`
- Add `compactTranscript()` helper that summarizes old entries
- Add `TranscriptEntry` kind `"compact_summary"`
- `Transcript.tsx` renders compact summary as a single dim line

**Gate:** `npm test` green, flood test (10k events) asserts transcript length ≤ 500.

### 4d — Resize improvement

- `src/cli/tui/resize.ts`: change `shouldRedrawOnResize` to fire only on narrowing (widening is self-correcting in most cases)
- Add escape hatch: if widening by >20%, still redraw (handles edge cases)
- Document the decision in a code comment

**Gate:** `npm test` green, manual smoke: resize window narrower, verify redraw; resize wider, verify no redraw (scrollback preserved).

**Files modified:**
- `src/cli/tui/uiScheduler.ts` (new)
- `src/cli/tui/index.tsx`
- `src/cli/tui/hooks/useAgentEvents.ts`
- `src/cli/tui/store-core.ts`
- `src/cli/tui/components/Transcript.tsx`
- `src/cli/tui/resize.ts`

---

## Phase 5 — Subagent Visibility

**Scope:** Implement nested task model per TARGET-ARCHITECTURE.md §6.

**Sub-phases:**

### 5a — Event listeners

- `useAgentEvents.ts`: add `bus.on("subagent_started")` and `bus.on("subagent_completed")`
- Dispatch `SUBAGENT_STARTED` / `SUBAGENT_COMPLETED` actions
- Add `subagentThreads: Map<subagentId, SubagentThread>` to `StoreState`

**Gate:** `npm test` green, golden fixture with subagent events passes.

### 5b — Transcript rendering

- `Transcript.tsx`: when a `tool_call` entry has `subagentId`, render with indent + header
- Header: `┌─ {subagentType} · {iterations} iters · ${cost} ─────┐`
- Footer: `└───────────────────────────────────────────────────┘`
- Body: subagent's tool calls indented 2 spaces

**Gate:** `npm test` green, manual smoke: trigger a subagent run, verify nested rendering.

### 5c — Spinner label + approval context

- `store-core.ts`: `SUBAGENT_STARTED` updates `spinner.label` to `↳ {subagentType} · {title}`
- `ApprovalModal.tsx`: when approval comes from a subagent, show `↳ worker requests:` prefix
- Thread `subagentId` / `subagentType` through approval request payload

**Gate:** `npm test` green, manual smoke: trigger subagent approval, verify spinner label and modal prefix.

### 5d — MetricsModal + JSONL persistence

- `MetricsModal.tsx`: add rows for "Subagent dispatches", "Subagent cost", "Subagent success rate"
- `conversationFilesystemStore.ts`: write `subagent_started` / `subagent_completed` events to JSONL
- `DiskSession`: add `subagentThreads` field

**Gate:** `npm test` green, manual smoke: open `/metrics` after a subagent run, verify rows; `/sessions` resume, verify subagent structure preserved.

**Files modified:**
- `src/cli/tui/hooks/useAgentEvents.ts`
- `src/cli/tui/store-core.ts`
- `src/cli/tui/components/Transcript.tsx`
- `src/cli/tui/components/ApprovalModal.tsx`
- `src/cli/tui/components/MetricsModal.tsx`
- `src/cli/tui/components/ToolCall.tsx`
- `src/core/conversationFilesystemStore.ts`
- `src/api/diskSessions.ts`

---

## Phase 6 — Config-as-State + InteractionRegistry + Proper Fixes

**Scope:** Architectural cleanup + the remaining "proper fix" items from 03-debt §3.

**Sub-phases:**

### 6a — Config-as-state

- Add `CONFIG_PATCHED` / `CONFIG_PERSISTED` actions to `store-core.ts`
- Migrate `onModelApply` callback → `dispatch({ type: "CONFIG_PATCHED", ... })`
- Add `useConfigPersist` hook that writes `state.config` to disk on change
- Remove mutable `CliConfig` object threading

**Gate:** `npm test` green, manual smoke: change model via `/model`, verify store updates, verify disk writes.

### 6b — InteractionRegistry

- Create `src/cli/interactionRegistry.ts` with `request` / `resolve` / `abort` / `abortAll` methods
- Migrate all 6 approval/question registries to use the unified interface
- Add abort cleanup on session end

**Gate:** `npm test` green, manual smoke: trigger approval, approve, verify loop continues; abort mid-approval, verify no hang.

### 6c — PlanPanel proper fix (Static snapshots + PlanCursor)

- Implement `PlanSnapshot` component (commits full todo list to `<Static>` on init/revise/complete)
- Implement `PlanCursor` component (1-line live element above Composer showing `in_progress` step + counter)
- Remove current `PlanPanel` live region (debt #1 proper fix)

**Gate:** `npm test` green, manual smoke: start a run with todos, verify plan appears in scrollback; resize window, verify no ghost rows.

### 6d — MarkdownText proper fix (Ink-aware renderer)

- Add code fence support (``` fences with dim background + mono font)
- Add numbered list support (indent-aware)
- Add inline link rendering (`[text](url)` → `text (url)`)
- Preserve current bold/code/heading/bullet support

**Gate:** `npm test` green, manual smoke: trigger a run that produces markdown with code fences, lists, links; verify rendering.

**Files modified:**
- `src/cli/tui/store-core.ts`
- `src/cli/tui/index.tsx`
- `src/cli/interactionRegistry.ts` (new)
- `src/cli/tui/components/PlanSnapshot.tsx` (new)
- `src/cli/tui/components/PlanCursor.tsx` (new)
- `src/cli/tui/components/MarkdownText.tsx`
- `src/api/*.ts` (all 6 approval/question modules)

---

## Phase 7 — Deferred (Out of Scope for This Campaign)

**Items:**

1. **`runLlmPatchFlow.ts` split** (11.5k LOC god function)
   - Requires deep understanding of orchestration + tool execution + event emission
   - Separate campaign after TUI parity is achieved
   - Risk: High (touches core agent loop)

2. **Parallel subagent dispatch**
   - Requires rethinking `toolExecutor.ts` sequential dispatch, approval registries, cost tracking
   - Separate campaign
   - Risk: High (concurrency hazards)

3. **MCP tool grouping in transcript**
   - Nice-to-have, not a parity requirement
   - Can be done as a follow-up PR

4. **Classifier non-determinism fix**
   - Requires prompt tuning or deterministic fallback
   - Out of scope for TUI redesign

---

## Commit Sequence
feat/tui-redesign branch:
commit 0: investigation docs + TARGET-ARCHITECTURE.md + PHASE-PLAN.md
commit 1: Phase 0 quick wins (or merge to master separately)
commit 2: Phase 1 golden harness
commit 3: Phase 2a design tokens
commit 4: Phase 2b layout primitives
commit 5: Phase 2c OverlayLayer + 3 representative modals
commit 6: Phase 2d migrate remaining 15 modals
commit 7: Phase 2e anomaly fixes
commit 8: Phase 3a verb standardization
commit 9: Phase 3b central Esc handler
commit 10: Phase 3c keybinding conflict detection test
commit 11: Phase 4a uiScheduler
commit 12: Phase 4b wire scheduler
commit 13: Phase 4c transcript cap
commit 14: Phase 4d resize improvement
commit 15: Phase 5a subagent event listeners
commit 16: Phase 5b transcript rendering
commit 17: Phase 5c spinner label + approval context
commit 18: Phase 5d MetricsModal + JSONL persistence
commit 19: Phase 6a config-as-state
commit 20: Phase 6b interactionRegistry
commit 21: Phase 6c PlanPanel proper fix
commit 22: Phase 6d MarkdownText proper fix

**Total:** 22 atomic commits, each passing `npm test` + manual smoke.

**Merge to master:** After all 22 commits, squash-merge to master as a single PR titled "feat(tui): redesign v2 — Claude Code / Codex / Cursor parity".

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Phase 2 (OverlayLayer) introduces layout regressions | Medium | High | Phase 1 golden harness catches them; manual smoke after each sub-phase |
| Phase 4 (uiScheduler) drops critical events | Low | High | Priority lane for approval/question; overflow telemetry event; flood test |
| Phase 5 (subagent visibility) breaks headless mode | Low | Medium | Headless sink (`sink.ts`) unchanged; TUI-only changes |
| Phase 6 (interactionRegistry) introduces abort bugs | Medium | High | Existing 6 registries are well-tested; migration preserves behavior; abort cleanup tested |
| Commit sequence conflicts with master | Low | Low | `feat/tui-redesign` branch rebased on master before each phase; conflicts resolved in sub-phase commits |

---

## Success Criteria

The campaign is complete when:

1. All 22 commits merged to master
2. `npm test` passes with 5875+ cases (existing + new golden tests)
3. Manual review of a 30-minute run transcript shows:
   - No ghost rows
   - No layout reflow on modal open/close
   - No silent event drops
   - Subagent runs visually distinct
   - Keybinding verbs consistent
   - Esc closes top-most overlay
   - Transcript capped at 500 entries
   - Resize preserves scrollback on widening
4. Cost parity: plan mode small tasks cost ~$0.05 not ~$0.22
5. User feedback: at least 3 beta testers confirm "feels like Claude Code"

---

## Phase 7 — App-feel layer

Competitor app-feel (Claude Code, Codex CLI, Cursor terminal) comes from two things: a persistent
identity frame pinned in scrollback, and bottom chrome that stays visually anchored. Zone keeps
inline scrollback for coding-agent correctness (selection, grep, pipe-to-file all depend on it),
so alternate screen is rejected. Phase 7 adds the identity frame (WelcomeFrame) and unifies the
bottom chrome in the zonecli.dev visual language: lowercase mono, single teal accent (#22B3C4 via
role.brand/role.accent), thin rules instead of heavy boxes, generous whitespace.

### Sub-phases and gates

| Sub-phase | Scope | Gate |
|-----------|-------|------|
| 7a | WelcomeFrame — one-time Static-committed opening frame with boot data (version, user, repo, branch, model, provider, cap, keySource, whatsNew). Store gains `boot: BootData`. | WelcomeFrame.test.tsx passes (fallbacks, cap formatting, rule width at 60/80/120 cols); golden fixture `fresh-session.jsonl` asserts frame lines above empty transcript |
| 7b | StatusBar persistent warning slot — `selectPersistentWarnings(state)` returns ≤ 2 items (rc disconnected, cap > 80%). Rendered right-aligned in role.caution. | StatusBar.test.tsx: warning present/absent, two-warning case, single-line height invariant |
| 7c | Composer chrome — thin top/bottom rules (glyph.separator, role.muted), key-hints row beneath (shift+tab mode · /help · @file · \+enter newline · esc clear). Idle only. | composer.layout.test.tsx: new chrome lines, one-line hints invariant, existing tests unchanged |

### Commits

```
commit 23: Phase 7a WelcomeFrame
commit 24: Phase 7b StatusBar persistent warnings
commit 25: Phase 7c Composer chrome
```

**Total:** 25 atomic commits (Phase 0–7c), each passing `npm test` + manual smoke.

### Updated success criteria

6. Opening frame visible in scrollback on every fresh session; survives resize and compaction
7. Composer key-hints row renders exactly one line at idle
8. StatusBar persistent warnings appear/disappear without layout shift