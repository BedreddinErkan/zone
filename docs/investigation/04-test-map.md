# 04 — Test & CI Infrastructure Map

**Date:** 2026-09-09 · **Scope:** vitest config, test topology, TUI coverage, fixtures, CI gates · **Method:** read-only code trace

---

## §1 — Test Topology

### 1.1 Vitest configuration

**Single config, no workspace splits.**

| Setting | Value | Source |
|---|---|---|
| Config file | `vitest.config.ts` | project root |
| Vitest version | `^2.1.9` | `package.json` devDependency |
| Environment | `node` | `vitest.config.ts` |
| Test runner | `vitest run` | `package.json` `"test"` script |
| Test include | `src/**/*.test.ts`, `src/**/*.test.tsx`, `scripts/**/*.test.ts` | `vitest.config.ts` |
| Test exclude | `src/llm/taskClassifier.archetype.test.ts` | `vitest.config.ts` (separate script `test:l3`) |
| Test timeout | 15,000 ms | `vitest.config.ts` |
| Retry | **none configured** | — |
| Mock policy | `clearMocks`, `restoreMocks`, `mockReset` all `true` | `vitest.config.ts` |
| Coverage provider | `v8` | `vitest.config.ts` |
| Plugins | `@vitejs/plugin-react` | for `.tsx` component tests |
| Global setup | `src/test/setup/globalHome.ts` | temp home dir + repo-guard |
| Setup files | `src/test/setup/homeGuard.ts` | runtime fs-write guard |

**No workspace config** (`vitest.workspace.*` not found). All tests run in a single project.

### 1.2 Totals

| Metric | Count |
|---|---|
| **Test files** | **504** |
| **Test cases** (`it(` + `test(`) | **5,875** |
| **Skipped tests** (`it.skip`) | **18** |
| **Conditional skips** (`it.skipIf`) | 1 |
| **Pending** (`.todo(`) | 0 |

### 1.3 Test file count per top-level module

| Module | Test files | Notable focus |
|---|---|---|
| `src/llm/` | ~90+ | agentLoop (20+ files), adapters, compaction, verification, subagents, plan annotations, metrics |
| `src/cli/tui/` | ~40+ | store reducer, event-to-actions, composer, transcript, components, hooks |
| `src/core/` | ~40+ | runLlmPatchFlow, conversationStore, decision, scoring, multi-file patch |
| `src/tools/` | ~20+ | toolExecutor (10+ files), scopeGuard, fetchUrl, background processes |
| `src/api/` | ~16 | disk trust/keys/sessions/hooks/MCP/model, approvals (command, edit, staged, question, trust) |
| `src/cli/` (non-TUI) | ~15 | dispatch, config, sink, diff output, colors |
| `src/patch-generation/` | ~7 | patch plan build/classify/render/preview |
| `src/repo/` | ~7 | dependency graph, framework detection, git changes, ranker, repo scan |
| `src/core/decision/` | ~9 | decision explanations, reason codes, recommendations, execution mode |
| `src/core/result/` | ~13 | stage results, parity tests, pipeline tests |
| `src/engine/__tests__/` | ~8 | contradiction detection, patch quality, safety level |
| `src/audit/__tests__/` | 6 | snapshot diff/reader/writer |
| `src/remote/` | 3 | control server, remote adapter, wire frame |
| `src/apply/` | 4 | apply patch plan, decision, render, flow |
| `src/patch/` | ~5 | validate plan, generated plan conversion |
| `src/test/` | ~5 | extension, home writer, guards |
| Others (ast, billing, ci, embeddings, feedback, hooks, mcp, memory, prompts, semantic, snapshots, visual) | ~15 | misc |

---

## §2 — TUI Coverage

### 2.1 Store reducer tests

| File | What it asserts |
|---|---|
| `src/cli/tui/store.test.tsx` | `MODE_CYCLE` transitions (normal→autoAccept→plan→normal), guard when modal/approval open; `TRANSCRIPT_CLEAR`; `TRANSCRIPT_REMOUNT` (bumps generation, preserves transcript); `TODOS_SET` / `TODO_STATUS_SET` (set, update, in_progress back-fill, empty noop, reset on USER_PROMPT/SESSION_RESUME/TRANSCRIPT_CLEAR); run duration stability across mid-run SPINNER_START |
| `src/cli/tui/store-core.ts` (tested via store.test.tsx) | Reducer pure functions, action types |

