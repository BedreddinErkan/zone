# TARGET-ARCHITECTURE.md — Zone TUI Redesign v2

**Date:** 2026-09-10 · **Scope:** `src/cli/tui/`, `src/cli/`, `src/llm/`, `src/core/` · **Status:** Approved spec, implementation pending

---

## 1 — Executive Summary

This document defines the target architecture for the Zone TUI, based on five read-only investigation reports (01-architecture, 02-ux-audit, 03-debt, 04-test-map, 05-subagent-ux) plus supplemental audits (06-decision-mode, 07-mcp-tools).

The core finding: **the TUI's skeleton is healthy, but its grammar is incomplete.** The codebase enforces zero hard-coded colors (`themeCoverage.test.ts`), maintains a conscious border semantics (round/single/double), and uses a clean `useReducer` + Context pattern. However, 18 modal components (46% of the UI) lack a shared overlay system, keybinding verbs vary across contexts (`y`/`a`/`1-2-3-4`), and the event pipeline has no backpressure.

This redesign applies the **unimplemented portions of `DESIGN-tui9-layout.md`** (OverlayLayer, ActiveOutput, selectIsBlockingModalOpen), standardizes the keybinding grammar, adds a uiScheduler for event flow control, and introduces subagent visibility. The target is Claude Code / Codex / Cursor parity in terminal UX while preserving Zone's cost-efficiency thesis ("unlimited execution for cents").

---

## 2 — Target Component Tree

### 2.1 Three-tier architecture
┌─────────────────────────────────────────────────────────────┐
│ Tier 1: Layout Primitives                                   │
│  OverlayShell, KeyHints, Row, SectionTitle, ListItem,      │
│  IndentedWrap, Panel, StatusBar                            │
├─────────────────────────────────────────────────────────────┤
│ Tier 2: Domain Widgets                                      │
│  Transcript, Composer, Spinner, Toast, PlanPanel,          │
│  QuestionPanel, ToolCall, ToolCallGroup, DiffView,         │
│  MarkdownText, CommandTail, PlanBody, ErrorLine, DimLine   │
├─────────────────────────────────────────────────────────────┤
│ Tier 3: Modal Content (pure, stateless)                     │
│  ModelPicker, ApiKeysManager, MetricsDashboard,            │
│  SessionBrowser, ApprovalPrompt, TrustPrompt,              │
│  PlanApproval, CommitEditor, FeedbackForm, UndoConfirm     │
└─────────────────────────────────────────────────────────────┘
**Rule:** Tier 3 components never render their own border, title, or footer. They receive a `contentSlot` prop and return JSX that `OverlayShell` wraps.

### 2.2 OverlayShell API

```typescript
interface OverlayShellProps {
  title: string;                    // lowercase, mono
  borderStyle: "round" | "single" | "double";
  borderColor: Role;                // theme token
  width: "narrow" | "wide" | "full";
  keyHints: KeyHint[];              // footer
  children: React.ReactNode;        // content slot
  onClose: () => void;              // central Esc handler
}

type KeyHint = { key: string; label: string; primary?: boolean };

// Width tokens (computed at render time):
//   narrow = min(72, cols - 4)
//   wide   = min(110, cols - 4)
//   full   = cols - 2
**Rule:** Tier 3 components never render their own border, title, or footer. They receive a `contentSlot` prop and return JSX that `OverlayShell` wraps.

### 2.2 OverlayShell API

```typescript
interface OverlayShellProps {
  title: string;                    // lowercase, mono
  borderStyle: "round" | "single" | "double";
  borderColor: Role;                // theme token
  width: "narrow" | "wide" | "full";
  keyHints: KeyHint[];              // footer
  children: React.ReactNode;        // content slot
  onClose: () => void;              // central Esc handler
}

type KeyHint = { key: string; label: string; primary?: boolean };

// Width tokens (computed at render time):
//   narrow = min(72, cols - 4)
//   wide   = min(110, cols - 4)
//   full   = cols - 2

Modal migration: All 18 current modals become Tier 3 content + OverlayShell wrapper. Example:
// Before (ModelModal.tsx):
<Box borderStyle="round" borderColor={role.accent} width="70%">
  <Text>Model</Text>
  {list}
  <Text>↑↓ navigate · Enter select · Esc close</Text>
</Box>

// After:
<OverlayShell
  title="/model"
  borderStyle="round"
  borderColor={role.accent}
  width="narrow"
  keyHints={[
    { key: "↑↓", label: "navigate" },
    { key: "Enter", label: "select", primary: true },
    { key: "C", label: "custom" },
    { key: "esc", label: "close" },
  ]}
  onClose={() => dispatch({ type: "MODEL_CLOSE" })}
