# DESIGN — TUI.9 layout restructure (Static / dynamic region / overlays)

**Date:** 2026-06-03 · **Scope:** Opus design pass, read-only. Sonnet implements in stages.
**Verdict up front:** the current tree is already ~70% of the target — Static holds completed items, the in-flight slot + Spinner are the live region, modals already render outside Static. This is a **consolidation + clean modal-overlay separation**, not a rewrite. The core "Static on top → live region pinned to bottom" assumption is **already proven by the running production TUI** (`render(..., { alternateScreen: false })`, index.tsx:253) — no spike needed; the running code is the proof.

---

## Part 1 — Current render tree (precise)

### Mount + banner
- **`writeBannerToStdout`** — `src/cli/tui/index.tsx:33-47`. One-shot raw `process.stdout.write` of `✦ Zone v{version}  {cwd}·{branch}\n\n` (model/cap line removed in 697d77b — the badge now lives in StatusBar). Called at `index.tsx:231`, **before** Ink mounts.
- **Ink mount** — `index.tsx:234` `render(<App/>, { exitOnCtrlC: false, alternateScreen: false })`. **Native scrollback** (not alt-screen). Single `await instance.waitUntilExit()` at `:257`. This is load-bearing: Static flushes permanent lines into terminal history; the live region re-renders at the cursor below them.

### App tree — `src/cli/tui/App.tsx:154-164`
```
<Box flexDirection="column">                       // root = live region
  <Box paddingX={2}><Transcript /></Box>           // :156-158  Static + in-flight slot
  <Spinner />                                       // :159      animated ✦ (separate sibling)
  {modals}                                          // :160      inline-appended fragment (11 modals)
  <Composer onSubmit=… onExit=… />                  // :161      input
  <StatusBar />                                     // :162      model·used·cap + run-state
</Box>
```
**No `<Static>` at App level** — it is inside Transcript.

### Transcript — `src/cli/tui/components/Transcript.tsx:59-82`
```
<Box flexDirection="column">
  <Static key={transcriptGeneration}               // :61-69  COMPLETED items → scrollback
          items={state.transcript…}
          style={{ width: stdout.columns ?? 80 }}>  // :64     TUI.10.H.1 width fix (DO NOT DROP)
    {renderEntry}                                    // narration | tool_call | error | phase_marker |
  </Static>                                          //          user_prompt | assistant_final
  {liveNarration && …}                               // :70-77  IN-FLIGHT narration (dynamic)
  {liveToolCall && …}                                // :78-80  IN-FLIGHT tool call (dynamic)
</Box>
```
- `state.transcriptGeneration` (bumped on `/clear`) is the Static `key` → remount to drop history.
- `renderEntry` (`:9-51`) dispatches the 6 entry kinds. `assistant_final` → `<MarkdownText>`; `tool_call` → `<ToolCall>` (which renders `<DiffView>` for apply_patch and `<CommandTail>` for bash). **All TUI.10 component fixes render INSIDE Static** — they are committed/immutable once in the transcript.

### Spinner — `src/cli/tui/components/Spinner.tsx`
Animated magenta `✦` (8 glyphs, `setInterval(100ms)`), gated on `state.spinner?.active`, returns `null` when inactive. Mounted as a **separate App sibling** (App.tsx:159), not co-located with the in-flight slot it logically belongs to.

### Modals — `src/cli/tui/App.tsx:127-152` (the `modals` fragment)
Flat `<>` fragment, **inline-appended** between Spinner and Composer. 11 entries, each gated by store state:
| Render condition | Component | Kind |
|---|---|---|
| `toastQueue.length > 0` | `Toast` | transient, non-blocking |
| `pendingApproval !== null` | `ApprovalModal` | blocking |
| `modalView === "permissions"` | `PermissionsView` | blocking |
| `modalView === "keys"` | `ApiKeysView` | blocking |
| `modalView === "sessions"` | `SessionsModal` | blocking |
| `modalView === "model"` | `ModelModal` | blocking |
| `modalView === "effort"` | `EffortModal` | blocking |
| `modalView === "metrics"` | `MetricsModal` | blocking |
| `modalView === "limits"` | `LimitsModal` | blocking |
| `planProposal !== null` | `PlanModal` | blocking |
| `planReadyProposal !== null` | `PlanReadyModal` | blocking |

Each modal is a bordered `<Box>` with its **own `useInput`** that consumes its keys (Esc dismisses/rejects). They sit in the live region (already outside Static) but **push Composer + StatusBar down** rather than overlaying a fixed zone.

