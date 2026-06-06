# DESIGN — First-class git capabilities (read-awareness + commit)

**Status:** Design proposal, code-grounded (file:line). NO source changed. Builds on the capability-map recon earlier in this work stream.

**Goal:** move Zone from *git-blind-unless-asked* toward Claude-Code-like parity: (1) the agent proactively **reads** git (log/diff/show/blame) for recent-change context, and (2) a first-class, opt-in **/commit** that commits the run's changes with a generated message — safely, after staging is flushed, scoped to only the files the run touched.

---

## Part 1 — Current git surface (verified)

### Read surface

| Path | Auto-approves | Evidence |
|---|---|---|
| `run_command` (main patch tool) → command-approval gate | `git status`, `git diff`, `git log` (prefix match, so `git log -n 10 --oneline` etc. also pass) | `SAFE_COMMAND_PREFIXES.git = ["git status", "git diff", "git log"]` — `commandApprovals.ts:20-21` |
| `run_command` — other git reads (`show`, `blame`, `branch`, `remote`, `rev-parse`) | **Not** auto-approved → fall through to **user approval** (not blocked) | `getSafeCommandCategory` returns null → pending approval |
| `run_command_readonly` (separate tool) → `checkCommandSafe` strict whitelist | `git status/diff/log/show/branch` — and runs with **NO approval prompt at all** (executes directly, `cwd: repoPath`) | branch at `toolExecutor.ts:961-1020` (no `onApprovalRequired` call); whitelist in `runCommandSafe.ts` (`git log/diff/status/show/branch`) |

So safe git reads are *possible*, and via `run_command_readonly` they're **frictionless** (zero prompts). But `blame`, `remote`, `rev-parse` are in neither auto-path.

### Is the agent told it can read git?

- **Patch agent** (`assembleAgentSystemPrompt`): **no git mention at all.** No proactive guidance to consult history/diffs. (grep `"git "` in `agentLoop.ts` → only the investigation block.)
- **Investigation agent** (`assembleInvestigationSystemPrompt`, `agentLoop.ts:686`): one passing line — "`run_command_readonly`: … read-only git inspection … (e.g. … 'git diff')". Mentions capability; doesn't *encourage* using git for recent-change context.
- **Tool descriptions:** `run_command` lists "git status" as an example use (`toolDefinitions.ts:26`); `run_command_readonly` says "inspect git state" (`toolDefinitions.ts:534,541`).

**Verdict: git-blind-unless-asked.** The agent *can* read git (and frictionlessly via `run_command_readonly`), but it is never directed to use git to understand *recent changes / regressions / "what changed"* the way Claude Code does. Reads happen only if the user's task explicitly asks.

### Write surface

- git mutations are **not** in the `run_command` hard blocklist — `isBlockedCommand = ["rm -rf /","format","del /f /s","DROP TABLE","DROP DATABASE"]` (`toolExecutor.ts:316-321`). Via `run_command` they fall to **user approval** and execute if approved / trusted-for-run / under autoAccept.
- `run_command_readonly` **blocks** all mutations (`checkCommandSafe` blacklist).
- **No first-class commit.** No `/commit`. The only way to commit today is coaxing the agent to `run_command("git commit …")` mid-run — which is unsafe (next section) and unscoped.

### The cardinal constraint: commit must be POST-run

`run_command` executes inside `withStagingTempFlush` (`toolExecutor.ts:639`): it **temporarily** writes the in-memory staging map to disk, runs the command, then **restores** the working tree in a `finally`. The real, durable write is `finalizeStaging` at run end. So a **mid-run** `git add && git commit` captures the temp-flushed content into a commit, then the working tree is reverted under it → **HEAD/worktree divergence** until finalize. Therefore any commit must happen **after the run completes and `finalizeStaging` has flushed** — never as an agent tool call mid-run.

---

## Part 2 — Gap vs parity

**Read-awareness needs:** (a) prompt guidance directing the agent to consult git for recent-change context *when relevant*; (b) the safe read subcommands (`show`, `blame`, `rev-parse`, `branch`, `remote`) auto-approving frictionlessly; (c) optionally a bounded "recent changes" context block.