>
  <ModelList items={models} selected={selected} onSelect={handleSelect} />
</OverlayShell>
selectIsBlockingModalOpen (centralized selector):
const selectIsBlockingModalOpen = (state: StoreState): boolean =>
  state.pendingApproval !== null ||
  state.pendingHookTrust !== null ||
  state.pendingMcpTrust !== null ||
  state.planProposal !== null ||
  state.planReadyProposal !== null ||
  state.stagedDiffProposal !== null ||
  state.modalView !== "none";
  This replaces the 3+ inline boolean computations currently scattered across App.tsx:176, Composer.tsx:~420, and each modal's gate.
3 — State Management
3.1 Central UI store (unchanged)
StoreState + useReducer + Context pattern is preserved. The reducer remains pure; all new actions are added to store-core.ts.
3.2 Interaction registry (replaces 6 scattered Maps)
Current state: 6 module-level Map singletons (commandApprovals, editApprovals, stagedApprovals, questionApprovals, planApprovals, revisionApprovals). Each has its own request*() / resolve*() protocol. A bug in any one registry (e.g., missing cleanup on abort) silently hangs the agent loop.
Target: single interactionRegistry with typed kinds.
type InteractionKind =
  | "command_approval"
  | "edit_approval"
  | "staged_diff"
  | "question"
  | "plan_ready"
  | "plan_revision";

interface InteractionRegistry {
  request<T>(kind: InteractionKind, payload: unknown, abortSignal: AbortSignal): Promise<T>;
  resolve<T>(kind: InteractionKind, id: string, result: T): void;
  abort(kind: InteractionKind, id: string): void;
  abortAll(): void;  // called on session end / process exit
}
Benefits:

    Single source of truth for "is there a pending interaction?"
    Abort cleanup is centralized (no silent hangs)
    Testable: mock the registry, assert request / resolve pairs

3.3 Config-as-state (replaces mutable CliConfig)
Current state: CliConfig object mutated in-place by onModelApply and applyDiskKeyFallbacks. Changes take effect on next run, not the current one. The store's mirror and the authoritative config can diverge.
Target: store is the single source of truth; disk is a persistence effect.
// Actions
type ConfigAction =
  | { type: "CONFIG_PATCHED"; patch: Partial<CliConfig> }
  | { type: "CONFIG_PERSISTED"; path: string };

// Reducer
case "CONFIG_PATCHED":
  return { ...state, config: { ...state.config, ...action.patch } };

// Effect (in index.tsx or a useConfigPersist hook)
useEffect(() => {
  saveDiskConfig(state.config);
  dispatch({ type: "CONFIG_PERSISTED", path: configPath });
}, [state.config]);
Migration: onModelApply callback → dispatch({ type: "CONFIG_PATCHED", patch: { model, provider, effort } }). The TUI reads state.config directly; no more mutable object threading.
4 — Event Pipeline
4.1 Current pipeline (synchronous, no backpressure)
Agent loop → emitStructuredProgress → onProgress callback → bus.emit()
  → useAgentEvents (bus.on) → eventToActions → dispatch() → React reconcile
  Problem: EventEmitter.emit() fires all listeners synchronously. If React dispatch is slow, the agent loop blocks. The only throttle is a 200ms debounce on text events. No queue depth limit.
4.2 Target pipeline (uiScheduler)
Agent loop → emitStructuredProgress → onProgress callback → uiScheduler.enqueue()
  → [bounded ring buffer, 512 slots]
  → flush tick (16-33ms) → eventToActions → dispatch() → React reconcile
  Priority lanes:
Lane
	
Events
	
Flush strategy
Priority
	
approval_requested, question_asked, subagent_started, subagent_completed
	
Immediate flush (bypass buffer)
Coalesce
	
narration_delta, streaming_answer_delta
	
200ms debounce (current behavior preserved)
Batch
	
tool_call, tool_result, todo_status_changed
	
16ms tick, coalesce consecutive same-kind events
Backpressure: If the ring buffer fills, the scheduler drops the oldest non-priority events and emits a [zone-ui-scheduler-overflow] telemetry event. The agent loop is never blocked.
4.3 Transcript lifecycle
Current: state.transcript array grows unbounded during long sessions.
Target: in-memory cap + compact summary.

const TRANSCRIPT_CAP = 500;
const COMPACT_THRESHOLD = 400;

// Reducer
case "TRANSCRIPT_APPEND":
  const newTranscript = [...state.transcript, action.entry];
  if (newTranscript.length > COMPACT_THRESHOLD) {
    const compacted = compactTranscript(newTranscript.slice(0, -100));
    return { ...state, transcript: [compacted, ...newTranscript.slice(-100)] };
  }
  return { ...state, transcript: newTranscript };
  Compact summary: a single TranscriptEntry with kind "compact_summary" that renders as:
  [400 earlier events compacted · 12 tool calls · 3 subagents · $0.0421]
  The full history is preserved on disk (conversationFilesystemStore.ts JSONL), accessible via /sessions.