### 2.2 Event-to-actions tests

| File | What it asserts |
|---|---|
| `src/cli/tui/hooks/eventToActions.planReady.test.ts` | `plan_ready_for_approval` event → `PLAN_READY_PROPOSED` action with correct proposal shape |
| `src/cli/tui/hooks/useAgentEvents.compaction.test.ts` | `compaction_status` / `compaction_overflow_warning` → `SPINNER_RESUME` + `TOAST_PUSH(warning)` |
| `src/cli/tui/hooks/useAgentEvents.editApproval.test.ts` | `edit_approval_requested` → `PENDING_APPROVAL_PROPOSED` with `kind: "edit"` |
| `src/cli/tui/hooks/useAgentEvents.planGen.test.ts` | `plan_generation_started` → `SPINNER_START` with plan-generation label |
| `src/cli/tui/hooks/useAgentEvents.staged.test.ts` | `staged_diffs_ready` → `STAGED_DIFFS_PROPOSED` |
| `src/cli/tui/hooks/useAgentEvents.streamingAnswer.test.ts` | `streaming_answer_delta` → `STREAMING_ANSWER_SET`; `agent_loop_complete` → `STREAMING_ANSWER_CLEAR` |
| `src/cli/tui/hooks/useAgentEvents.todos.test.ts` | `todos_initialized` / `todo_revised` → `TODOS_SET`; `todo_status_changed` → `TODO_STATUS_SET`; noop when `todoId` absent |

### 2.3 Component tests (ink-testing-library)

| File | What it asserts |
|---|---|
| `src/cli/tui/components/Composer.test.tsx` | Slash-command palette filtering/selection, `@`-file completion, buffer submit, history navigation, paste sentinel expansion, `cleanPastedInput` normalization, PUA stripping, disabled-during-run guard |
| `src/cli/tui/components/Transcript.test.tsx` | (via `transcript.test.tsx`) Entry rendering for all 6 kinds (narration, thinking, tool_call, tool_call_group, error, user_prompt, assistant_final, post_execute_diffs, plan_ready); Static width at multiple column widths (60/80/100/120); no ghost rows; no mid-token clipping; TUI.10.H.1 narration squeeze regression; Yoga flex-shrink guard |
| `src/cli/tui/components/ToolCall.test.tsx` | Status glyph rendering (success/failure/blocked), arg formatting, diff display, metadata line |
| `src/cli/tui/components/ToolCallGroup.test.tsx` | Collapsed count header, detail lines, italic for search_in_files/find_references |
| `src/cli/tui/components/PlanPanel.test.tsx` | Todo glyph/color per status, renders all texts, empty todos renders nothing |
| `src/cli/tui/components/Spinner.test.tsx` | Frame cycling, null when inactive, label rendering |
| `src/cli/tui/components/StatusBar.test.tsx` | Left text per run state, mode pill, right hint, token budget color |
| `src/cli/tui/components/DiffView.test.tsx` | FIND/REPLACE parsing, ± rendering, maxLines cap, remaining count |
| `src/cli/tui/components/PlanBody.test.tsx` | Plan objective/steps/scopeNotes rendering |
| `src/cli/tui/components/PlanActionPrompt.test.tsx` | 4-action footer rendering, keyboard dispatch |
| `src/cli/tui/components/StagedDiffModal.test.tsx` | Multi-file diff rendering, approve/reject dispatch |
| `src/cli/tui/components/ApiKeysView.test.tsx` | Key list rendering, navigation |
| `src/cli/tui/components/ModelModal.custom.test.tsx` | Custom model input, provider selection |
| `src/cli/tui/components/ModelModal.retention.test.tsx` | Model choice persistence to disk |
| `src/cli/tui/components/FeedbackModal.test.tsx` | Feedback submission, error handling |
| `src/cli/tui/components/UndoModal.test.tsx` | Undo confirmation dispatch |
| `src/cli/tui/components/toolCallFormat.test.ts` | Display name mapping, arg truncation, preview formatting, metadata |

### 2.4 Integration tests