**Commit needs:** an opt-in, post-run, **scoped** `/commit` that (1) stages only the run's files, (2) generates a message from the run's summary, (3) surfaces it for approval/edit, (4) commits without sweeping in unrelated staged changes; plus an optional `commitOnSuccess`.

---

## Part 3 — Phased design

### Phase 1 — Read-awareness (lightest levers first)

**1a. Widen the safe-read git allowlist** (state-safe reads only).
- `commandApprovals.ts:20-21` `SAFE_COMMAND_PREFIXES.git`: add `git show`, `git blame`, `git branch`, `git remote`, `git rev-parse`. (Prefix-match already covers flags, so `git log`/`git diff` cover their bounded `-n`/`--stat` forms.)
- `runCommandSafe.ts` `WHITELIST_PREFIXES` (for `run_command_readonly`): add the same (`git blame`, `git rev-parse`, `git remote`). Keep the mutation blacklist intact.
- Cost: zero tokens; pure friction removal. Risk: none — all are read-only/state-safe (`git remote` without args lists; `git remote -v` reads; do **not** add `git remote add/set-url`, which the prefix-match would *not* admit anyway since they're longer prefixes — note the meta-char/blacklist guards still apply).

**1b. Patch-prompt "GIT CONTEXT" directive** (the real parity lever).
- Add ~5 lines to `assembleAgentSystemPrompt` in the **patch/else branch** (NOT the Q&A/investigation branch — same scoping lesson as BREVITY RULES at `agentLoop.ts`; Q&A wants explanation not action). Content, bounded:
  > GIT CONTEXT — when the task involves recent changes, a regression, or "what changed": consult git before reading broadly. Use bounded reads: `git log -n 10 --oneline`, `git diff --stat` (then a targeted `git diff -- <path>` or `git show <ref> -- <path>` only for the relevant file), `git blame -L <range> -- <path>`. Never dump a full repo-wide `git diff`. Skip git entirely when the task has no historical dimension.
- Cache: this is **static** text in the cached system prefix → a one-time prefix change (constant across runs; does not vary per run, so it does not bust the cache per-iteration). Acceptable.
- Cost: spent **only when the agent actually runs git** (targeted by the directive), and each read is bounded (`-n`, `--stat`, path-scoped). No per-turn overhead.

**1c. (Deferred / optional) auto-injected "recent changes" block.**
- Could prepend `git log -n 5 --oneline` + `git diff --stat` into the first user message (like the SESSION MEMORY block). **Recommend against by default**: it adds tokens to *every* run regardless of relevance, the opposite of the targeted 1b approach. Leave history-reading to the agent's judgment via 1b. If ever added, make it opt-in and `--stat`-only (bounded).

### Phase 2 — `/commit` (post-run, scoped, opt-in)

**Trigger & UX (mirror `/summary`, `/session`):**
- New `/commit` slash command: `Composer.tsx` `SLASH_COMMANDS` + `executeSlashCommand` case + a `CommitModal` + store action/modalView. **Blocked during an active run** (like other modals).
- `CommitModal`: shows the **generated message (editable)** and the **scoped file list**; `A` = commit, `E` = edit message, `Esc` = cancel.

**Scope source (the correctness crux):**
- Use the **last run's `result.fileDiffs[].filePath`** — the authoritative set of files the run wrote, derived from `loop.filesModified` (`runLlmPatchFlow.ts:6026, 6065`; type `FileDiff` at `:368`, on the `ok` result at `:284`). The TUI already captures `runResult` in `runPrompt` (added in the session-memory work) — stash the last successful result's `fileDiffs` + `patchPreview` in a store field / ref for `/commit` to read.
- **Never** `git add .` / `git add -A` / `git diff --name-only` (those capture the user's unrelated edits). Reverted files are already excluded (`filesModified.delete` on revert, `agentLoop.ts:3035`).

**Message generation:**
- Derive mechanically from `stripBanner(result.patchPreview)` (the FINAL SUMMARY — `## What changed` / `## Why`; `stripBanner` helper already exists from the session-memory work). Subject = a one-line distillation of `## Why` / first change; body = the `## What changed` bullets. **No LLM cost in v1.** (Optional later: a single cheap formatting pass to a conventional-commit subject — note ~$0.01, one call, opt-in.)

**Execution (TUI-side, not an agent tool):**
- Shell out directly like the `!` escape in `index.tsx` `runPrompt` (`execAsync`), with **`cwd: config.repoPath`** — NOT `process.cwd()` (the same R3 trap that bit session-memory: under `--repo`/`ZONE_REPO_PATH` they diverge). `fileDiffs` paths are repo-relative → correct against `repoPath`.
- Commands: `git -C <repoPath> add -- <files>` then a **pathspec-scoped commit** `git -C <repoPath> commit --only -- <files>` with the message via `-F -`/temp file (avoids quoting issues). The pathspec/`--only` form commits **only** the named paths, so a user's **pre-existing staged unrelated changes are not swept in** (a plain `git commit` after `git add` would commit them).
- The `/commit` confirmation modal **is** the approval — no `run_command` approval gate involved (this is a user-initiated TUI action, not an agent dispatch).

**Optional `commitOnSuccess` setting:**
- `DiskModelSettings.commitOnSuccess?: boolean` (mirror `memoryEnabled`/`summaryFormat`; keep `version: 2`), default **OFF**. When on, post-run auto-runs the scoped commit and shows a toast (still scoped, still post-finalize). A `/commit` toggle row or a `/commit auto` form sets it.

**Safety envelope (v1):** scoped `add` + scoped `commit` only. **No** push, force, branch, checkout, reset, merge, rebase. No `git add .`/`-A`.

---

## Adversarial risks

| Risk | Severity | Mitigation |
|---|---|---|
| **withStagingTempFlush divergence** — a mid-run commit captures temp-flushed content, then the worktree is restored → HEAD≠worktree | High | **Cardinal rule:** `/commit` is a **post-run TUI action**, never an agent tool, never mid-run. Runs after `finalizeStaging`. |
| **Scoped-add over-capture** — `git add .`/`-A` or `git diff --name-only` would stage the user's unrelated edits | High | Stage only `result.fileDiffs[].filePath`; commit with `--only -- <paths>` so even pre-staged unrelated changes aren't committed. |
| **repoPath vs process.cwd()** — git run in the wrong dir under `--repo`/`ZONE_REPO_PATH` | High (silent) | `git -C config.repoPath`; paths are repo-relative. |
| **Pre-existing staged changes** committed accidentally | Med | Pathspec-scoped `commit --only -- <paths>` (does not commit the rest of the index). |
| **Not a git repo / no HEAD / detached / mid-rebase** | Med | Guard with `git rev-parse --is-inside-work-tree`; allow initial commit; refuse during rebase/merge state with a clear message. |
| **Deletions** — agent deleted a file | Low | `git add -- <path>` stages deletions in modern git; include reverted-file exclusion (already handled). Note as an edge to verify. |
| **Stale / absent scope** — `/commit` with no run this session, or manual edits after the run | Low/Med | If no captured `fileDiffs`, refuse and show `git status`. Manual edits to the *agent's* files are committed as current disk state (expected); unrelated files stay untouched (scoped). |
| **Read-awareness token bloat** — unbounded `git diff` dumps | Med | 1b directive mandates `--stat`-first, `-n` caps, path-scoped `show`/`blame`; no auto-injected per-run history block (1c deferred). |
| **Concurrency** — `/commit` during an active run | Low | Block `/commit` while `runState === "running"` (like other modals). |

---

## Phasing summary

- **Phase 1 (read-awareness):** `commandApprovals.ts` + `runCommandSafe.ts` allowlist widen (friction) + a bounded "GIT CONTEXT" directive in the patch prompt (the parity lever). Cheap, low-risk, no new tooling.
- **Phase 2 (/commit):** TUI command + `CommitModal`, scoped to `result.fileDiffs`, message from `patchPreview`, executed post-run via `git -C repoPath … commit --only -- <paths>`, behind explicit approval; optional `commitOnSuccess`. Reads are state-safe; the only mutation is the scoped, approved, post-run commit. No push/force/branch in v1.
