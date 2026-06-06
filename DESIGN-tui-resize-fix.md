# DESIGN — TUI resize "ghost-row multiply" fix

Parked bug, now more visible because the pinned `PlanPanel` added a multi-line live region.
Read-only investigation; this doc proposes the fix. Cost: ~$0 (rendering only).

## TL;DR

On a **mid-session narrowing** resize, the bottom "chrome" (StatusBar, Composer, PlanPanel, live
narration) leaves **ghost rows** that accumulate on each further narrowing. Root cause: when the
terminal narrows, it **reflows** the already-printed full-width live lines into *more physical rows*,
but Ink erases only the **logical** line count of the previous frame (counted as `str.split("\n")`
at the *old* width). The erase under-counts → leftover rows → ghosts. Ink 7.0.3 *does* attempt a
mitigation (`log.clear()` on narrowing) but it uses the same logical count, so it under-erases too.

There is **no app-level erase that removes only the ghosts without also touching the committed
transcript** (they're physically interleaved). The robust fix is therefore: on a debounced,
narrowing-only resize, **clear the screen and let Ink re-emit the full committed transcript**
(`<Static>` remount) — preserving the transcript by *re-printing* it, not by avoiding the clear.

---

## Root cause (with code evidence)

### Zone's render path
`src/cli/tui/index.tsx` mounts with `{ exitOnCtrlC: false, alternateScreen: false }` — **native
scrollback**, no alternate buffer. The live region (bottom-anchored) is, in order
(`App.tsx` AppInner return): `<Spinner/>`, modals, `<Composer/>`, `<PlanPanel/>` (when running),
`<StatusBar/>`. The committed transcript is an Ink `<Static>` inside `<Transcript/>`
(`Transcript.tsx`), keyed `key={state.transcriptGeneration}`, `style={{ width: stdout.columns }}`.

Zone does **no resize handling of its own** — a full-repo grep finds no `SIGWINCH`, no
`stdout.on("resize")`, no resize-reactive width. It's entirely delegated to Ink.

### What Ink 7.0.3 does on resize
`node_modules/ink/build/ink.js:248` registers `options.stdout.on('resize', this.resized)`. The
handler (`ink.js:262-272`):

```js
resized = () => {
  const currentWidth = getWindowSize(this.options.stdout).columns;
  if (currentWidth < this.lastTerminalWidth) {
    // We clear the screen when decreasing terminal width to prevent duplicate overlapping re-renders.
    this.log.clear();          // ← erases the LOGICAL line count of the last frame
    this.lastOutput = '';
    this.lastOutputToRender = '';
  }
  this.calculateLayout();      // re-reads stdout.columns, re-flows yoga at NEW width
  this.onRender();
  this.lastTerminalWidth = currentWidth;
};
```

Zone is interactive and **not** screen-reader mode (`isScreenReaderEnabled` defaults false,
`ink.js:168`), so `onRender` dispatches to `renderInteractiveFrame` (`ink.js:390`), whose normal
branch writes via `this.log` / `this.throttledLog` (`ink.js:726-735`). **The erase is owned by
log-update, not by `lastOutputHeight`.** (The sub-agent's "reset `lastOutputHeight`" theory applies
only to the screen-reader path at `ink.js:343-385`, which Zone never enters — that fix would not
help here.)

### The erase is logical, the reflow is physical
log-update tracks line count as `str.split("\n").length` and erases exactly that many:

```js
// node_modules/ink/build/log-update.js
const lines = str.split('\n');                 // :33
...
ansiEscapes.eraseLines(previousLineCount) + str // :49
previousLineCount = lines.length;               // :52
render.clear = () => {                           // :58
  stream.write(prefix + ansiEscapes.eraseLines(previousLineCount)); // :60  ← logical count
  ...
};
```

`eraseLines(n)` walks **up exactly `n` rows** clearing each (`ansi-escapes/base.js` eraseLines).
Ink pre-wraps each frame to the *current* width, so in steady state logical lines == physical rows
and the erase is exact. **But across a narrowing resize:**

1. The previous frame was laid out at the **old** width (e.g. 120). Full-width live lines were
   printed exactly that wide.
2. The terminal **reflows** those on-screen lines to the **new** width (e.g. 80): each over-width
   line now occupies **2 physical rows**.
3. `resized()` fires → `log.clear()` erases `previousLineCount` = the **logical** count at the old
   width (fewer than the now-reflowed physical rows) → **under-erase** → the overflow rows survive
   as ghosts. The fresh frame is then written below them. Repeat each narrowing → ghosts multiply.

### The specific culprits (full-width live lines that always reflow)
- **StatusBar** separator: `const sep = "─".repeat(cols)` (`StatusBar.tsx`) — *exactly* terminal
  width, so it reflows on **any** narrowing.
- **Composer** box: `<Box ... width={stdout.columns ?? 80}>` — full width.
- **user_prompt** transcript rows and the live narration `◆` line — full width.
- **PlanPanel** rows (`flexGrow={1}`) — the newest addition; multi-line, so it both adds live rows
  *and* increases the reflow surface, which is why the bug became more visible.

### Why Ink's own mitigation is insufficient
`resized()`'s narrowing `log.clear()` is the right idea but uses the **logical** count
(`log-update.js:60`). It cannot know the physical row count after the terminal reflows over-width
lines — that information isn't reconstructed against the new width. So the under-erase persists.
(Ink *does* have a clean path — `renderInteractiveFrame`'s "fullscreen" branch at `ink.js:705-718`
writes `ansiEscapes.clearTerminal + this.fullStaticOutput + output`, i.e. **full clear + re-emit
everything** — but it's gated on `outputHeight >= viewportRows`, which Zone's few-row chrome never
hits.)

### Not a Static-duplication bug
On resize the `<Static key={transcriptGeneration}>` key does **not** change (it only bumps on
`/clear`/`SESSION_RESUME`), so Static is **not** remounted and does **not** re-emit the transcript.
The multiply is purely the live region under-erase — matching the report ("the *chrome* multiplies",
not the whole transcript).

---

## The fundamental tension

The ghost rows sit **physically interleaved** with committed transcript in the viewport. Any erase
that removes the ghosts also blanks the transcript rows around them. To clear ghosts *and* keep the
transcript, you must **re-emit the transcript** after clearing. The only alternative — erase *only*
the live region's physical rows — needs the live region's post-reflow physical row count, which
lives in Ink's private `lastOutputToRender` and is not exposed to the app layer. So at the app layer
the realistic choice is "clear + re-emit", and the design question becomes *which clear*.

Ink ships two primitives (`node_modules/ansi-escapes/base.js`):
- `clearViewport = \x1b[2J\x1b[H` (`:102`) — erases the **visible** screen, **keeps** saved scrollback.
- `clearTerminal = \x1b[2J\x1b[3J\x1b[H` (`:130`) — also `\x1b[3J` = **erases saved scrollback**.

---

## Recommended fix

**A debounced, narrowing-gated resize controller (in `index.tsx`, where `instance` + the app
element live) that, once the drag settles, clears the terminal and forces a full `<Static>`
re-emit.** No `node_modules` patch.

### Behavior
1. `process.stdout.on("resize", handler)` registered after mount; removed on unmount/exit.
2. **Debounce** ~100 ms (resize fires rapidly during a drag) — reuse the inline `setTimeout`
   pattern from `useAgentEvents.ts` (no shared util exists).
3. **Narrowing gate**: track `lastSettledCols`. On settle, act only if `cols < lastSettledCols`
   (widening self-cleans — Ink over-erases the taller old frame, no ghosts). Update `lastSettledCols`.
4. On a narrowing settle:
   a. Write the clear escape to stdout (`clearTerminal` — see open decision #1).
   b. `dispatch({ type: "TRANSCRIPT_REMOUNT" })` — a **new** action that bumps
      `transcriptGeneration` **without** emptying the transcript. The key change remounts `<Static>`,
      so Ink re-emits the **entire committed transcript** at the new width, then the live chrome —
      a clean, ghost-free repaint. `storeCapture.dispatch` (already captured via `onDispatchCapture`)
      is the dispatch handle.

### Why this satisfies "preserve the committed transcript, kill the ghosts"
The transcript is preserved by being **re-emitted** (remount), not by dodging the clear. After the
repaint the full transcript is back in native scrollback, fully scrollable — the property Zone's
`alternateScreen:false` design exists to provide. The clear removes every ghost because it wipes the
whole region before the single clean re-emit. This is exactly Ink's own fullscreen strategy
(`clearTerminal + fullStaticOutput`, `ink.js:710`), adapted to Zone's non-fullscreen layout via an
explicit remount.

### Sequencing note
Write the clear escape **synchronously** in the handler, then dispatch the remount (React render →
Ink `onRender` paints after the clear, from cursor-home). The remount routes through
`renderInteractiveFrame`'s `hasStaticOutput` branch (`ink.js:726-728`: `log.clear()` from home is a
harmless no-op, then `staticOutput` + live are written). Exact ordering (whether an `instance.clear()`
is also needed to reset log-update's stale `previousLineCount`) is **timing-sensitive and must be
tuned empirically** during implementation — see the dogfood phase.

### stdoutShield is not in the way
`stdoutShield.ts` only swallows writes matching `^\[[a-z_]…` (telemetry) or a `✓/✗/⚠` result line.
`clearTerminal` begins with `\x1b` (ESC), matches neither, and passes through. (Ink's own escapes
already flow through the patched `process.stdout.write` unharmed for the same reason.)

---

## Alternatives considered

| Option | Ghosts? | Transcript | Pre-Zone shell history | Verdict |
|---|---|---|---|---|
| **B (recommended): `clearTerminal` ([3J) + remount** | gone | preserved (re-emitted, visible, no dup) | **lost** | Recommended — cleanest; matches Ink fullscreen |
| A: `clearViewport` ([2J only) + remount | gone | preserved + visible | kept | Re-emit **duplicates** the already-scrolled transcript in saved scrollback on long sessions |
| Patch Ink to erase **physical** rows (recompute old frame wrapped at new width) | gone | untouched (zero re-emit) | kept | The only **zero-loss** fix, but edits vendored `ink`/`log-update` (patch-package), breaks on upgrade → pursue as an **upstream PR**, not the app fix |
| `alternateScreen: true` | gone | n/a (alt buffer) | kept | Trivially fixes ghosting but **abandons native scrollback** — the core of Zone's TUI design. Rejected |
| Do nothing / shrink full-width live elements (e.g. `cols-1` separator) | reduced, not gone | — | — | Partial mitigation only; full-width chrome is intentional. Rejected as a fix |

---

## Phased plan

| Phase | Scope | Files |
|---|---|---|
| **1 — store action** | `TRANSCRIPT_REMOUNT`: bump `transcriptGeneration` only (preserve `transcript`); reducer case + test | `src/cli/tui/store.tsx`, `store.test.tsx` |
| **2 — resize decision (pure)** | `shouldRedrawOnResize(prevCols, nextCols) → boolean` (narrowing gate) — pure, unit-tested | new `src/cli/tui/resizeController.ts` (+ test) |
| **3 — controller wiring** | `stdout.on("resize", debounced)` in `runTui`; on narrowing settle → write `clearTerminal` + `storeCapture.dispatch(TRANSCRIPT_REMOUNT)`; cleanup (`off` + `clearTimeout`) on unmount/exit/signals | `src/cli/tui/index.tsx` |
| **4 — dogfood + tune** | Verify across terminals (alacritty, foot, kitty, tmux, VS Code) on narrow drag; tune debounce + whether an `instance.clear()` precede is needed | — |

Phases 1–2 are unit-testable (reducer + pure decision fn). Phase 3 is wiring; Phase 4 is the
empirical step (terminal escape behavior can't be meaningfully asserted in vitest).

## File touchpoints

- `src/cli/tui/store.tsx` — `TRANSCRIPT_REMOUNT` action + reducer (`transcriptGeneration + 1`,
  transcript untouched). Note: `transcriptGeneration` is already the Static remount key; reusing it
  is consistent with `/clear` and `SESSION_RESUME`.
- `src/cli/tui/resizeController.ts` (new) — pure `shouldRedrawOnResize` + a small debounce helper.
- `src/cli/tui/index.tsx` — register/cleanup the resize listener around `instance`; import
  `clearTerminal` from `ansi-escapes` (already transitively present) or inline the literal.
- Tests: `store.test.tsx` (remount preserves transcript, bumps generation), `resizeController.test.ts`
  (narrowing → true, widening/equal → false).

## Risks

- **Loses pre-Zone shell scrollback** (`[3J`) — the main tradeoff; see open decision #1.
- **Transcript "replay" cost** on very long sessions (full re-emit per narrowing-settle) — bounded
  by debounce + narrowing-gate; identical mechanism to today's `/clear` remount.
- **Brief full-screen flash** on resize-settle — once per drag (debounced); acceptable.
- **Cross-terminal `[3J` support** — universal on modern emulators; old Windows uses the `[0f`
  variant, which `ansi-escapes.clearTerminal` already emits.
- **Race with Ink's own `resized`** — Ink re-renders (with transient ghosts) on each raw event; our
  debounced handler runs **after** settle and produces the final clean state. Net: clean.
- **Touches terminal control** — keep the escape isolated to the controller; never emit `[3J`
  anywhere else; the `<Static>` model is otherwise untouched.

## Open decisions

1. **★ `[3J` (recommended) vs `[2J`-only.** `[3J` clears saved scrollback → no transcript
   duplication, but loses shell history from before Zone launched. `[2J`-only keeps that history but
   duplicates the already-scrolled transcript on long sessions. For an agent TUI that takes over the
   terminal, losing pre-Zone shell history is the standard, lower-surprise tradeoff (it's what Ink's
   own fullscreen path does) — **recommend `[3J`**. Bedo's call.
2. **Debounce interval** — 80–150 ms; recommend ~100 ms.
3. **Full re-emit vs cap** — re-emit the whole transcript (v1, matches `/clear`) vs cap to the last K
   rows and rely on scrollback. Recommend full re-emit; revisit only if heavy in practice.
4. **Upstream Ink PR** — the physical-row-erase fix (recompute the old frame wrapped at the new
   width in `resized`/`log.clear`) is the only zero-loss fix and would help all Ink apps. Optional
   follow-on; not required for Zone's fix.