| File | What it asserts |
|---|---|
| `src/cli/tui/composer.test.tsx` | Full Composer interaction flow (typing, palette, submit) |
| `src/cli/tui/transcript.test.tsx` | Multi-width rendering, ghost-row prevention, Static integrity |
| `src/cli/tui/composer.layout.test.tsx` | Layout positioning, TUI.10 width-squeeze regression |
| `src/cli/tui/runDuration.test.tsx` | Run timing stability across subagent SPINNER_START |
| `src/cli/tui/questionRoundTrip.test.tsx` | Question → answer → dispatch round-trip |
| `src/cli/tui/index.resume.test.ts` | Session resume flow, envelope reconstruction |
| `src/cli/tui/spinnerLabelSequence.test.ts` | Spinner label transitions through run lifecycle events |
| `src/cli/tui/approvals.noRevision.test.ts` | Approval flow without scope revision |
| `src/cli/tui/resize.test.ts` | `shouldRedrawOnResize` (any column change → true), `applyResizeRedraw` (clear + remount order), scrollback-clear escape sequence |

### 2.5 TUI component test coverage (verified)

Components are categorized by the depth of their test coverage. A component may lack a dedicated `.test.tsx` file but still be tested indirectly through store, transcript, or integration tests.

**Dedicated test file exists (4):**

| Component | Test file | Coverage |
|---|---|---|
| `ApprovalModal.tsx` | `src/cli/tui/approvalModal.test.tsx` | Trust prefix via T key |
| `MarkdownText.tsx` | `src/cli/tui/MarkdownText.test.tsx` | TUI.10.C — bold, code, headings, bullets |
| `ErrorBoundary.tsx` | `src/cli/tui/foundation.test.tsx` | Catches throw, calls onCrash |
| `CommandTail.tsx` | `src/cli/tui/CommandTail.test.tsx` | TUI.10.J + TUI.10.J.1 — tail lines, exit status, success/fail rendering |

**Tested indirectly via transcript/store/integration tests (8):**

| Component | Where tested | What's covered |
|---|---|---|
| `Toast.tsx` | `transcript.test.tsx`, `useAgentEvents.compaction.test.ts`, `Composer.test.tsx`, `FeedbackModal.test.tsx`, `UndoModal.test.tsx`, `ModelModal.custom.test.tsx` | TOAST_PUSH/TOAST_POP actions, level-color mapping in context; auto-dismiss timer not directly tested |
| `ErrorLine.tsx` | `transcript.test.tsx` (3 tests) | `patch_rejected` renders ErrorLine, `scope_revision_proposed` shows ErrorLine, ⚠ prefix verified |
| `SessionsModal.tsx` | `store.test.tsx` | SESSIONS_OPEN deduplication reducer |
| `CommitModal.tsx` | `src/cli/tui/commitModal.test.ts` | `executeCommit` function, COMMIT_MODAL_OPEN/CLOSE reducer |
| `MetricsModal.tsx` | `store.test.tsx` | METRICS_MODAL_OPEN/CLOSE reducer |
| `LimitsModal.tsx` | `store.test.tsx` | LIMITS_MODAL_OPEN/CLOSE/APPLY reducer |
| `PlanModeModal.tsx` | `src/cli/tui/store.planmode.test.tsx` | PLANMODE_MODAL_OPEN/CLOSE, mode-cycle guard |
| `PlanModal.tsx` | `store.test.tsx` | PLAN_PROPOSED/PLAN_RESOLVED reducer |

**No behavioral test — only theme/inventory coverage (8):**

These components are listed in `themeCoverage.test.ts` and/or `theme.test.ts` (which assert every component file is accounted for in the theme system) but have **no behavioral test** of their rendering, keyboard handling, or dispatch logic:

`TrustModal.tsx`, `HookTrustModal.tsx`, `McpTrustModal.tsx`, `PermissionsView.tsx`, `EffortModal.tsx`, `SummaryModal.tsx`, `SessionMemoryModal.tsx`, `DimLine.tsx`

**Summary:** 8 of 36 component files lack any behavioral test. 8 more have store-action or indirect tests but no component-level render test. 4 have dedicated component tests. The remaining 16 are covered through the test files listed in §2.2–§2.4.

---

## §3 — Fixtures & Mocks

### 3.1 TUI test harness

**`src/cli/tui/__fixtures__/staticHarness.tsx`** — the single TUI fixture file. Exports:

- **`renderTranscript(entries)`** — renders `<Transcript>` inside `<StoreProvider>` via `ink-testing-library`'s `render()`. Returns `HarnessInstance` with `anyFrameContains(text)`, `lastFrame()`, `unmount()`. Hardcoded at `ink-testing-library`'s default 100 columns.
- **`renderTranscriptAt(entries, columns, seedStreamingAnswer?)`** — renders `<Transcript>` via Ink's native `render()` with a mock `stdout` (EventEmitter + `columns`/`rows` + `write` capture). Collects all frames. Used for **multi-width testing** (60/80/100/120) to catch squeeze/clip bugs.