### Input routing (three coordinated sites)
1. **App top-level `useInput`** — App.tsx:100-118. Ctrl+C (`\x03`) always aborts+exits; **Shift+Tab** → `MODE_CYCLE` (reducer no-ops when a modal is open, store.tsx); **Esc** aborts the run only when `runState==="running" && pendingApproval===null && modalView==="none"`.
2. **Composer master gate** — Composer.tsx:210 `if (pendingApproval !== null || modalView !== "none") return;` — blocks all composer input while any modal is open.
3. **Each modal's `useInput`** — fires independently (Ink composes hooks); only acts on its own keys.
The "is a modal open" boolean is **recomputed inline at 3+ sites** (`modalView !== "none" || pendingApproval !== null`) — no single selector. This is correct today but drift-prone.

### Store dynamic-region state — `src/cli/tui/store.tsx`
- `liveTail: { currentToolCall: {toolName,args,patch}|null, narrationBuffer: string }` (`:28-29,56`) — in-flight slot.
- `spinner: { active: boolean, label: string } | null` (`:57`).
- `transcript: TranscriptEntry[]` (Static source) + `transcriptGeneration` (`:95`).
- `modalView` union + `pendingApproval` + `planProposal` + `planReadyProposal` — modal gates.

### Logging — the corruption risk
`log()` (`src/utils/logger.ts:5-7`) = `console.log(...)` → **STDOUT**. Every `[zone-*]` telemetry line (archetype, r2-shim, token-breakdown, cache, …) goes to stdout. Ink owns stdout, so this would corrupt Static. The **only** mitigation today is `applyStdoutInterception` (`src/cli/tui/stdoutShield.ts`), a global monkey-patch on `process.stdout.write` that swallows `^\[tag\]\s` lines (`TELEMETRY_RE`, `:6`) and `✓/✗/⚠` result lines, optionally rerouting to stderr under `ZONE_TUI_DEBUG=1`. **Fragile:** any stdout write not matching the regex (e.g. `[INFO …]` uppercase, multi-line payloads, third-party libs) leaks into the render.

### TUI.10 fixes that MUST NOT regress
| Fix | Location | Mechanism |
|---|---|---|
| Static width (10.H.1) | Transcript.tsx:64 | `style={{ width: stdout.columns ?? 80 }}` — Static is `position:absolute` → shrink-to-fit without it |
| Composer ghost-row (10.G) | Composer.tsx:~393 | content `<Text>` wrapped in `<Box flexGrow={1}>` so measure/render widths agree |
| MarkdownText (10.C) | MarkdownText.tsx + Transcript renderEntry `assistant_final` | custom terminal markdown; **inside Static** |
| DiffView (10.I) | DiffView.tsx + ToolCall.tsx:~75 | FIND/REPLACE → ±; **inside Static** |
| CommandTail (10.J/.J.1) | CommandTail.tsx + ToolCall.tsx:~80 | last-N output lines + exit glyph; **inside Static** |
| Test harness | `__fixtures__/staticHarness.tsx` | `renderTranscript` (cols=100 hardcoded) + `renderTranscriptAt(t, cols)` (Ink render w/ mock stdout EventEmitter) |

---

## Part 2 — Target architecture

Same flex model (no absolute row math — Ink pins the live region to the bottom for free via `alternateScreen:false`). The change is **componentizing the three zones** and making the overlay a fixed swap, not an inline insert.

```
<Box flexDirection="column">                         // root = live region
  <TranscriptStatic />                               // <Static> COMPLETED items ONLY → native scrollback
  <DynamicRegion>                                     // re-renders each frame
    {isBlockingModalOpen                              // ── single selector ──
       ? <OverlayLayer />                             //    modal occupies the slot; Composer hidden
       : <ActiveOutput />}                            //    in-flight narration + tool call + Spinner
    {!isBlockingModalOpen && <Composer />}            // hidden while a blocking modal owns focus
    {toastQueue.length > 0 && <Toast />}              // transient, non-blocking — above StatusBar
    <StatusBar />                                     // ALWAYS visible (badge + cost + animations)
  </DynamicRegion>
</Box>
```

