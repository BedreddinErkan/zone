# UX Debt Review — Read-Only Audit

**Date:** 2026-09-09 · **Scope:** `src/cli/tui/`, `src/cli/`, `DESIGN-*.md` · **Method:** read-only code trace

---

## §1 — TODO/FIXME/HACK Comments in `src/` Related to UI/Rendering

**Result: near-zero markers.** The TUI code under `src/cli/tui/` contains **no** actual `// TODO`, `// FIXME`, or `// HACK` comment markers. The broader `src/` tree has only 10 `// TODO` markers total, and **none** relate to UI/rendering:

| File | Line | Comment | UI-related? |
|---|---|---|---|
| `src/usage/pricing.ts` | 54 | `// TODO: confirm Sonnet 5 pricing` | No |
| `src/tools/toolExecutor.ts` | 1043 | `// TODO(PR 5+): relax this once subagent write-set prediction…` | No |
| `src/tools/toolExecutor.ts` | 1479 | `// TODO Q.5b: surface tests_failed_unrelated tag…` | No |
| `src/tools/fetchUrl.ts` | 204 | `// TODO(ssrf-v2): DNS-pinning — connect to resolved IP directly…` | No |
| `src/repo/buildDependencyGraph.test.ts` | 98, 113 | Test fixture strings (not real TODOs) | No |
| `src/core/validateLlmOutput.test.ts` | 83 | Test fixture string | No |
| `src/tools/toolExecutor.ts` | 217, 224, 230 | TodoWrite tool references (the word "Todo", not a marker) | No |

**Zero `// FIXME` or `// HACK` markers exist anywhere in `src/`.**

**Interpretation:** The codebase is unusually disciplined about marker hygiene. UX debt is carried in DESIGN docs and architectural decisions rather than inline markers. This makes the debt harder to discover — it lives in the gap between what the DESIGN docs propose and what was shipped.

---

## §2 — DESIGN-*.md Summaries: Intent, Status, Drift

### 2.1 `DESIGN-tui9-layout.md` — Static/dynamic region restructure