**Gap:** No `renderAppAt()` harness exists — full-App testing (with modals, Composer, StatusBar) at custom widths is not available. Only `<Transcript>` is testable through the harness.

### 3.2 LLM response mocking

The dominant mocking pattern across `src/llm/*.test.ts`:

```typescript
// vi.mock for the LLM client factory
vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

// Per-test response shaping
function makeDoneResponse() {
  return {
    choices: [{ message: { content: "done", tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}
mocks.createChatCompletion.mockResolvedValue(makeDoneResponse());
```

**No recorded/replayed LLM response fixtures exist.** All LLM responses are hand-crafted inline per test. There is no golden-file pattern, no recorded API response directory, no VCR-style replay mechanism.

### 3.3 Tool executor mocking

**`src/test/fixtures/toolExecutorMock.ts`** — provides `resetToolExecutorMock()` for the `vi.mock("../tools/toolExecutor.js")` pattern. Used extensively in `agentLoop` tests to stub `executeTool`, `withStagingTempFlush`, cache-clearing functions, and command fingerprinting.

### 3.4 Usage/cost mocking

```typescript
vi.mock("../usage/usageTracker.js", () => ({
  getUsage: mocks.getUsage,
  recordExecution: vi.fn(),
  readRecords: vi.fn(() => []),
  recordRunSummary: vi.fn(async () => undefined),
}));
```

### 3.5 Event-stream fixture format

**No event-stream fixture format exists.** `ZoneStructuredProgressEvent` is the typed event shape (`agentLifecycleEvents.ts`), but no test harness creates or replays sequences of these events. The TUI tests use `bus.on` patterns in `useAgentEvents` tests with hand-crafted event objects:

```typescript
// useAgentEvents.todos.test.ts
const evt = { type: "todos_initialized", todos: [TODO_ITEM] } as unknown as ZoneStructuredProgressEvent;
handleTodosInitialized(evt, dispatch);
```

**Reusable for golden replay:** The `ZoneStructuredProgressEvent` union type and the `EventBus` interface could support a JSONL fixture format (one event per line, replayed into `bus.emit()`). No such fixtures exist today.

### 3.6 Home/filesystem guards

- **`src/test/setup/globalHome.ts`** — creates a PID-suffixed temp dir, redirects `$HOME`/`$USERPROFILE`, inventories real `~/.zone` and repo tree at setup, diffs at teardown to detect writes outside allowed dirs.
- **`src/test/setup/homeGuard.ts`** — wraps `fs.writeFileSync`, `fs.appendFileSync`, `fs.mkdirSync`, `fs.renameSync`, `fs.unlinkSync`, `fs.rmSync`, `fs.rmdirSync`, `fs.copyFileSync`, `fs.createWriteStream` (sync) and async equivalents. Throws if any write targets real `~/.zone` or the repo tree outside `["node_modules", ".git"]`.
- **`src/test/testHome.ts`** — exports `zoneTestHome()`, `realUserHome()`, `realZoneDir()`, `REPO_GUARD_ALLOWED_DIRS`.

---

## §4 — Runtime Profile

### 4.1 Wall time

Not measured directly in this read-only audit. Indicators:

- **5,875 test cases** across **504 files** in a single vitest project
- **`testTimeout: 15000`** (15s per test) — generous, suggests some tests are slow (LLM adapter tests with mock async chains)
- **No parallelization config** — vitest runs tests in worker threads by default (file-level parallelism), but no `pool`, `poolOptions`, or `maxConcurrency` is configured
- **No sharding** — single `vitest run` invocation in CI

**Estimated full suite:** 2–5 minutes based on case count and timeout profile. The `src/llm/` module (~90+ files) is likely the slowest segment due to agentLoop integration tests.

**TUI subset:** ~40+ files, likely 30–90 seconds. Ink component tests are fast (synchronous render/assert). The integration tests (resume, question round-trip) may be slower.

### 4.2 Excluded test

`src/llm/taskClassifier.archetype.test.ts` is excluded from the main suite and has its own script: `npm run test:l3` → `vitest run src/llm/taskClassifier.archetype.test.ts`. This suggests it is either slow, flaky, or requires special environment.

### 4.3 Parallelization / sharding