5 — Gramer Standardization
5.1 Keybinding verb map
Intent
	
Standard key
	
Current variance
	
Migration
Select / confirm (list & form)
	
Enter
	
Consistent
	
No change
Binary approve
	
y
	
y in Approval, a in Hook/McpTrust
	
a → y in HookTrustModal, McpTrustModal
Binary deny
	
n or Esc
	
Consistent
	
No change
Multi-choice gate
	
1..9
	
PlanActionPrompt, StagedDiff
	
Preserved
Close / cancel
	
Esc
	
Each modal handles own Esc
	
Central OverlayShell handler
Mode cycle
	
Shift+Tab
	
Undocumented in /help
	
Add to HELP_LINES
Run abort
	
Ctrl+C; Esc when no modal
	
App.tsx checks Esc precedence
	
Document precedence in /help
5.2 Central Esc handler
OverlayShell registers a global useInput that checks state.overlayStack (an array of overlay IDs). On Esc, it dispatches OVERLAY_POP which closes the top overlay. If the stack is empty, Esc falls through to App.tsx's run-abort logic.
// In OverlayShell.tsx
useInput((input, key) => {
  if (key.escape && isTopOfStack) {
    onClose();
  }
});
5.3 Design tokens (additions to theme.ts)

export const spacing = {
  xs: 0,
  sm: 1,
  md: 2,
  lg: 3,
  xl: 4,
} as const;

export const width = {
  narrow: (cols: number) => Math.min(72, cols - 4),
  wide: (cols: number) => Math.min(110, cols - 4),
  full: (cols: number) => cols - 2,
} as const;

export const role = {
  // ... existing tokens ...
  accent: "#22B3C4",  // unified teal (was "cyan" named color)
  // brand, activity, selectionBackground already #22B3C4
} as const;
 Lint rule: tokenCoverage.test.ts extended to fail if any .tsx file uses numeric padding literals (paddingX={1}) or hard-coded width values. All layout must reference spacing.* or width.*.
6 — Subagent Visibility
6.1 Current state (flat transcript)
Subagent tool calls are indistinguishable from parent calls. subagent_started / subagent_completed events are emitted but dropped by useAgentEvents.ts (no listener). The user sees a flat stream of tool calls with no nesting, no cost breakdown, no progress indication.
6.2 Target state (nested task model)
Event listeners added to useAgentEvents.ts:
bus.on("subagent_started", (evt) => {
  dispatch({
    type: "SUBAGENT_STARTED",
    subagentId: evt.subagentId,
    subagentType: evt.subagentType,
    title: evt.title,
  });
});

bus.on("subagent_completed", (evt) => {
  dispatch({
    type: "SUBAGENT_COMPLETED",
    subagentId: evt.subagentId,
    status: evt.subagentStatus,
    summary: evt.summary,
    costUsd: evt.costUsd,
    iterations: evt.iterations,
  });
});
Transcript rendering:
▶ Task(Explore the auth module for vulnerabilities)
  ┌─ worker · 4 iters · $0.0023 ──────────────────────────────┐
  │  ▶ read_file(src/auth/login.ts)                          │
  │  ● search_in_files(src/, "validateToken")                │
  │  ▶ write_file(src/auth/login.ts)                         │
  └───────────────────────────────────────────────────────────┘
  └ Summary: Found 3 issues, fixed 2, 1 requires manual review
  Spinner label update:
  case "SUBAGENT_STARTED":
  return {
    ...state,
    spinner: {
      ...state.spinner,
      label: `↳ ${evt.subagentType} · ${evt.title}`,
    },
  };
  Approval context: When a subagent's command needs approval, the modal shows:
  ┌─ Command approval required ─────────────────────┐
│  ↳ worker requests:                             │
│  $ npm test                                      │
│                                                   │
│  [Y]es  [N]o  [T]rust prefix                     │
└───────────────────────────────────────────────────┘

structured resume.
7 — Migration Constraints
7.1 Branch strategy
All work happens on feat/tui-redesign branch. Master is untouched until all phases pass gate.
Commit 0: Investigation docs (01-07) + this TARGET-ARCHITECTURE.md + PHASE-PLAN.md.
7.2 Test gates
Each phase must pass:

    Existing suite: npm test (5875 cases, all green)
    Golden harness: New replay tests for the phase's scope
    Manual smoke: Representative run transcript reviewed by human