### What counts as "completed" (Static) vs "in-flight" (dynamic)
- **Static / completed:** any `TranscriptEntry` already pushed to `state.transcript` — finalized narration (post `NARRATION_COMMIT`), finalized tool calls (post `tool_result`, with DiffView/CommandTail), user prompts, assistant_final, phase markers, errors. Immutable; never re-rendered. This is unchanged from today.
- **Dynamic / in-flight:** `liveTail.narrationBuffer` (streaming narration not yet committed), `liveTail.currentToolCall` (open tool call awaiting result), `spinner`. These move into Static when finalized (the existing `NARRATION_COMMIT` / `TOOL_CALL_*` reducers already do this).

### `TranscriptStatic` (extract from current Transcript)
Transcript.tsx loses its in-flight tail and becomes **Static-only**. Keep `key={transcriptGeneration}` and `style={{ width: stdout.columns ?? 80 }}` verbatim. renderEntry + MarkdownText/DiffView/CommandTail unchanged.

### `ActiveOutput` (new — consolidates the dynamic slot)
Owns what is today split between Transcript's tail (lines 70-80) and the standalone `<Spinner>`: `liveNarration` row, `liveToolCall` row, and `<Spinner>`. One component, one place. Width via `useStdout()` like Static.

### `OverlayLayer` (new — owns all modals + routing)
- Renders exactly one blocking modal based on a **single selector** `selectActiveModal(state)` returning a discriminated value (`"approval" | "model" | "plan" | … | null`). Replaces the 11-line inline fragment.
- When a blocking modal is open it **occupies the dynamic slot** (ActiveOutput + Composer hidden); StatusBar persists. This stops the layout from jumping as modals stack above a dead input box.
- `Toast` is NOT in OverlayLayer — it is transient/non-blocking and renders above StatusBar regardless of modal state.

### Single source of truth — selectors in store.tsx
Add and export:
```ts
export const selectIsBlockingModalOpen = (s: StoreState): boolean =>
  s.modalView !== "none" || s.pendingApproval !== null;
export const selectActiveModal = (s: StoreState): ModalKind | null => …; // discriminated
```
All three input sites (App useInput, Composer gate, OverlayLayer) consume `selectIsBlockingModalOpen` — no inline re-derivation. Input routing stays as-is structurally (Ink composes useInput hooks); only the boolean is centralized.

