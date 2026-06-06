# DESIGN — User-defined slash commands (`.zone/commands/*.md`)

Roadmap #4. Status: **IN PROGRESS** (TUI-only, ~$0).

## TL;DR

Let users drop `.zone/commands/refactor.md` into a repo and get a `/refactor` command whose **markdown
body is injected as the task prompt** — exactly as if they had typed it. Claude Code parity for
project-specific commands.

The build is small and almost entirely **additive**, because both halves already exist:
- The **slash palette** (`Composer.tsx`) already filters/matches/executes a list of `{name, desc}`
  commands. We merge a per-repo list into it.
- The **task path** a typed prompt takes (`dispatch(USER_PROMPT) → onSubmit(text, ac, mode) →
  runPrompt → runOneShotInner → runLlmPatchFlow`) is the exact path a fired command body reuses.

> **The only genuinely new wiring:** a `.zone/commands/` loader (mirrors the existing `.zone/`
> repoPath loaders), a `userCommands` store slice (mirrors `trustedPrefixes`), and one branch in
> `executeSlashCommand` that fires a command body as a task instead of opening a modal. No agent
> change, no tool, no system-prompt/cache impact.

**Top open decision (needs Bedo):** `.zone/` is fully **gitignored** (`.gitignore:18`; `/init`
appends `.zone/` too), so `.zone/commands/*.md` would **not be shareable via the repo** — defeating
"project commands committed for the team." See §H.1.

---

## (a) The existing slash-command system

All in `src/cli/tui/components/Composer.tsx`.

**The registry** — `SLASH_COMMANDS: {name, desc}[]` (`Composer.tsx:27-46`), 18 built-ins
(`/help /exit /clear /cost /permissions /keys /sessions /init /memory /model /effort /summary
/session /metrics /limits /commit /autocommit /websearch`). `HELP_LINES` (`:48-58`) duplicates the
list as text (hand-synced).

**The palette** (`:97-112`, render `:69-82`, input `:295-319`):
- Opens when `buffer.startsWith("/")`; filter = `buffer.slice(1).toLowerCase()`.
- `filteredCommands = SLASH_COMMANDS.filter(c => c.name.slice(1).startsWith(paletteFilter))`.
- ↑/↓ move `paletteIdx`; Enter runs `executeSlashCommand(filtered[paletteIdx].name)`; Esc clears.
- Exact-match fast path: `if (key.return && SLASH_COMMANDS.some(c => c.name === buffer))
  executeSlashCommand(buffer)`.

**The dispatcher** — `executeSlashCommand(name)` (`:114-256`): clears the buffer, then a `switch`.
Three behaviour shapes: open a modal (`dispatch MODEL_MODAL_OPEN`…), display info into the
transcript (`/help`, `/cost` → `USER_PROMPT`), or mutate+persist (`/autocommit`, `/websearch`).

**The `disabled` gate** — `disabled = state.runState === "running"` (`:87`). Slash editing/execution
stay live during a run; **task submission is blocked**. State-mutating built-ins self-guard
(`if (disabled) { dispatch USER_PROMPT "Cannot … while a run is in progress"; break; }`).

**Adding a built-in today touches up to 9 sites** (array, HELP_LINES, switch case, + StoreAction,
reducer, modal component, App.tsx render, ComposerProps, tests). User commands deliberately avoid
that surface — they're **data**, loaded into one store field, not code.

**Key execution finding:** **no built-in injects a task.** Every built-in opens a modal, prints to
the transcript, or toggles a setting — none call `onSubmit`. So "command body becomes a task" is new
behaviour, but the mechanism is already sitting in `submitBuffer` (`:258-275`):

```ts
dispatch({ type: "USER_PROMPT", text: trimmed });
const ac = new AbortController();
onSubmit(trimmed, ac);            // → App.handleComposerSubmit → onSubmit(text, ac, state.mode)
```

A fired user command runs exactly these two lines with `body` instead of `trimmed`.

---

## (b) The `.md` → command mapping + v1 scope

### Mapping

| Source | Becomes |
|---|---|
| `.zone/commands/refactor.md` (filename, `.md` stripped, lowercased) | command name `/refactor` |
| optional frontmatter `description:` | palette `desc` (fallback: first non-blank body line, ≤60 chars) |
| file body (after frontmatter) | the injected task prompt |

A command file:
```md
---
description: Tighten a file without changing behaviour
---
Refactor the file I describe for clarity and dead-code removal. Do not change behaviour;
keep the public API stable; run the test suite before finishing.
```

### v1 scope (recommended — minimal + cheap frontmatter)

- **Filename → `/name`.** Name derived from basename, lowercased; validated `^[a-z0-9][a-z0-9-]{0,31}$`.
- **Body → prompt**, injected verbatim as the task.
- **Optional `description:` frontmatter** — a ≤5-line dependency-free parser (if the file starts with
  `---`, read `key: value` lines until the next `---`; only `description` is read in v1; body = rest).
  Falls back to the first non-blank body line. Frontmatter is cheap and materially improves the
  palette, so it earns its place in v1.

