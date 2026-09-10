# Zone TUI — UX Audit Report

**Version:** 2.3.0 | **Date:** 2026-09-09 | **Read-only, no source files modified**

---

## 1. Keybinding Registry

### Global Bindings (App.tsx — `useInput` at line 168)

| Key | Context | Action | File:Line |
|-----|---------|--------|-----------|
| `Ctrl+C` (`\x03`) | Always | Abort run + exit TUI | `App.tsx:172-175` |
| `Shift+Tab` | Always | Cycle mode (normal → autoAccept → plan → normal) | `App.tsx:177-180` |
| `Esc` | Question pending, no modal | Dismiss question (live → decline, carried → discard) | `App.tsx:183-197` |
| `Esc` | Run in progress, no approval/modal | Abort run (`RUN_ABORTED`) | `App.tsx:199-204` |

### Composer Bindings (Composer.tsx — `useInput` at line 510)

| Key | Context | Action | File:Line |
|-----|---------|--------|-----------|
| `Enter` | Normal, buffer non-empty | Submit prompt (`submitBuffer`) | `Composer.tsx:634` |
| `\` + `Enter` | Normal, buffer ends with `\` | Insert newline (multiline) | `Composer.tsx:630-633` |
| `Enter` | Slash palette open | Execute selected command | `Composer.tsx:535-538` |
| `Enter` | @-file palette open | Select file path | `Composer.tsx:520-525` |
| `Enter` | Question pending, buffer non-empty | Answer question (live or carried) | `Composer.tsx:575-595` |
| `Esc` | Buffer non-empty | Clear input buffer | `Composer.tsx:636-640` |
| `Esc` | Slash palette open | Close palette, clear buffer | `Composer.tsx:540-543` |
| `Esc` | @-file palette open | Close palette | `Composer.tsx:527` |
| `Esc` | Disabled (run in progress) | Clear slash buffer only | `Composer.tsx:603-606` |
| `↑` | Buffer empty / navigating | History previous entry | `Composer.tsx:682-689` |
| `↑` | Slash palette open | Move selection up | `Composer.tsx:531-533` |
| `↑` | @-file palette open | Move selection up | `Composer.tsx:516` |
| `↓` | History navigating | History next entry | `Composer.tsx:690-698` |
| `↓` | Slash palette open | Move selection down | `Composer.tsx:534-536` |
| `↓` | @-file palette open | Move selection down | `Composer.tsx:517` |
| `←` | Normal | Cursor left | `Composer.tsx:658-661` |
| `→` | Normal | Cursor right | `Composer.tsx:662-665` |
| `Home` | Normal | Cursor to start | `Composer.tsx:666-669` |
| `End` | Normal | Cursor to end | `Composer.tsx:670-673` |
| `Tab` | @-file palette open | Select file (same as Enter) | `Composer.tsx:520` |
| `Backspace`/`Delete` | Normal | Delete character before cursor | `Composer.tsx:649-655` |
| Any printable | Normal, not ctrl/meta | Insert character at cursor | `Composer.tsx:703-710` |
| Paste (bracketed) | Via `usePaste` at line 721 | Insert pasted text (large pastes → sentinel chip) | `Composer.tsx:721-741` |

### Modal-Specific Bindings

| Key | Modal | Action | File:Line |
|-----|-------|--------|-----------|
| `y` / `Y` | ApprovalModal | Approve command/edit | `ApprovalModal.tsx:33-40` |
| `n` / `N` / `Esc` | ApprovalModal | Deny command/edit | `ApprovalModal.tsx:42-52` |
| `t` / `T` | ApprovalModal (command only) | Trust prefix + approve | `ApprovalModal.tsx:54-60` |
| `y` / `n` / `Esc` | TrustModal | Trust/decline project directory | `TrustModal.tsx` |
| `a` / `A` | HookTrustModal | Approve hooks | `HookTrustModal.tsx` |
| `n` / `N` / `Esc` | HookTrustModal | Deny hooks | `HookTrustModal.tsx` |
| `a` / `A` | McpTrustModal | Approve MCP servers | `McpTrustModal.tsx:19` |
| `n` / `N` / `Esc` | McpTrustModal | Deny MCP servers | `McpTrustModal.tsx:21` |
| `↑`/`↓` + `Enter` + `Esc` | ModelModal | Navigate list, select, cancel | `ModelModal.tsx:44-70` |
| `↑`/`↓` + `Enter` + `Esc` | EffortModal | Navigate options, select, cancel | `EffortModal.tsx:32+` |
| `↑`/`↓` + `Enter` + `Esc` | SummaryModal | Navigate options, select, cancel | `SummaryModal.tsx:24+` |
| `↑`/`↓` + `Enter` + `Esc` | PlanModeModal | Navigate options, select, cancel | `PlanModeModal.tsx:24+` |
| `↑`/`↓` + `Enter` + `Esc` | SessionMemoryModal | Navigate options, select, cancel | `SessionMemoryModal.tsx:26+` |
| `↑`/`↓` + `Esc` | MetricsModal | Navigate, close | `MetricsModal.tsx:58+` |
| `Esc` | LimitsModal | Close | `LimitsModal.tsx` |
| `Enter` + `Esc` | LimitsModal | Submit cap value, cancel | `LimitsModal.tsx` |
| `a` / `A` | PlanModal | Approve plan revision | `PlanModal.tsx:14` |
| `r` / `R` / `Esc` | PlanModal | Reject plan revision | `PlanModal.tsx:19` |
| `↑`/`↓` | PermissionsView | Navigate trust list | `PermissionsView.tsx` |
| `d` / `Delete` | PermissionsView | Remove selected prefix | `PermissionsView.tsx` |
| `Esc` | PermissionsView | Close | `PermissionsView.tsx` |
| `n` / `e` / `p` / `d` | ApiKeysView | New/Edit/Price/Delete key | `ApiKeysView.tsx:86-93` |
| `a` / `o` / `g` | ApiKeysView (provider select) | Anthropic/OpenAI/Gateway | `ApiKeysView.tsx:128-130` |
| `Enter` + `Esc` | ApiKeysView | Submit input, cancel | `ApiKeysView.tsx:98,127,133,144` |
| `y` / `n` / `Esc` | ApiKeysView (confirm-delete) | Confirm/cancel delete | `ApiKeysView.tsx:181-182` |
| `Enter` | SessionsModal | Resume selected session | `SessionsModal.tsx` |
| `Esc` | SessionsModal | Close | `SessionsModal.tsx` |
| `↑`/`↓` | SessionsModal | Navigate session list | `SessionsModal.tsx` |
| `Enter` + `Esc` | CommitModal | Execute commit, close | `CommitModal.tsx` |
| `Enter` + `Esc` | FeedbackModal | Submit feedback, close | `FeedbackModal.tsx:37-53` |
| `m` | FeedbackModal (delivered) | Open email draft | `FeedbackModal.tsx:42-48` |
| `Esc` | UndoModal | Close | `UndoModal.tsx` |
| `Enter` | UndoModal | Confirm undo | `UndoModal.tsx` |
| `1`/`2`/`3`/`4`/`Esc` | PlanActionPrompt | Accept all / manual / feedback / feedback+approve / reject | `PlanActionPrompt.tsx:68-93` |
| `Enter`/`Esc` | PlanActionPrompt (feedback mode) | Submit feedback / cancel | `PlanActionPrompt.tsx:34-48` |
| `1`/`2`/`3`/`Esc` | StagedDiffModal | Apply all / per-file / refine / reject | `StagedDiffModal.tsx:52-71` |
| `Enter`/`Esc` | StagedDiffModal (feedback mode) | Submit refine / cancel | `StagedDiffModal.tsx:27-40` |
| `r` / `R` | MetricsModal | Toggle auto-refresh on/off | `MetricsModal.tsx:64` |
| `←`/`→` | MetricsModal | Cycle period (day/week/month/all) | `MetricsModal.tsx:60-62` |
| `c` / `C` | ModelModal (list mode) | Start custom model input | `ModelModal.tsx:76` |

### Conflict / Overlap Analysis

| Issue | Details |
|-------|---------|
| **Esc precedence** | App.tsx checks Esc for question-dismiss BEFORE run-abort. When a question is pending, Esc dismisses the question rather than aborting. Correct behavior but potentially confusing — the user may intend to abort the whole run. |
| **Modal blocks all input** | Composer.tsx:511 — `if (state.pendingApproval !== null \|\| state.modalView !== "none") return;` — when any modal or approval is active, the Composer's `useInput` is fully suppressed. Only the modal's own `useInput` receives keys. |
| **Enter ownership** | Three contexts compete for Enter: (1) slash palette, (2) question answer, (3) prompt submit. Order is palette → question → submit, which is correct — but the question context silently swallows Enter even if the user was mid-typing a slash command. |
| **No Ctrl+Z / undo shortcut** | The `/undo` command has no keybinding — it must be typed. Given that Ctrl+Z is SIGTSTP on Unix, this is likely intentional. |
| **No global Esc-to-close** | Modals handle their own Esc. If a user opens `/keys` and presses Esc, the Composer's `useInput` is blocked, and the `KEYS_CLOSE` dispatch happens inside `ApiKeysView`'s own `useInput`. No centralized modal-close handler. |

---

## 2. Design Tokens

### Token Module: `src/cli/tui/theme.ts`

The theme module defines two namespaces: **`role`** (semantic color roles) and **`glyph`** (structural characters).

#### Color Roles (`role`)

| Token | Value | Semantic | Hex/Theme-relative |
|-------|-------|----------|-------------------|
| `accent` | `"cyan"` | Modal chrome (informational/settings), selection foreground, prompt markers | Theme-relative |
| `caution` | `"yellow"` | Modal chrome (risk decisions), notices, mid-level budget warning | Theme-relative |
| `danger` | `"red"` | Destructive options, errors, failed tool calls | Theme-relative |
| `success` | `"green"` | Affirmative options, successful tool calls, completed todos | Theme-relative |
| `activity` | `"#22B3C4"` | Spinner animation (brand diagonal in motion) | Fixed hex |
| `emphasis` | `"white"` | Section headers, highlighted values, bold diff additions | Theme-relative |
| `muted` | `"gray"` | Quiet chrome borders, de-emphasized text | Theme-relative |
| `selectionBackground` | `"#22B3C4"` | Selected row background fill in navigable lists | Fixed hex |
| `selectionForeground` | `"#0B0E0F"` | Foreground on `selectionBackground` (7.67:1 contrast) | Fixed hex |
| `surface` | `"#0B0E0F"` | Composer background fill (dark surface block) | Fixed hex |
| `surfaceForeground` | `"#E6EDEF"` | Foreground on `surface` (16.35:1 contrast) | Fixed hex |
| `brand` | `"#22B3C4"` | Logo/mark identity, diff view marker accent, banner | Fixed hex |

#### Glyph Tokens (`glyph`)

| Token | Character | Usage |
|-------|-----------|-------|
| `cursor` | `▋` | Text input cursor |
| `entryMarker` | `◆ ` | First line of transcript blocks |
| `separator` | `─` | Horizontal rule, spinner frame |
| `bullet` | `• ` | List items |
| `warningMark` | `⚠` | Cautions, blocked actions |
| `groupMarker` | `●` | No-issue/success status icon |
| `failureMark` | `✗` | Failed commands/tools |
| `detailConnector` | `└ ` | Subordinate detail lines |
| `successMark` | `✓` | Successful commands/tools |
| `selectionCursor` | `▸ ` | Selected row in lists |
| `promptMarker` | `▸ ` | User prompt entries |
| `pendingMark` | `○` | Not-started status |
| `navigateArrows` | `↑↓` | Navigation hint |
| `radioSelected` | `(•)` | Active radio option |
| `radioUnselected` | `( )` | Inactive radio option |

#### Supporting Modules

| Module | File | Purpose |
|--------|------|---------|
| `contrast.ts` | `cli/tui/contrast.ts` | WCAG relative luminance + contrast ratio computation (hex → linear → ratio) |
| `colors.ts` | `cli/colors.ts` | Raw ANSI escapes for **headless mode only** (`\x1b[32m` etc.) — explicitly NOT for TUI |
| `banner.ts` | `cli/tui/banner.ts` | Startup banner using `chalk` with `role.brand` — outside Ink tree, imports theme |

### Hard-coded Color Violations

| Location | Count | Details |
|----------|-------|---------|
| **`.tsx` files (Ink components)** | **0** | Zero hard-coded hex or color-name literals. All 127 `color={...}` / `borderColor={...}` / `backgroundColor={...}` references use `role.*` tokens. |
| **`.tsx` ANSI escapes** | **0** in production code | All `\x1b[` sequences in .tsx files are in test files or comments |
| **`colors.ts` (headless)** | 12 ANSI codes | Used only by `dispatch.ts`, `sink.ts`, `diffOutput.ts` — non-TUI output paths |
| **`banner.ts`** | 0 direct escapes | Uses `chalk` with `role.brand` — delegates color resolution to chalk |
| **`resize.ts`** | 1 escape | `\x1b[2J\x1b[3J\x1b[H` — terminal control sequence (clear screen), not a color |

**Verdict: The TUI has zero hard-coded color violations.** The theme seam is rigorously maintained. `themeCoverage.test.ts` enforces this by failing if any `.tsx` file consumes colors without importing the theme module.

### Spacing and Borders

- **Padding**: Exclusively hard-coded numeric values (`paddingX={1}`, `paddingX={2}`, `paddingY={1}`, `marginX={2}`, `marginTop={1}`). No spacing token system exists. Values are consistent but not centrally configurable.
- **Borders**: 23 `borderStyle=` usages across components, using three styles:
  - `"round"` — settings/informational modals (Model, Effort, Summary, Sessions, Metrics, Limits, etc.)
  - `"single"` — trust dialogs (TrustModal, ApprovalModal), composer palettes
  - `"double"` — high-stakes review (PlanModal, StagedDiffModal)
- **Width**: `width={stdout.columns ?? 80}` used in Composer surface block; otherwise relies on Ink's flexbox.

---

## 3. Slash-Command Surface

### Built-in Commands

Defined at `Composer.tsx:46-71` as `const SLASH_COMMANDS: SlashCommand[]`:

| # | Command | Description | Help Text Location | Dispatch Location |
|---|---------|-------------|-------------------|-------------------|
| 1 | `/help` | Show key bindings and commands | `Composer.tsx:47` | `Composer.tsx:264-267` |
| 2 | `/exit` | Exit zone | `Composer.tsx:48` | `Composer.tsx:269-271` |
| 3 | `/clear` | Clear transcript | `Composer.tsx:49` | `Composer.tsx:273-275` |
| 4 | `/cost` | Show session cost | `Composer.tsx:50` | `Composer.tsx:277-282` |
| 5 | `/permissions` | View/remove trusted command prefixes | `Composer.tsx:51` | `Composer.tsx:284-287` |
| 6 | `/keys` | Manage API keys (BYOK) | `Composer.tsx:52` | `Composer.tsx:289-292` |
| 7 | `/sessions` | Browse/resume past sessions | `Composer.tsx:53` | `Composer.tsx:294-302` |
| 8 | `/resume` | Resume most recently interrupted run | `Composer.tsx:54` | `Composer.tsx:304-313` |
| 9 | `/init` | Scaffold .zone/memory.md by analyzing repo | `Composer.tsx:55` | `Composer.tsx:315-325` |
| 10 | `/memory` | Show .zone/memory.md | `Composer.tsx:56` | `Composer.tsx:327` |
| 11 | `/model` | Choose AI model | `Composer.tsx:57` | `Composer.tsx:329-334` |
| 12 | `/effort` | Set reasoning effort | `Composer.tsx:58` | `Composer.tsx:336-341` |
| 13 | `/summary` | Set summary format | `Composer.tsx:59` | `Composer.tsx:343-348` |
| 14 | `/plan-mode` | Set plan depth | `Composer.tsx:60` | `Composer.tsx:350-355` |
| 15 | `/session` | Toggle session memory | `Composer.tsx:61` | `Composer.tsx:357-362` |
| 16 | `/metrics` | View run telemetry KPIs | `Composer.tsx:62` | `Composer.tsx:364` |
| 17 | `/limits` | Set daily USD cap | `Composer.tsx:63` | `Composer.tsx:366-371` |
| 18 | `/commit` | Commit last run's changes | `Composer.tsx:64` | `Composer.tsx:373-382` |
| 19 | `/autocommit` | Toggle auto-commit after runs | `Composer.tsx:65` | `Composer.tsx:384-396` |
| 20 | `/websearch` | Toggle web search | `Composer.tsx:66` | `Composer.tsx:398-412` |
| 21 | `/image` | Attach image to next task | `Composer.tsx:67` | `Composer.tsx:414-433` |
| 22 | `/remote-control` | Start/stop remote control server | `Composer.tsx:68` | `Composer.tsx:435-450` |
| 23 | `/undo` | Undo last run (restore files) | `Composer.tsx:69` | `Composer.tsx:453-455` |
| 24 | `/feedback` | Send bug report / feedback | `Composer.tsx:70` | `Composer.tsx:437-449` |

### User-Defined Commands

| Aspect | Details |
|--------|---------|
| **Source** | `.zone/commands/*.md` files in the project directory |
| **Loader** | `userCommands.ts` — `loadUserCommands()` reads markdown files with optional YAML frontmatter |
| **Format** | Frontmatter `description:` key (optional), body becomes the task prompt |
| **Variable** | `$ARGUMENTS` in body is replaced with text after the command name |
| **Limit** | 50 files max, 16KB per file, name must match `[a-z0-9][a-z0-9-]*` |
| **Collision** | Built-in commands take priority — user commands with the same name are silently ignored |
| **Help text** | From frontmatter `description:`, falling back to first non-empty body line (≤60 chars) |

### Help Text System

- **Palette descriptions**: Inline in the `SLASH_COMMANDS` array (`Composer.tsx:46-71`) — each entry has a `desc` field
- **`/help` output**: Hard-coded `HELP_LINES` array (`Composer.tsx:74-83`) listing all keybindings and commands
- **Palette rendering**: `SlashCommandPalette` internal component in `Composer.tsx` — shows filtered list with selection highlight

### Flags

| Issue | Details |
|-------|---------|
| **`/resume` not in HELP_LINES** | The `/help` output lists 22 commands but the full list includes `/resume` — it IS present in both SLASH_COMMANDS and HELP_LINES (line 83). No undocumented commands. |
| **No `/plan` alias** | `/plan-mode` is the command for plan depth; there is no `/plan` shortcut. Users must type the full name. |
| **Argument-taking commands** | Only `/image <path>` and `/remote-control <args>` accept arguments from the slash line. User commands use `$ARGUMENTS`. No other command documents its argument behavior. |
| **`/undo` has no confirmation in the command itself** | Dispatches `onUndoRequest()` which triggers the UndoModal — confirmation happens there. |

---

## 4. Modal-vs-Inline Policy

### Rendering Model

The TUI uses **inline scrollback** (`alternateScreen: false`). "Modals" are **NOT** alternate-screen overlays — they are bordered `<Box>` elements rendered inline in the terminal flow. When a modal opens, it scrolls into view below the transcript. When closed, it disappears and the transcript continues below.

### Modal Border Style Matrix

| Component | Border Style | Border Color | Mount Strategy | File:Line |
|-----------|-------------|-------------|----------------|-----------|
| ApprovalModal | `single` | `role.caution` | Conditional (`state.pendingApproval !== null`) | `ApprovalModal.tsx:61` |
| TrustModal | `single` | `role.caution` | Conditional (`state.pendingApproval?.kind === "trust"`) | `TrustModal.tsx:26` |
| HookTrustModal | `round` | `role.caution` | Conditional (`state.pendingHookTrust !== null`) | `HookTrustModal.tsx:38` |
| McpTrustModal | `round` | `role.caution` | Conditional (`state.pendingMcpTrust !== null`) | `McpTrustModal.tsx:31` |
| PlanModal | `double` | `role.accent` | Conditional (`state.planProposal !== null`) | `PlanModal.tsx:30` |
| StagedDiffModal | `double` (outer) + `single` (inner) | `role.accent` | Conditional (`state.stagedDiffProposal !== null`) | `StagedDiffModal.tsx:87,107` |
| PlanActionPrompt | `single` | `role.accent` | **Always mounted**, self-gates on `proposal === null` | `PlanActionPrompt.tsx:115` |
| ModelModal | `round` | `role.accent` | Conditional (`modalView === "model"`) | `ModelModal.tsx:134` |
| EffortModal | `round` | `role.accent` | Conditional (`modalView === "effort"`) | `EffortModal.tsx:58` |
| SummaryModal | `round` | `role.accent` | Conditional (`modalView === "summary"`) | `SummaryModal.tsx:50` |
| PlanModeModal | `round` | `role.accent` | Conditional (`modalView === "planMode"`) | `PlanModeModal.tsx:51` |
| SessionMemoryModal | `round` | `role.accent` | Conditional (`modalView === "session"`) | `SessionMemoryModal.tsx:58` |
| MetricsModal | `round` | `role.accent` | Conditional (`modalView === "metrics"`) | `MetricsModal.tsx:92` |
| LimitsModal | `round` | `role.accent` | Conditional (`modalView === "limits"`) | `LimitsModal.tsx:51` |
| SessionsModal | `round` | `role.accent` | Conditional (`modalView === "sessions"`) | `SessionsModal.tsx:36` |
| PermissionsView | `round` | `role.accent` | Conditional (`modalView === "permissions"`) | `PermissionsView.tsx:28` |
| ApiKeysView | `round` | **`role.caution`** | Conditional (`modalView === "keys"`) | `ApiKeysView.tsx:198` |
| CommitModal | (uses `useInput`, renders inline) | — | Conditional (`modalView === "commit"`) | `CommitModal.tsx` |
| FeedbackModal | (uses `useInput`, renders inline) | — | Conditional (`modalView === "feedback"`) | `FeedbackModal.tsx` |
| UndoModal | `round` | `role.caution` | Conditional (`modalView === "undo"`) | `UndoModal.tsx:46` |
| Toast | (no border — auto-dismiss overlay) | — | Conditional (`state.toastQueue.length > 0`) | `Toast.tsx` |

### Consistency Analysis

| Aspect | Finding |
|--------|---------|
| **Border style consistency** | ✅ Settings modals use `round`, trust/approval use `single`, high-stakes review uses `double`. Clear semantic mapping. |
| **Border color: `caution` vs `accent`** | ⚠️ `ApiKeysView` uses `role.caution` (yellow) despite being structurally a settings view — the theme.ts docstring flags this explicitly as a known inconsistency left for a future palette pass. All other settings modals use `role.accent` (cyan). |
| **PlanActionPrompt always-mounted** | ⚠️ Unlike every other modal, `PlanActionPrompt` is always in the React tree and self-gates via `proposal === null` returning empty JSX. This means its hooks (including `useInput`) are always registered, though they early-return when no proposal exists. |
| **CommitModal/FeedbackModal** | These don't use `borderStyle` — they render as plain `<Box>` content without visible borders. Inconsistent with other modals. |
| **No dimmed background** | Modals render in the normal flow — there's no overlay or dimming of the transcript behind them. The transcript continues above and the modal scrolls into view. This is inherent to inline scrollback. |
| **Composer blocked** | When any modal is active, the Composer's `useInput` returns early (`Composer.tsx:511`), preventing any text input. This is correct — only the modal's own bindings are active. |

---

## 5. Resize, Unicode-Width, and Mouse Handling

### Resize Handling

**Handler location:** `index.tsx:1415-1432` (inside `runTui()`)

```
process.stdout.on("resize") → 100ms debounce → shouldRedrawOnResize(prevCols, nextCols)
```

**Logic (`resize.ts`):**
- `shouldRedrawOnResize()` at `resize.ts:24` — returns `true` on ANY column change (narrowing OR widening). Height-only resizes return `false`.
- `applyResizeRedraw()` at `resize.ts:42` — writes `CLEAR_SCREEN_AND_SCROLLBACK` (`\x1b[2J\x1b[3J\x1b[H`) then dispatches `TRANSCRIPT_REMOUNT`.
- `TRANSCRIPT_REMOUNT` bumps `transcriptGeneration` in the store, causing `<Static>` in `Transcript.tsx` to remount and re-emit all entries at the new width.

**Known behavior:**
- **Destructive clear**: Resize wipes the entire terminal scrollback (native history). The comment in `index.tsx:1416-1420` acknowledges this: "the cost of acting on it is that widening now discards native scrollback too."
- **Order-sensitive**: Clear must happen BEFORE remount — clearing after would wipe the fresh copy. `resize.ts:48` asserts this order.
- **100ms debounce**: Prevents rapid-fire redraws during window drag-resize.

### Unicode-Width Handling

**Zone has NO custom unicode-width handling.** The TUI delegates entirely to Ink's internal layout engine (Yoga flexbox), which handles character width via the `string-width` and `wrap-ansi` packages.

| Aspect | Status | Details |
|--------|--------|---------|
| **Character width** | Delegated to Ink | Ink uses `string-width` package internally for text measurement |
| **CJK / wide characters** | Delegated to Ink | No Zone-specific handling |
| **Emoji** | Delegated to Ink | No Zone-specific handling |
| **Cursor positioning** | **Potential gap** | Composer uses `bufferRef.current.length` for cursor position (character count, not visual width). On wide characters, the visual cursor and the tracked position may diverge. |
| **`strip-ansi` usage** | Test-only | Referenced in `PlanBody.test.tsx:193` for test normalization |
| **`wcwidth` / `east-asian-width`** | Not used | Zero imports of these packages anywhere in the codebase |

**Known gap:** The Composer's cursor (`cursorRef`) tracks byte offset in the buffer string, not visual column position. If a user types a CJK character (2 columns wide) or an emoji (1-2 columns wide depending on terminal), the rendered cursor (`▋`) may appear at the wrong visual position. Ink's `Text` component renders the character at its correct width, but the cursor insertion point is calculated from string index.

### Mouse Handling

**Zone has NO mouse handling whatsoever.**

| Aspect | Status |
|--------|--------|
| **`useMouse` hook** | Not used — not imported from Ink or any other library |
| **Click events** | None — no `onClick` handlers in any component |
| **Scroll events** | None — no scroll-wheel handling |
| **Raw mouse mode** | Not enabled — no `\x1b[?1000h` or similar escape sequences |
| **Terminal mouse reporting** | Not requested |

The only mouse-related code is a comment in `StatusBar.tsx:91`:
> "is what was destroying mouse selection during plan approval"

This suggests the team is aware that their UI can interfere with the terminal's native mouse text-selection, and has taken care NOT to break it.

### Known Gaps Summary

| Gap | Severity | Details |
|-----|----------|---------|
| **No unicode-width cursor tracking** | Medium | Composer cursor uses string length, not visual width. Wide characters (CJK, some emoji) will cause visual misalignment. |
| **Resize destroys scrollback** | Low-Medium | Every column change clears native terminal history. Documented and accepted, but data-losing. |
| **No mouse interaction** | Low | Expected for a terminal coding agent — keyboard-first is the design. Native text selection is preserved. |
| **No `isTTY` guard on resize** | Low | `index.tsx:1421` — `if (process.stdout.isTTY)` guards the resize listener, but the initial `prevCols` assignment at `:1419` uses `process.stdout.columns ?? 80` outside the guard. |
| **Height-only resize ignored** | Low | By design — column-only changes trigger redraw. But if a user's terminal height changes in a way that affects visible content (e.g., status bar clipping), no redraw occurs. |
| **No TERM-specific handling** | Low | No special behavior for `dumb`, `xterm-256color`, or other terminal types beyond what Ink handles internally. |