### Bottom-anchoring, resize, long output, finalize-transition
- **Anchoring:** free. Static lines leave the live region permanently; Composer/StatusBar are the last live rows → always at the cursor (bottom). Proven by the shipping TUI.
- **Resize:** `useStdout()` already re-renders on `stdout` `resize`; the `style={{ width: stdout.columns }}` recomputes. Add a `resize` smoke test (mock stdout emit).
- **Very long in-flight output:** ActiveOutput should cap streaming narration height (e.g. last N lines, mirroring CommandTail's tail strategy) so the live region never exceeds the viewport and fights the anchor. Completed content is in Static and scrolls naturally.
- **Finalize transition:** unchanged — when an in-flight item commits, the reducer moves it from `liveTail` into `transcript`; Static appends one permanent block, ActiveOutput clears. No flicker because Static append + live clear happen in one dispatch.

---

## Part 3 — Animation mount points (earmark only; do not build)

Animations require re-renders → **dynamic region / overlays ONLY, never Static.**

| Animation | Slot | Notes |
|---|---|---|
| Working spinner + cycling status lines | `ActiveOutput` | Spinner already animates (100ms); status cycling reads `spinner.label` |
| Success flourish (sparkle/✓/brief confetti on patch-applied) | transient in `ActiveOutput`, or a self-dismissing micro-overlay in `DynamicRegion` | mount on `apply_patch` success event; auto-unmount after ~1 frame-burst; NEVER Static |
| Cost gauge (used→cap color shift + pulse near cap) | `StatusBar` badge line | StatusBar is already dynamic; pulse drives off `costUsd/capUsd` ratio |
| Startup splash (figlet ZONE + gradient sweep) | one-shot Ink `<Splash>` rendered ~Nms then unmounted, **before** the REPL tree | must be Ink (dynamic) to sweep; the pre-Ink `writeBannerToStdout` can only print one static frame |

### Animation gate (build the gate + slots now; animations later)
A small hook/context `useAnimationGate()`:
```ts
const enabled = isTTY && settingOn && isActive;   // active = run in progress / transient event live
```
- `isTTY` from `process.stdout.isTTY` (auto-off for piped/non-TTY).
- `settingOn` from an `animations: on|off` setting (persist alongside model/effort on disk; default on).
- `isActive` gates idle CPU — no timers when nothing is happening.
- **~100ms frame budget** (matches Spinner). Every animated component subscribes to the gate; when `!enabled` it renders the static end-state. This is the only new infra Part 3 needs — the delight pass drops animations into the earmarked slots without touching layout.

---

## Part 4 — Migration risks + staged plan

### Risks
1. **Regressing TUI.10 Static/Yoga fixes** — the `style={{ width: stdout.columns }}` (Transcript.tsx:64) and the Composer flexGrow wrap are easy to drop in a refactor. Pin both with multi-width tests BEFORE moving code.
2. **Input-focus drift** when modals overlay — three sites compute the gate; centralize to one selector or they desync (e.g. Composer accepts a keystroke a modal also handled).
3. **Resize / narrow widths** — bugs hide at the columns=100 default. Must test at 40/60/80/120.
4. **Stray stdout corrupting Static** — the `[zone-*]` logs; the shield is a leaky net. Fix at the source (Stage 0) before relying on Static for more.
5. **Harness only renders `<Transcript>`** — no full-App / modal coverage at custom widths. Needs a `renderAppAt(cols)` extension.

### Ordered, independently-testable stages
Each stage ships + verifies on its own; no big-bang.

- **Stage 0 — Route logs off stdout (prerequisite).** Make `log()`/`debugLog()` (logger.ts) write to `process.stderr` (or a file sink) when `!process.stdout.isTTY` is false i.e. in the TUI; keep `stdoutShield` as a fallback net. Goal: Ink solely owns stdout. *Verify:* unit test asserting `log()` does not write to stdout in TUI mode; a piped headless run still emits `[zone-*]` (to stdout or chosen sink) unchanged.
- **Stage 1 — Extract `TranscriptStatic` + `ActiveOutput`.** Move liveNarration/liveToolCall out of Transcript into `ActiveOutput`; relocate `<Spinner>` into it; Transcript becomes Static-only. No behavior change. *Verify:* `renderTranscriptAt` at 60/80/100 — completed items present in Static frames, in-flight in last frame, **no ghost rows**; existing transcript.test.tsx green.
- **Stage 2 — `OverlayLayer` + single selector.** Add `selectIsBlockingModalOpen`/`selectActiveModal` to store; replace the App inline fragment with `<OverlayLayer>`; hide Composer/ActiveOutput when a blocking modal is open; keep Toast + StatusBar always-on; point all three input gates at the selector. *Verify:* modal-open frame contains the modal and NOT the Composer prompt; modal-closed shows Composer; **modal text never appears in a Static frame**; approvalModal.test.tsx / composer.test.tsx green.
- **Stage 3 — Bottom-anchor + resize hardening.** Confirm anchoring (no code if Stage 1/2 preserved it); add resize handling/test. *Verify:* `renderAppAt` at two widths + a `stdout.emit("resize")` → Static width recomputes, no clipping.
- **Stage 4 — Animation slots + gate (no animations).** Add `useAnimationGate()` + `animations` setting; wire the four mount points to read the gate and render static end-states. *Verify:* gate returns `false` when `isTTY=false`; Spinner renders nothing/idle under the gate-off path.

### Layout-regression tests to add
- **Extend the harness:** `renderAppAt(opts, columns)` in `__fixtures__/` — full `<App>` (not just Transcript) via Ink `render` with a mock stdout EventEmitter (mirror `renderTranscriptAt`), so modals + dynamic region are testable at width.
- **Multi-width no-ghost/no-clip:** render representative transcripts at **40, 60, 80, 120** via `renderTranscriptAt`/`renderAppAt`; assert no empty bordered ghost row, no mid-token clipping, badge line intact.
- **Modal-doesn't-pollute-Static:** open each blocking modal; assert its text appears in the live frame but in **no** Static-committed frame; assert Composer hidden while open, restored after close.
- **Animations-off-when-non-TTY:** `useAnimationGate` returns false for `isTTY=false`; assert no timer-driven frames emitted.

---

## One-line summary
Zone's TUI already does Static-completed + live-region-below + outside-Static modals; TUI.9 is a low-risk 5-stage consolidation — route `[zone-*]` logs off stdout (Stage 0), extract `TranscriptStatic`/`ActiveOutput`/`OverlayLayer` behind one `selectIsBlockingModalOpen` selector, harden resize, and add a gated animation layer — each stage independently tested at multiple widths via an extended `renderAppAt` harness so the TUI.10 Static/Yoga fixes never regress.
