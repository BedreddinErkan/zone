# Change Log

All notable changes to Zone are documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [2.1.0] — 2026-08-24

431 commits since 2.0.0 (`efc8e758`). Every claim below names the commit or the
`docs/deferred-work.md` item it comes from, so a reader can check it.

> **Note on the version number.** This release removes two CLI flags that shipped in 2.0.0
> (see **Removed**). By semver that is a breaking change and would warrant a major bump; the
> release is published as a minor. If you script `zone --role` or `zone --add-dir`, read
> **Removed** before upgrading.

### Added

- **Durable tool-call record** (`9c9a6b80`, item 286) — every tool call now leaves a record in
  `~/.zone/tool-calls.jsonl`, written independently of the debug gate. One record per call,
  including calls rejected before execution, carrying the absolute path, the outcome and the
  reason. Health travels alongside it on each cost-log `run_summary` as `toolCallsAttempted` /
  `toolCallsDropped`, so an empty sink is distinguishable from a writer failure.
- **`--max-turns <n>`** (`dfa733be`) — a real per-run ceiling on main-loop agent turns. It is
  clamped after the tier block and again at soft promotion, so it holds rather than being
  overwritten by the tier-sized iteration budget; subagents keep their own budgets.
- **`--max-budget-usd <n>`** (`6e128cef`) — a per-run spend ceiling in USD, enforced during the
  run rather than reported after it.
- **Narrative execution plans** (`aca64aa7`) — the execution plan is now free-form prose with a
  small machine-readable sidecar, instead of a rigid step schema.
- **Themed TUI surface** (`f39ce482`, `0f4759f5`, `2cc77a6e`, `3414ad4b`) — colour and glyph
  choices moved behind a single theme seam across the component tree; the diff view moved from
  red/green foreground to a dark-surface, teal-marker, weight-based hierarchy.

### Fixed

- **Cross-file reference lookup was substantially broken and now works** (items 288, 289, 290) —
  three independent defects in the dependency graph: an ESM `.js` specifier was never mapped back
  to its `.ts` source, so almost no source-to-source import resolved; analysis stopped at 300
  files, leaving 670 of 960 tracked sources without a node; and the enumeration was unsorted, so
  which files the graph contained changed between runs. `find_references` results should now be
  materially more complete. One related truncation remains open and is recorded as item 296: the
  graph reads only the first 200 lines of each file, so imports past that line are still dropped.

### Removed

- **`--role <role>`** (`2efee011`) — the role flow (`developer` / `test_engineer` /
  `data_analyst`) and its entry point were removed along with the `roles/` and prompt trees behind
  them. There is no replacement flag; the default flow supersedes it.
- **`--add-dir <path...>`** (`dfa733be`) — removed as part of the same pass that implemented
  `--max-turns`. It was accepted but never wired to anything.

Both flags were registered options in 2.0.0. Scripts passing either will now fail with an unknown
option error rather than silently ignoring it.

Separately, three flags that were accepted-but-inert are now **labelled** as such in `--help`
rather than removed (`dfa733be`): `-n, --name`, `--fork-session`, and — at that commit —
`--max-budget-usd`, which was implemented shortly afterwards at `6e128cef`.

### Security

Zone's containment property is that **a write or a read lands only where the user's approved plan
named**. This is not an attacker model: you run Zone on your own repository with your own key. The
defects below are cases where that property did not hold — a patch plan naming a path Zone should
have refused could reach a file outside the repository, or a protected file inside it.

Four fixes across three call paths:

- **`core/applyLlmPatches.ts`** (`2452803e`, item 301) — the containment check was a lexical string
  comparison, blind to symlinks. An in-repo symlink pointing outside the repository passed it and
  the write followed the link. It now routes through the shared realpath-based boundary check.
- **`apply/applyPatchPlan.ts`** (`3c6362e1`, item 304 site 2) — this path had no containment check
  of any kind and no repository root in scope. An absolute path, a `../` traversal and an in-repo
  symlink all wrote outside the repository, and the function reported success. It now resolves the
  target against the repository root and refuses anything that escapes.
- **`patch/validatePatchPlan.ts`** (`a9b91f75`, items 309 and 310) — two defects in one validator.
  Its boundary check was lexical, so an in-repo symlink escaped it both as a read (the outside
  file's contents were copied into `.agent-patches/`, and under apply mode into `.agent-backups/`)
  and as a write (a symlink pointing at a *non-existent* outside path took the create branch and
  created that file). Separately, the protected-file list — `.env`, lockfiles, `.github/workflows/`,
  `.git/` — classified an unresolved path while the boundary check resolved one, so `./.env`,
  `src/../.env` and `.//.env` were not recognised as `.env` and validated clean. Both now work from
  the same resolved path.

**Reachability, measured rather than asserted.** These paths are not the default. Reaching them
requires an interactive terminal with no positional task, the deprecated `--task` flag, and
`--mode dry-run` or `--mode apply` — note that `--mode dry-run` is a different option from
`--dry-run`, and only the former reaches this code. The default `--mode preview` never does. If you
run Zone the documented way — `zone "your task"` — none of these paths execute.

**What is not claimed.** These fixes close the defects named above. They do not make containment
complete, and several related gaps remain open and recorded: items 300, 303, 304 (sites 3 and 4),
and 311.

## [2.0.0] — 2026-08-03

### Added — Phase K.5: Organization policy stub (single-tenant)

- **`ZONE_ORG_POLICY_PATH` env var** — path to a JSON policy file. Policy takes precedence over per-user and env caps (policy > user_override > env > default).
- **Currently enforced:** `dailyUsdCap` — org-level daily spend ceiling that cannot be overridden by users.
- **Schema-accepted, enforcement Phase M:** `monthlyUsdCap`, `allowedTiers`, `maxSubagentCallsCap`, `autoAuditRequired`. Accepted without error; logged as `[zone-policy-unsupported-field]` so Phase M can add enforcement without a schema migration.
- Telemetry: `[zone-policy-loaded]` (ok/source/reason), `[zone-policy-applied]` (appliedFields / unsupportedFields) per top-level dispatch.
- Missing or invalid policy file: run continues with K.1 chain (warn-only, no hard failure).

### Added — Phase K.1: Daily USD cap

- **`ZONE_DAILY_USD_CAP` env var** — set a per-user rolling 24-hour spend ceiling (USD). `0` or `-1` = unlimited. Default: `$10.00`.
- **`dailyUsdCapOverride` in `~/.zone/tier-limits.json`** — per-user override; wins over the env var. `0` = unlimited.
- Pre-run enforcement gate in `agentLoop`: checks today's spend before the first iteration; returns `terminationReason: "daily_usd_cap_exceeded"` when the cap is hit. Subagent loops are never gated (parent enforces the budget).
- Telemetry: `[zone-daily-usd-status]` log line emitted on every top-level dispatch (cap, source, spent).

- Initial release