### Deferred (explicit non-goals for v1)

- **`$ARGUMENTS` / `$1 $2` substitution.** Requires changing the matcher from exact-equality
  (`buffer === cmd.name`) to first-token parsing (`/refactor src/foo.ts`), a more invasive palette
  change. Fast-follow (Phase 4). Design the body as a plain string now so substitution slots in later.
- **Subdir namespacing** (`.zone/commands/git/commit.md` → `/git:commit`). v1 reads the flat top
  level only; subdirs ignored.
- **Global `~/.zone/commands/`** (user-level, all repos). v1 is project-local only.
- **`/reload`** without restart. v1 loads once at startup; `/reload` is a trivial fast-follow.
- **Per-command overrides** (model/effort/mode in frontmatter). Deferred.

---

## (c) Loader design — `src/cli/tui/userCommands.ts` (new)

Mirror the **repoPath-keyed, never-throws** pattern of `conversationFilesystemStore.ts`
(`path.join(repoPath, ".zone", …)`, graceful `[]`, malformed entries skipped) — **not** the
HOME-based `diskSessions.ts`. Include a test-injection setter like `_setSessionsDirForTest`.

```ts
export const COMMANDS_RELATIVE_DIR = path.join(".zone", "commands");
export interface UserCommand { name: string; desc: string; body: string; }

let _commandsDirOverride: string | null = null;
export function _setCommandsDirForTest(p: string | null): void { _commandsDirOverride = p; }

export async function loadUserCommands(repoPath: string): Promise<UserCommand[]> {
  // 1. resolve dir (override ?? join(repoPath, COMMANDS_RELATIVE_DIR)); ENOENT → []
  // 2. readdir, keep top-level *.md only (ignore subdirs in v1), cap MAX_COMMANDS=50
  // 3. per file: derive+validate name; parse optional frontmatter description; read body
  // 4. drop invalid names, empty bodies, bodies > MAX_BODY_BYTES (16KB), dup names
  // 5. never throw — on any per-file error, skip that file
}
```

**Bounds/hygiene (loader, not agent-safety):** `MAX_COMMANDS=50`, `MAX_BODY_BYTES≈16KB`, strict name
charset, `.md`-only, top-level-only, dedupe, read-as-text (no execution, no symlink chasing surprise).
Collisions with built-ins are dropped here too (see §D).

**Why repoPath, not `process.cwd()`:** the repoPathTrap (`index.tsx:290` comment) — `config.repoPath`
honours `--repo`/`ZONE_REPO_PATH`; `projectMemory.ts` and the conversation store already key on it.

---

## (d) Merge / precedence rules

- **Built-ins always win.** On name collision, the user command is **dropped** (in the loader) and a
  one-time `[zone-user-commands]` log line notes it. Users must not be able to shadow safety-relevant
  built-ins (`/keys`, `/permissions`, `/model`). No override knob in v1.
- **Palette list** = `[...SLASH_COMMANDS, ...state.userCommands]`. Built-ins first, then user commands.
  User commands render with a dim `(project)` tag (or distinct color) so the source is legible.
- **Matching/filtering** (palette filter, exact-match Enter) operate on the **merged** list. Today's
  code references `SLASH_COMMANDS` directly in three spots (`:filteredCommands`, the `.some()` exact
  match, and the `key.return` guard) — those become the merged `allCommands`.
- **Empty state:** zero user commands → list is byte-identical to today (pure no-op).

---

## (e) Execution path

`executeSlashCommand(name)` gains one branch **before** the built-in `switch`:

```ts
const userCmd = state.userCommands.find(c => c.name === name);
if (userCmd) {
  if (disabled) {                       // a user command IS a task — respect the run gate
    dispatch({ type: "USER_PROMPT", text: `Cannot run ${name} while a run is in progress.` });
    return;
  }
  dispatch({ type: "USER_PROMPT", text: userCmd.body });
  const ac = new AbortController();
  onSubmit(userCmd.body, ac);           // same path as submitBuffer; App injects state.mode
  return;
}
// …existing built-in switch…
```

- **Identical to a typed task.** `onSubmit` → `App.handleComposerSubmit` → `onSubmit(text, ac,
  state.mode)` → `runPrompt` → `runOneShotInner({ task: body })` → `runLlmPatchFlow`. Mode
  (normal/plan/autoAccept) is threaded by App, so a `/refactor` fired in plan mode plans first, just
  like typing the prompt would.
- **Respects `disabled`.** Unlike meta built-ins (allowed mid-run), a user command is a task, so it's
  blocked mid-run exactly like `submitBuffer`.
- **Skip history pollution.** Use a thin helper (`dispatch + onSubmit`) rather than `submitBuffer` so
  a multi-KB body doesn't enter the ↑/↓ input history. (Minor; either is acceptable.)

### Safety