7.3 Atomic commits
Each phase is a single merge-able unit. If a phase is too large, it splits into sub-phases (e.g., 2a, 2b) but each sub-phase is atomic.
7.4 Rollback
If a phase introduces a regression not caught by tests, revert the entire phase commit. No partial reverts.
8 — Out of Scope
The following are explicitly not part of this campaign:

    runLlmPatchFlow.ts split (11.5k LOC god function). This is agent-core debt, not TUI debt. Address in a separate campaign after TUI parity is achieved.
    Parallel subagent dispatch. Current serial model is preserved. Parallel fan-out requires deeper changes to toolExecutor.ts and approval registries; deferred to a future campaign.
    MCP tool grouping in transcript. MCP tools continue to render as flat entries with namespaced names. Grouping by server is a nice-to-have, not a parity requirement.
    Classifier non-determinism fix. The 3/40 tier variance is a known issue; mitigated by the confidence gate. A proper fix requires classifier prompt tuning or a deterministic fallback, which is out of scope for TUI redesign.

9 — Success Criteria
The redesign is complete when:

    All 18 modals use OverlayShell (zero inline border/title/footer in Tier 3 components).
    Keybinding verb map is enforced (no a for approve, no modal-specific Esc).
    uiScheduler handles 10k events/sec without blocking the agent loop.
    Subagent runs are visually distinct (header, indent, cost line, spinner label).
    npm test passes with 5875+ cases (existing + new golden tests).
    Manual review of a 30-minute run transcript shows no ghost rows, no layout reflow, no silent event drops.

10 — App-feel layer
10.1 Rationale
Competitor CLI agents (Claude Code, Codex CLI) achieve their distinctive "app feel" through two
mechanisms: a persistent identity frame pinned at the top of the terminal scrollback, and a visually
anchored bottom chrome (status bar + composer). Zone's coding-agent correctness depends on inline
scrollback — selection, grep, pipe-to-file, and screenshot capture all require the transcript to
live in the terminal's normal scroll buffer. Alternate screen (which Claude Code uses) would break
these workflows. Phase 7 therefore keeps inline scrollback and adds the identity-frame and
chrome-unification layers on top of it.

10.2 Visual language source of truth
zonecli.dev defines the visual language: lowercase mono labels, a single teal accent (#22B3C4)
carried by role.brand and role.accent, thin rules (glyph.separator, role.muted) instead of heavy
box borders, and generous whitespace (spacing.md/lg). Phase 7 components compose exclusively
from existing theme tokens — no new colors, no new glyphs, no ASCII art beyond the single brand
glyph already in the glyph table.

10.3 Components
WelcomeFrame (7a) — A one-time opening frame, Static-committed so it persists in scrollback
(Claude Code model: a durable identity, not a vanishing splash). Reads boot data from
StoreState.boot: version, user (git config user.name, fallback "operator"), repoPath (cwd
basename), branch, model, provider, dailyCapUsd, keySource ("byok" | "gateway"), and the first
two bullet lines of CHANGELOG.md's latest heading. All git/file reads at startup are try/catch
guarded with safe fallbacks — a broken git must never block boot.

StatusBar persistent warning slot (7b) — A selector (selectPersistentWarnings) returns at most
two persistent condition strings (e.g. "/rc failed", "cap 85%"). Rendered right-aligned in
role.caution after the existing right hint. Transient Toasts stay unchanged; this slot is for
conditions that persist until resolved, not momentary notifications.

Composer chrome (7c) — Wraps the existing input surface with the site's input-box language: a
thin top rule and bottom rule (glyph.separator, role.muted), and a one-row key-hints line
beneath (visible at idle only): "shift+tab mode · /help · @file · \+enter newline · esc clear".
No behavior change — palettes, paste handling, and submission routing stay identical.

Phase 7.5b supersedes that Composer chrome: a one-cell `role.accent` strip spans the
editable height beside a borderless `role.surface` input with `role.surfaceForeground`
text and the `▸` prompt. There are no Composer horizontal rules. Whole shortcut hints
use compact variants at narrow widths. Palettes and the model picker window around
keyboard focus; decorative hero content yields to interactive controls. ModelPicker
uses one submode-aware OverlayShell footer and a navigation cursor separate from the
applied-model radio, including when terminal colors are disabled. Logical transcript
retention, acknowledged Static delivery, and the explicit resize-clearing policy are
unchanged.

10.4 Constraints
- No alternate screen. Inline scrollback is the correctness requirement.
- WelcomeFrame renders once via Static commit. It must not re-render per event.
- All startup reads (git config, CHANGELOG.md) are try/catch guarded. A broken git or missing
  CHANGELOG must never block boot — every field has a documented fallback.
- No new dependencies. All composition uses existing theme tokens and Ink primitives.