**None configured.** Vitest's default file-level parallelism applies (worker threads per file), but no explicit `pool`, `poolOptions.threads.maxThreads`, `sequence.concurrent`, or CI sharding matrix exists. The CI runs a single `npm test` step on `ubuntu-latest`.

---

## §5 — CI Gates

### 5.1 Pipeline

**`.github/workflows/tests.yml`** — single workflow, single job:

```
on: pull_request, push (master)
concurrency: group per ref, cancel-in-progress

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      1. actions/checkout@v4
      2. actions/setup-node@v4 (node 22, npm cache)
      3. npm ci
      4. npm run typecheck          ← tsc --noEmit
      5. npm run build              ← compile to dist/
      6. npm run typecheck:scripts  ← typecheck scripts/ separately
      7. sudo apt-get install ripgrep  ← runtime dependency
      8. npm test                   ← vitest run
```

### 5.2 Required checks before merge

The workflow defines one job (`test`) that runs all gates sequentially. All must pass:

| Gate | Command | Fails on |
|---|---|---|
| **Install** | `npm ci` | lockfile drift, missing deps |
| **Type check** | `npm run typecheck` | any TypeScript error |
| **Build** | `npm run build` | compilation failure |
| **Script type check** | `npm run typecheck:scripts` | TypeScript errors in `scripts/` |
| **Tests** | `npm test` | any failing test |

**No lint step** in CI. No ESLint, Biome, or Prettier check. No formatting gate.

**No coverage threshold** — coverage is configured (`v8` provider, `text`+`html` reporters) but no minimum coverage percentage is enforced.

### 5.3 Known-skipped tests (18 total)

| File | Skipped tests | Reason |
|---|---|---|
| `src/visual/tierSettings.test.ts` | 3 (`it.skip`) | Clamping/flooring behavior not yet implemented |
| `src/llm/priorRunSummary.test.ts` | 2 (`it.skip`) | Server-side persistence path not yet wired |
| `src/core/runLlmPatchFlow.test.ts` | 7 (`it.skip`) | Generic scaffold overwrite rejection, document skeleton rejection, broad rewrite rejection, constrained fallback recovery, form structure blocking, tier-3 fallback, top-ranked entity target — all deferred verification scenarios |
| `src/core/conversationFilesystemStore.test.ts` | 1 (`it.skip`) | `logRun` → `persistAgentSummaryToFilesystem` ordering vs Supabase |
| `src/core/__tests__/multiFilePatch.test.ts` | 3 (`it.skip`) | Multi-file atomic apply, non-atomic partial success, hosted rollback |
| `src/core/__tests__/applyDeveloperPatchLocalized.test.ts` | 1 (`it.skip`) | Raw match count 0 blocking with LF normalization |
| `src/tools/toolExecutor.pathBoundary.test.ts` | 1 (`it.skipIf(isRoot())`) | Root user bypasses path permission checks |

### 5.4 Known-flaky markers

**None found.** No `flaky`, `retry`, `unstable`, or `intermittent` markers exist in test files or CI config. The 18 skipped tests are intentionally deferred, not flaky.

### 5.5 Missing CI gates

- **No lint gate** — no ESLint/Biome in the pipeline
- **No coverage threshold** — coverage is collected but not enforced
- **No matrix testing** — single Node 22 on ubuntu-latest; no macOS/Windows, no Node 18/20
- **No E2E/integration tests** — no TUI interaction tests that mount the full `<App>` with a real event bus
- **No performance regression tests** — no benchmarks or timing assertions

---

## §6 — Top 10 Untested TUI Behaviors (by risk, verified)

Each item below was confirmed by grep across all `*.test.ts` and `*.test.tsx` files in `src/`.

### 1. TrustModal / HookTrustModal / McpTrustModal — no behavioral tests

**Risk: High.** Trust-decision flows (project trust, hook trust, MCP trust) are security-sensitive. The approve/deny dispatches, the dynamic `import()` chains in `App.tsx`, and the hash-recording side effects are untested. A regression in any trust modal could silently approve or permanently block server/hook/project connections.

**Evidence:** `TrustModal.tsx`, `HookTrustModal.tsx`, `McpTrustModal.tsx` — grep for each component name in `*.test.*` returns only `themeCoverage.test.ts` (file inventory, not behavioral).

### 2. Full-App modal overlay — no harness