The body is **user-authored = user-trusted**, identical in trust to a typed prompt. Typed prompts get
**zero sanitization** today (confirmed end-to-end: `submitBuffer` trims whitespace, nothing else). So
no extra gating is warranted — and importantly, all the *downstream* protections still apply unchanged:
tool approvals (`commandApprovals.ts`), the write-scope guard, the daily USD cap, verification. A
command body can't do anything a typed prompt can't.

Loader-level hygiene (§C bounds) is about not choking on a pathological directory, not about
distrusting the content.

---

## (f) Cost / cache

**~$0, confirmed.** The loader is a startup `fs.readdir`/`readFile`. A fired body becomes the **first
user message** of a run — the same tokens the user would have typed. Commands are **never** injected
into the system prompt or tool definitions, so there is **no cached-prefix impact** (breakpoint #1
untouched) and no per-run overhead beyond the prompt the user chose to send.

---

## (g) Phased plan + file touchpoints

| Phase | Scope | Files | Tests |
|---|---|---|---|
| **1 — Loader** | `loadUserCommands(repoPath)`, `UserCommand` type, frontmatter parse, bounds, `_setCommandsDirForTest` | `src/cli/tui/userCommands.ts` (new) | `userCommands.test.ts`: name derivation, frontmatter, body, ENOENT→[], caps, collision-with-builtin drop, malformed skip |
| **2 — Store + startup wiring** | `userCommands: UserCommand[]` in `StoreState` + `buildInitialState` + `initialValues`; `loadUserCommands(config.repoPath)` in `runTui` (after model-load); thread `initialUserCommands` through `<App>` → `StoreProvider` | `store.tsx`, `index.tsx`, `App.tsx` | `store.test.tsx`: initialValues populate `userCommands` |
| **3 — Palette merge + execution** | merge built-ins + `state.userCommands` in filter/match/exact-match; `(project)` tag in palette render; user-command branch in `executeSlashCommand` (disabled-guard + dispatch + onSubmit) | `components/Composer.tsx` | `composer.test.tsx`: palette shows a user cmd; firing injects body via onSubmit; blocked mid-run; built-in collision not shadowed |
| **4 — Fast-follow (deferred)** | `$ARGUMENTS`/positional substitution (+ first-token matcher), `/reload`, subdir namespacing, optional global `~/.zone/commands/` | as above + loader | per feature |

Phases 1–3 are the feature. No agent/server/adapter files touched — TUI-only, matching the TodoWrite
port's blast radius.

---

## (h) Rejected alternatives

- **User commands as module-scope `SLASH_COMMANDS` entries.** Rejected — they're per-repo dynamic
  data; they belong in store state (like `trustedPrefixes`/`modelSettings`), loaded at startup.
- **A single `.zone/commands.json` manifest.** Rejected — one-file-per-command `.md` matches Claude
  Code, is diff/PR-friendly, and mirrors `memory.md`'s markdown convention. Markdown bodies are also
  the natural prompt format.
- **Injecting command bodies into the system prompt or as a tool.** Rejected — wrong layer, and it
  would break the ~$0 / no-cache-impact property. A command is a *prompt source*, not agent config.
- **Allowing user commands to override built-ins.** Rejected for v1 — lets a repo shadow
  safety-relevant commands (`/keys`, `/permissions`). Built-ins win; collisions dropped + logged.
- **HOME-based `~/.zone/commands/` for v1.** Rejected as the *primary* store — the win is
  *project-specific* commands; project-local `.zone/commands/` matches that and the existing `.zone/`
  convention. Global is a deferred addition, not the v1 default.

---

## (i) Open decisions (flag for Bedo)

1. **★ gitignore / shareability (the real product call).** `.zone/` is gitignored repo-wide
   (`.gitignore:18`; `/init` appends `.zone/` to target repos too). So `.zone/commands/*.md` is
   **not committed by default** → not shared with the team, which undercuts "project commands."
   Options: **(a)** accept local-only for v1 and document it; **(b)** carve an exception so commands
   are tracked — e.g. have `/init` write `.zone/` followed by `!.zone/commands/`, or place commands at
   a non-ignored path; **(c)** tell users to `git add -f`. *Recommendation:* ship the loader as
   designed (option a for v1 mechanics) **and** flag (b) as the shareability follow-up — but Bedo
   should pick, since it changes the gitignore contract for every repo.
2. **`$ARGUMENTS` in v1 or deferred?** *Recommend deferred* (Phase 4) — it forces the exact-match
   matcher to become a token parser. If "commands that take args" is the headline use-case, promote it.
3. **Built-ins-win vs user-override.** *Recommend built-ins-win* (safety). Confirm.
4. **Project-only vs +global `~/.zone/commands/`.** *Recommend project-only* v1.
5. **Static load vs `/reload`.** *Recommend static* v1; `/reload` is a trivial fast-follow if editing
   commands mid-session is painful.
6. **Palette affordance for user commands.** Dim `(project)` tag vs distinct color vs a divider —
   cosmetic; recommend the `(project)` tag.