| Aspect | Detail |
|---|---|
| **Intent** | Consolidate the TUI render tree into three explicit zones: `TranscriptStatic` (Static-only completed items), `ActiveOutput` (consolidated live region), `OverlayLayer` (single modal selector). Add `selectIsBlockingModalOpen` selector to centralize the "is a modal open" boolean currently computed inline at 3+ sites. |
| **Status** | **Partial.** Stages 0–1 partially done (stdout interception exists in `stdoutShield.ts`; `Spinner` is a separate component). Stages 2–4 **not started**: no `OverlayLayer`, no `selectIsBlockingModalOpen`, no `ActiveOutput`, no `useAnimationGate`. |
| **Drift** | The `modals` fragment in `App.tsx:186-241` is still an inline `<>` fragment with 17 conditional entries — exactly what the design proposed extracting. The "is a modal open" boolean is still computed at 3+ sites (`App.tsx:176`, `Composer.tsx:~420`, each modal's own gate). `Spinner` is still a standalone App sibling rather than being co-located with the in-flight slot. The animation gate (§Part 3) is entirely unbuilt. |

### 2.2 `DESIGN-tui-resize-fix.md` — Ghost-row multiply on resize

| Aspect | Detail |
|---|---|
| **Intent** | Fix the narrowing-resize ghost-row bug where the live chrome leaves accumulating visual artifacts. Proposed debounced narrowing-gated clear+remount. |
| **Status** | **Implemented.** `resize.ts` has `shouldRedrawOnResize` (now fires on *any* column change, not just narrowing — improved from the design's narrowing-only recommendation). `CLEAR_SCREEN_AND_SCROLLBACK` uses `[2J[3J[H`. `TRANSCRIPT_REMOUNT` action exists in store-core. Wired in `index.tsx:1415-1433`. |
| **Drift** | The implementation went **broader** than the design: fires on widening too (documented in `resize.ts`'s own comment — "widening only *looked* self-correcting"). This is a positive drift. The design's `[3J` vs `[2J` open decision was resolved: `[3J` (drops scrollback). |

### 2.3 `DESIGN-todowrite-tui.md` — Visible task plan + progress

| Aspect | Detail |
|---|---|
| **Intent** | Port the already-shipped TodoWrite events to the TUI. Design proposed "frozen snapshots in `<Static>` + one-line live cursor (`PlanCursor`)" to avoid ghost-row issues. |
| **Status** | **Partially implemented, diverged from design.** The event wiring is done (`useAgentEvents.ts` subscribes to all 3 todo events, store has `TODOS_SET`/`TODO_STATUS_SET`, `todos` state slice exists). But the rendering diverged: instead of `PlanSnapshot` (Static) + `PlanCursor` (one-line live), a `PlanPanel` component renders the **entire todo list as a live region** — the exact pattern the design warned against ("tall live panel ghosts/multiplies on resize"). |
| **Drift** | `PlanPanel.tsx` renders all todos in a `<Box flexDirection="column">` outside `<Static>`, gated on `state.runState === "running"` (`App.tsx:320-322`). This is a **multi-line mutating live region** — the ghost-row risk the design explicitly called out. The design's `plan_snapshot` TranscriptEntry kind was never created. No `PlanSnapshot.tsx` or `PlanCursor.tsx` exists. |

### 2.4 `DESIGN-tui-session-memory.md` — Cross-submission continuity

| Aspect | Detail |
|---|---|
| **Intent** | Let submission #2 see submission #1's FINAL SUMMARY via opt-in session memory. Phase 1 (single-prior) + Phase 2 (UX: StatusBar pill, `/memory clear`) + Phase 3 (cumulative). |
| **Status** | **Phase 1 implemented.** `priorSessionSummary` threads through `runLlmPatchFlow`, `agentLoop`, disk model settings. `memoryEnabled` toggle exists. Session memory is injected under neutral `SESSION MEMORY` header at `agentLoop.ts:3505-3509`. `/memory` slash command exists. |
| **Drift** | Phase 2 StatusBar pill: **not found** — no `🧠 memory` indicator in `StatusBar.tsx`. `/memory clear` (new sessionId): **not verified** — the `/session` command toggles on/off but the clear semantics described in §2.7 are unclear. Phase 3 cumulative: **not started**. |

### 2.5 `DESIGN-plan-mode-redesign.md` — Plan mode cost fix + feedback loop

| Aspect | Detail |
|---|---|
| **Intent** | Kill the ~$0.22 forced audit in plan mode. Collapse plan-gen + investigate + judge into one read-only investigation. Add 5-action approval set including feedback→revise loop. |
| **Status** | **Phase 1 partially done.** The cheap `ZONE_PLAN_APPROVAL_CYCLE=1` path exists with `planApprovals.ts` + `PlanReadyModal`. The dispatch loop exists. But `refine`/`feedback` are **stubs** (`continue` at `dispatch.ts:106-109`). `approve_with_feedback` was never added. The expensive forced-audit path is still the **default** (env var XOR still present). |
| **Drift** | The design's §2.10 "cost fix first" was not completed — the forced audit is still the default. Phase 2 (investigation-produces-plan) is not started. The `manual` decision still doesn't gate edits (§1.5's "manual does not gate edits" bug persists). `PlanModal` still doesn't render `unnecessaryFiles`. `SESSION_RESUME` nulls `planReadyProposal` but not `planProposal` (the orphaned-modal bug, §1.5). |

### 2.6 `DESIGN-multi-turn-memory.md` — Thread-level continuity

| Aspect | Detail |
|---|---|
| **Intent** | Move from single-prior session memory to full multi-turn thread: persist user prompts, replay recent turns, enable course-correction across many submissions. |
| **Status** | **Not started.** This is a design proposal that builds on session-memory's primitives. The "writer gap" it identifies (user prompts not persisted to FS store) is still present. |
| **Drift** | N/A — no implementation to drift from. |

### 2.7 `DESIGN-git-capabilities.md` — Read-awareness + /commit

| Aspect | Detail |
|---|---|
| **Intent** | (1) Agent proactively reads git for recent-change context; (2) first-class `/commit` command. |
| **Status** | **Partially implemented.** `/commit` exists as a slash command + `CommitModal` component. Git reads via `run_command_readonly` are frictionless for safe subcommands. |
| **Drift** | The "prompt guidance directing the agent to consult git" (§Part 2) is unclear from this audit — the agent system prompt's git mention appears limited. `blame`/`remote`/`rev-parse` are still not in the auto-approve list. |

### 2.8 `DESIGN-user-slash-commands.md` — Project-specific commands

| Aspect | Detail |
|---|---|
| **Intent** | `.zone/commands/*.md` files become custom slash commands whose body is injected as the task prompt. |
| **Status** | **Implemented.** `loadUserCommands` exists, `userCommands` store slice exists, `executeSlashCommand` dispatches project commands via `onSubmit`. Palette merges project commands with built-ins. |
| **Drift** | The §H.1 open decision about `.zone/` being gitignored (commands not shareable via repo) is unresolved — `.gitignore` still excludes `.zone/`. |

### 2.9 `DESIGN-web-search.md` — Provider-native web search

| Aspect | Detail |
|---|---|
| **Intent** | Anthropic-native server-side web search, session-toggled, directive-gated, `max_uses`-capped. |
| **Status** | **Implemented with self-correction.** The document itself carries a prominent CORRECTION section noting that `fetch_url` (a client-side tool) was built after this design, closing the §3.1 argument. Web search toggle (`/websearch`) exists. `fetch_url` ships with SSRF protections. |
| **Drift** | The design rejected self-hosted fetch; `fetch_url` was built anyway. The correction acknowledges this and documents the gap (no domain allowlist, known TOCTOU, no content-type filtering). |

---

## §3 — Top 10 UX Weaknesses Ranked by User Impact

### 1. PlanPanel renders as a multi-line live region → ghost rows on resize

**Impact: High** — Visible visual corruption during every resize while a plan is active.

**Evidence:** `App.tsx:320-322` renders `<PlanPanel todos={state.todos} />` outside `<Static>`, as a direct App child. `PlanPanel.tsx:16-30` renders one `<Box>` per todo in a flex column — a multi-line mutating live region. `DESIGN-todowrite-tui.md` §C.2 explicitly warns: "A naive 'live sidebar panel' is a **tall mutating live region** → the exact ghost-row footgun."

**Smallest fix:** Cap PlanPanel to one line (show only the `in_progress` step + counter, like the design's `PlanCursor`):
```tsx
// PlanPanel.tsx — show only in_progress item
const active = todos.find(t => t.status === "in_progress");
if (!active) return null;
return <Box><Text>▶ {todos.filter(t=>t.status==="completed").length}/{todos.length} · {active.text}</Text></Box>;
```

**Proper fix:** Implement the design's two-part render: `PlanSnapshot` (full checklist, committed to `<Static>` on init/revise/complete) + `PlanCursor` (one-line live element above Composer). This preserves the full plan view in scrollback while keeping the live region to one line.

---

### 2. Shift+Tab mode cycling is undocumented in /help

**Impact: High** — Users can't discover plan mode or auto-accept mode, the two most powerful workflow features.

**Evidence:** `Composer.tsx:72-82` — `HELP_LINES` lists key bindings but has no entry for Shift+Tab. `App.tsx:174-176` implements the cycle but the only way to learn about it is reading source code or stumbling onto it. The `DESIGN-plan-mode-redesign.md` §2.7 explicitly calls this out: "Clear UX debt: document Shift+Tab in `/help`."

**Smallest fix:** Add two lines to `HELP_LINES` in `Composer.tsx`:
```ts
"  Shift+Tab   cycle mode (normal → auto-accept → plan)",
```

**Proper fix:** Add a persistent mode indicator visible in all states (not just the StatusBar pill that only appears in non-normal modes), and a `/plan` slash command as an alternative entry point.

---

### 3. Plan mode: forced-audit default costs ~$0.22 on small tasks

**Impact: High** — Users pay 4× the expected cost for small planning tasks with no opt-out.

**Evidence:** `dispatch.ts:85` — `ZONE_PLAN_APPROVAL_CYCLE` env var XOR selects between the expensive audit path (default) and the cheap path. The TUI has no way to set this env var. `auditMode.ts:26` — `isLowRiskPlan` returns false when `preClassifiedTask` is null, and dispatch never passes it (`dispatch.ts:123-138`). `DESIGN-plan-mode-redesign.md` §1.2 documents the four-compound cost path.

**Smallest fix:** Default `ZONE_PLAN_APPROVAL_CYCLE` to `"1"` in the TUI entry point, or remove the XOR and always use the cheap path:
```ts
// index.tsx or dispatch.ts
process.env.ZONE_PLAN_APPROVAL_CYCLE ??= "1";
```

**Proper fix:** Implement the design's investigation-produces-plan (§Part 3): one read-only investigation under `withRequestContext` with the user's model, replacing the plan+investigate+judge triple. Wire `feedback`/`approve_with_feedback` decisions in the dispatch loop.

---

### 4. Modals push layout instead of overlaying — Composer/StatusBar jump

**Impact: Medium-High** — Every modal opening shifts the Composer and StatusBar down, causing disorienting layout reflow. Users lose their visual anchor.

**Evidence:** `App.tsx:186-241` — modals are rendered as inline siblings in the flex column, between `<Spinner>` and `<Composer>`. When a modal opens, it inserts bordered content above the Composer, pushing everything down. The design (§Part 2 target architecture) proposes hiding Composer when a blocking modal is open and occupying the dynamic slot instead.

**Smallest fix:** When a blocking modal is open, render it in place of the ActiveOutput region (Spinner + live narration) instead of above the Composer:
```tsx
// App.tsx — conditionally replace live region with modal
{isBlocking ? <OverlayLayer /> : <><Spinner />{/* live stuff */}</>}
```

**Proper fix:** Implement `OverlayLayer` + `selectIsBlockingModalOpen` selector as designed in `DESIGN-tui9-layout.md` §Part 2. Centralize the modal-open boolean. Hide Composer/ActiveOutput while a blocking modal is open; keep StatusBar always visible.

---

### 5. MarkdownText renderer is minimal — no links, lists, or code blocks

**Impact: Medium** — The agent's final answer (the most-read output) renders with poor fidelity. Links are invisible, nested lists flatten, code blocks lose formatting.

**Evidence:** `MarkdownText.tsx:17-38` — `renderInline` handles only `**bold**` and `` `code` ``. The block-level renderer (`:58-98`) handles `##`/`###` headings, `-`/`*` bullets, and blank lines. No support for: `[links](url)`, numbered lists, code fences (` ``` `), blockquotes, tables, or nested lists. The agent's system prompt generates rich markdown that this renderer silently degrades.

**Smallest fix:** Add code fence support (the most impactful missing feature for a coding tool):
```tsx
// Detect ``` fences and render with dim background
if (line.startsWith("```")) { /* toggle in-code-block state, render monospace */ }
```

**Proper fix:** Use a proper terminal markdown renderer (e.g., `marked-terminal` or a custom Ink-aware renderer) that handles the full CommonMark subset the agent emits, including links, fenced code, tables, and nested lists.

---

### 6. No session memory indicator in the StatusBar

**Impact: Medium** — Users can't tell at a glance whether session memory is on or off, leading to confusion about why the agent does or doesn't remember prior tasks.

**Evidence:** `StatusBar.tsx` renders `webSearch ? " · [W]" : ""` for web search and a mode pill for auto/plan, but has no indicator for `memoryEnabled`. `DESIGN-tui-session-memory.md` §2.7 Phase 2 specifies a `🧠 memory` StatusBar pill — not implemented. The `/session` toggle exists but provides no persistent visual feedback.

**Smallest fix:** Add a pill to StatusBar (mirror the `[W]` pattern):
```tsx
const mem = state.modelSettings?.memoryEnabled;
// In the leftText or badgeLine:
{mem ? " · [M]" : ""}
```

**Proper fix:** StatusBar pill + a `/memory status` subcommand that shows the current sessionId, stored summary size, and last-written run.

---

### 7. Toast messages auto-dismiss after 2s with no way to re-read

**Impact: Medium** — Important warnings (API key errors, validation failures, trust prompts) vanish before the user can read them, especially during active work.

**Evidence:** `Toast.tsx:16-20` — `setTimeout(() => dispatch({ type: "TOAST_POP" }), 2000)`. Only one toast renders at a time (`App.tsx:187` — `toastQueue[0]`). Once popped, the message is gone with no history. A user who glances away misses it entirely.

**Smallest fix:** Increase the timeout to 4–5 seconds and pause the timer while the toast has focus (or while `runState === "awaiting_input"`):
```tsx
const timer = setTimeout(() => dispatch({ type: "TOAST_POP" }),
  state.runState === "awaiting_input" ? 8000 : 4000);
```

**Proper fix:** Render a scrollable toast history accessible via a key binding (e.g., `Ctrl+T`), or commit important toasts (warnings/errors) to the transcript as `narration` entries so they persist in scrollback.

---

### 8. ErrorLine is a single red line — no context, no recovery guidance

**Impact: Medium** — Errors appear as a bare `⚠ <text>` with no structured context. Users see "API rate limit exceeded" with no guidance on what to do next.

**Evidence:** `ErrorLine.tsx:3-5` — renders `<Text color={role.danger}>{glyph.warningMark} {text}</Text>`. No categorization, no recovery action hints, no link to docs. Errors from different sources (API, filesystem, network, validation) all render identically. The error text is whatever string the caller passes — no structured error types.

**Smallest fix:** Add a recovery hint based on error category:
```tsx
// In the caller, or in ErrorLine itself with pattern matching:
const hint = text.includes("rate limit") ? " — wait or switch model" 
           : text.includes("API key") ? " — /keys to configure" 
           : "";
return <Text color={role.danger}>{glyph.warningMark} {text}{hint}</Text>;
```

**Proper fix:** Structured error types with `category`, `recoveryHint`, and optional `action` (a slash command to suggest). Render with consistent formatting: icon + message + dim recovery hint + optional action button.

---

### 9. Plan mode's feedback/refine loop is stubbed — "(stub)" shown to users

**Impact: Medium** — Users see "refine" and "feedback" options in the plan approval modal but they do nothing (the dispatch loop `continue`s without re-planning). The modal footer literally says "(stub)".

**Evidence:** `dispatch.ts:106-109` — `refine` and `feedback` decisions hit `continue`, re-showing the same plan unchanged. `DESIGN-plan-mode-redesign.md` §1.3: "`refine`/`feedback` are stubs in dispatch (`:106-109` `continue`, re-showing the same plan), and the modal footer says '(stub)'." `generateExecutionPlan` already accepts `previousPlan` + `userFeedback` (`executionPlan.ts:87-110`) — the backend exists but isn't wired.

**Smallest fix:** Wire the existing `generateExecutionPlan({ previousPlan, userFeedback })` into the dispatch loop for `feedback` decisions, replacing the `continue` stub. This is ~10 lines of wiring.

**Proper fix:** Full 5-action plan approval with text-input sub-mode in the modal for feedback, `approve_with_feedback` decision, and the cached investigation context reused across re-plan rounds. Per the design's §2.10 phasing.

---

### 10. Orphaned `planProposal` survives session resume

**Impact: Low-Medium** — After `SESSION_RESUME`, an old scope-revision modal can reappear and block input, because `planProposal` is not cleared on resume (only `planReadyProposal` is).

**Evidence:** `store-core.ts:787-819` — `SESSION_RESUME` action sets `planReadyProposal: null` but does **not** null `planProposal`. `App.tsx:228` gates `PlanModal` on `planProposal !== null`. `DESIGN-plan-mode-redesign.md` §1.5 explicitly lists this: "`SESSION_RESUME` nulls `planReadyProposal` but **not** `planProposal`; since `App.tsx:163` gates the modal on `planProposal !== null`, an orphaned scope-revision modal can survive a resume."

**Smallest fix:** Add `planProposal: null` to the `SESSION_RESUME` reducer:
```ts
case "SESSION_RESUME":
  return { ...state, planProposal: null, planReadyProposal: null, /* ...rest */ };
```

**Proper fix:** Fix the reducer + add the `selectIsBlockingModalOpen` selector that checks both fields, so a single source of truth prevents future omissions of this class.

---

## §4 — Fix Summary Matrix

| # | Weakness | Impact | Smallest Fix | Effort | Proper Fix | Effort |
|---|---|---|---|---|---|---|
| 1 | PlanPanel ghost rows | High | Cap to one-line cursor | ~30min | Static snapshots + PlanCursor | 2–3 days |
| 2 | Shift+Tab undocumented | High | Add one HELP_LINES entry | 2min | Mode indicator + /plan command | 1 day |
| 3 | Plan mode forced audit | High | Default env var to "1" | 5min | Investigation-produces-plan | 1–2 weeks |
| 4 | Modals push layout | Med-High | Render modal in live region slot | 1hr | OverlayLayer + selector | 2–3 days |
| 5 | MarkdownText minimal | Medium | Add code fences | 2hr | Full markdown renderer | 3–5 days |
| 6 | No memory indicator | Medium | Add [M] pill to StatusBar | 15min | Pill + /memory status | 1 day |
| 7 | Toast 2s auto-dismiss | Medium | Increase timeout + pause on idle | 30min | Toast history + key binding | 1–2 days |
| 8 | ErrorLine no context | Medium | Pattern-match recovery hints | 1hr | Structured error types | 3–5 days |
| 9 | Plan feedback stubbed | Medium | Wire existing re-plan | 1hr | Full 5-action approval | 3–5 days |
| 10 | Orphaned planProposal | Low-Med | Null in SESSION_RESUME | 5min | Centralized modal selector | 1 day |

**Total smallest-fix effort:** ~1 day of focused work for items 1–3, 6, 10 (the high-impact items).  
**Total proper-fix effort:** 4–8 weeks across all items, with the plan-mode redesign and OverlayLayer being the largest.