**Risk: High.** No test verifies that modals overlay correctly (Composer hidden, StatusBar visible, input blocked). The `renderTranscriptAt` harness only covers `<Transcript>`, not the full App tree with modals. A modal stacking bug (e.g., toast + approval + plan simultaneously) would be invisible.

**Evidence:** `src/cli/tui/__fixtures__/staticHarness.tsx` — only exports `renderTranscript` and `renderTranscriptAt`. No `renderAppAt` exists. Confirmed by reading the file.

### 3. Toast auto-dismiss timer — not directly tested

**Risk: Medium-High.** Toast actions (TOAST_PUSH/TOAST_POP) and level-color mapping are tested indirectly via `transcript.test.tsx`, `useAgentEvents.compaction.test.ts`, `Composer.test.tsx`, `FeedbackModal.test.tsx`, `UndoModal.test.tsx`, and `ModelModal.custom.test.tsx`. However, the **2000ms auto-dismiss timer** in `Toast.tsx:14-18` itself is never tested — a timer leak or premature dismissal would be invisible.

**Evidence:** `src/cli/tui/components/Toast.tsx` — no dedicated test file. Indirect tests verify the store actions but not the component's `setTimeout`/`clearTimeout` lifecycle.

### 4. Subagent events in TUI — no listener, no test

**Risk: Medium.** `subagent_started` and `subagent_completed` events reach the event bus but have no `bus.on` listener in `useAgentEvents.ts`. No test asserts their presence or absence. If a listener were added, no test would verify the store dispatch.

**Evidence:** `src/cli/tui/hooks/useAgentEvents.ts` — grep for `subagent` returns zero matches. `eventToActions.ts` — grep for `subagent` returns zero matches. Confirmed.

### 5. PermissionsView — no behavioral test

**Risk: Medium.** The permissions list view (trusted command prefixes, delete-key removal, navigation) is security-sensitive but has no behavioral test. The store action `PERMISSIONS_OPEN` is not tested in `store.test.tsx` either.

**Evidence:** `PermissionsView.tsx` — grep returns only `themeCoverage.test.ts`.

### 6. EffortModal / SummaryModal / SessionMemoryModal — no behavioral tests

**Risk: Medium.** Settings modals that persist user preferences to disk (`saveDiskModel`) have no tests. A regression in the apply dispatch could silently lose user settings.

**Evidence:** `EffortModal.tsx`, `SummaryModal.tsx`, `SessionMemoryModal.tsx` — grep returns only `themeCoverage.test.ts` and `theme.test.ts` (file inventory).

### 7. Resize + transcript remount integration — partially tested

**Risk: Medium.** `resize.test.ts` tests the pure decision function (`shouldRedrawOnResize`) and the clear+remount pairing (`applyResizeRedraw`), but no integration test verifies the full flow: `stdout.emit("resize")` → debounced handler → `CLEAR_SCREEN_AND_SCROLLBACK` → `TRANSCRIPT_REMOUNT` → clean re-render. The wiring in `index.tsx:1415-1433` is untested.

**Evidence:** `src/cli/tui/resize.test.ts` — tests pure functions in isolation; no integration test.

### 8. ApprovalModal render — limited test coverage

**Risk: Medium.** `approvalModal.test.tsx` tests the trust-prefix (T key) path, but the Y/N keyboard handling, the `kind: "edit"` vs `kind: "command"` rendering difference, and the MCP `kind: "mcp"` path are not tested at the component level. The edit-approval dispatch flow is tested in `useAgentEvents.editApproval.test.ts` but not through the modal component.

**Evidence:** `src/cli/tui/approvalModal.test.tsx` — tests trust prefix only. `useAgentEvents.editApproval.test.ts` — tests the event-to-action path, not the modal render.

### 9. Composer paste chip inspection — no test

**Risk: Low-Medium.** Large pastes become opaque `[Pasted text #N +X lines]` sentinels. `Composer.test.tsx` covers paste sentinel expansion in `submitBuffer` but no test verifies chip expansion on submit, sentinel stripping, or the interaction between paste chips and `@`-file completion.

**Evidence:** `Composer.test.tsx` — covers sentinel expansion; does not test multi-chip or chip+@-palette interaction.

### 10. DimLine — no test at all

**Risk: Low.** `DimLine.tsx` is a simple utility component with zero test references anywhere in the codebase. If unused, it should be removed; if used, it should be tested.

**Evidence:** `DimLine.tsx` — grep for `DimLine` across all `*.test.*` returns zero matches.
