# Change Log

All notable changes to Zone are documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [2.3.0] — 2026-08-28

10 commits since the 2.2.2 release (`e3a4e194`). Every claim below names the commit or the
`docs/deferred-work.md` item it comes from, so a reader can check it.

### Added

- **MCP servers can declare which of their tools to expose** — a `tools` allowlist in
  `.zone/mcp.json` (`ce419b0b`, item 410). Omitted, every tool the server reports still loads:
  measured at 65–67% of an iteration's tokens across two live runs with 24 tools loaded, of which
  only three were ever called. An allowlist entry matching no registered tool (a server rename, for
  example) is reported by `[zone-mcp-tools-filtered]` rather than silently doing nothing.
- **Destructive MCP tool calls now require approval** (`46f1f41f`, item 408). The server declares
  which of its tools mutate; Zone now keeps that declaration instead of discarding it at
  registration, and gates any tool the server calls destructive — or annotates not at all,
  fail-closed. `requireApproval` in `.zone/mcp.json` overrides the server's own claim in either
  direction. A first run of a flow that drives a browser will prompt once per distinct tool it uses;
  approval is per tool and, like command approval, persists across runs in that project ([T]rust).
- **An approved MCP server's tools are now available in every pipeline** (`7e9baeb7`, item 408).
  Before this, MCP tools cleared the tier and capability filters in only one accidental combination
  of task shape and tier — a user who declared and approved a server saw its tools withheld from
  ordinary tasks, with no way to discover why.

### Fixed

- **`--force-tier` now overrides the tier everywhere, not only the iteration budget** (`2876e6e6`,
  items 328, 330). The flag reached the token and iteration budget but not the tool-subset filter a
  forced tier is meant to unlock, so forcing `complex` raised the iteration cap while the
  `simple`-tier tool list stayed in place. The `--help` text already promised this behavior; the
  code now matches it.
- **An OpenAI 429 that means the account is out of credit is no longer retried** (`370607e1`,
  item 411). OpenAI returns the same HTTP 429 for transient rate-limiting and for exhausted quota,
  and Zone retried both alike — burning the retry budget against a condition no wait clears, then
  reporting it as an upstream outage. A quota-exhausted 429 is now reported immediately as a credit
  problem instead.
- **Anthropic credit exhaustion now produces its own message** (`3e052572`, item 413). The mapping
  keyed on HTTP 400, a shape only a gateway produces; direct Anthropic sends 402, which fell through
  unmapped — including on the streaming path the agent loop actually takes on every iteration.
- **A plan-generation prompt template no longer contradicts its own schema** (`80e504bb`, item 409).
  The template listed two subagent-annotation fields as always present while the schema rejected
  `null` for them and the surrounding prose taught omitting them entirely — a model that followed
  the template literally failed validation, silently enough that only verbose logging surfaced it.
  The schema now also accepts a `null` for these two fields and normalizes it to absent.

### Known limitations

- MCP is TUI-only; headless (`--print` / non-TTY) never loads it (item 408).
- Approval trust for an MCP tool is per tool, not per server, so a flow that uses several tools for
  the first time in a project prompts once per tool (item 415).
- `createChatCompletionStream` still maps no provider errors, on either adapter (item 414).
- The annotation the MCP approval gate reads is the server's own claim, current only as of that
  server's version — an update can change what a tool does without changing the annotation or
  invalidating `.zone/mcp.json`'s trust hash (item 415).

## [2.2.2] — 2026-08-28

1 commit (`27e49753`) since the 2.2.1 release (`657bc87d`). Every claim below names the commit or the
`docs/deferred-work.md` item it comes from, so a reader can check it.

### Fixed

- **A gateway added through `/keys` could fail for the rest of that session** (`27e49753`). If a
  gateway was added — or only became visible — after Zone had already started, `/keys` would show it
  correctly and write it to disk correctly, but every task still failed with a message like
  "No API key found for `<gateway>`. Add one with `/keys`, or set `ANTHROPIC_API_KEY`" — naming the
  gateway and then a vendor variable it doesn't use. The cause, in one sentence: a gateway added
  after startup was never resolved for that session, and nothing re-resolved it afterwards.
  Restarting Zone worked around it, because startup resolves a gateway correctly when its row
  already exists at that moment; nothing short of a restart did. The error message no longer pairs a
  gateway's name with a vendor environment variable — an unresolved gateway now gets its own message
  pointing at `/keys`. A new `[zone-gateway-unresolved]` marker also records the moment this happens,
  in `~/.zone/markers.jsonl` (item 406).

This is a different failure from item 405, still open since 2.2.1: a request to a gateway that *had*
already resolved (the task classifier reached it and got a real response) produced no output for 115
seconds. This release fixes a gateway never resolving in the first place, which is not what item 405
describes — it does not explain or close it.

## [2.2.1] — 2026-08-28

1 commit (`abf8d8f6`) since the 2.2.0 release (`560ea54b`). Every claim below names the commit or the
`docs/deferred-work.md` item it comes from, so a reader can check it.

### Added

- **A new `[zone-openai-request-issued]` marker**, logged unconditionally immediately before each
  request to an OpenAI-compatible endpoint, on every attempt including retries (`abf8d8f6`). An
  unresponsive gateway can now be diagnosed from `~/.zone/markers.jsonl` after the fact, without
  needing to have re-run in verbose mode.

### Fixed

- **Editing a gateway's API key through `/keys` no longer destroys the profile** (`abf8d8f6`). Before
  this fix, re-entering a key for an existing gateway row dropped its base URL, protocol and declared
  prices — silently demoting the row to a plain vendor key. The next run then either reported no API
  key found, or, if a vendor key happened to be configured too, ran against the wrong endpoint on the
  wrong account with no warning. **If you configured a gateway on 2.2.0 and have since edited its
  key, delete that row from `/keys` and re-add it** — a demoted row can't be repaired in place, since
  the price action is itself gated on the base URL the edit already removed.
- **The pricing prompt after adding a gateway now actually appears** (`abf8d8f6`). It was being torn
  down in the same tick it opened — a fire-and-forget refresh raced the prompt's own dispatch and
  always won — so every gateway was created unpriced and `--max-budget-usd` could never bound it.

**Known limitation.** One live symptom from 2.2.0 remains unexplained: an agent-loop request that
produced no output for 115 seconds against a corporate gateway, while a separate call from the task
classifier — same key, same endpoint — completed with a clean error in 245ms. Tracing found no
swallowed error and no code path that discards a failure silently; the cause of the silence itself is
not yet known (`docs/deferred-work.md` item 405, filed as blocked on data — no fix exists to specify
until it recurs). The marker above is the instrument that will make the next occurrence diagnosable.

## [2.2.0] — 2026-08-28

23 commits since 2.1.0 (`10a83f9c`). Every claim below names the commit or the
`docs/deferred-work.md` item it comes from, so a reader can check it.

### Added

- **Connect to an OpenAI-compatible gateway** (LiteLLM, OpenRouter, a corporate hub) — `/keys` gains
  a `[G]ateway` option alongside the two vendors, taking a profile id, a base URL, and a key
  (item 396). The profile id then works as `--provider <id>`, and its models are reachable through
  `/model`'s free-text entry (`C`). Model ids containing a slash — `openai/gpt-4o-mini` is the
  common shape — pass through verbatim rather than being validated against Zone's own two-vendor
  catalog, which previously substituted a cheaper vendor model in its place without saying so
  (item 397).
- **A gateway profile can declare its own prices** (item 399) — after saving a gateway key, `/keys`
  offers per-model input/output rates in USD per million tokens, with cache-read and cache-write
  asked separately and skippable. **If a profile declares no prices, nothing changes from before**:
  its cost is recorded as unknown rather than guessed, `--max-budget-usd` and the daily spend cap
  cannot bound it, and a one-time `[zone-budget-gate-inert]` warning says so. Nothing is inferred or
  defaulted — a price is always the user's own declaration, never Zone's estimate.
- **`--provider <id>`** (item 384) — previously referenced by an existing warning message but not a
  real flag. An unrecognized value now warns naming the value instead of silently defaulting to
  Anthropic (item 385).
- **`/model` orders the catalog, seeks to your current model, and filters by key** (`cc535e51`) — the
  picker opens with the cursor already on the model you're using, and hides providers you have no
  key configured for.
- **Assistant responses stream into the transcript as they're generated** (`a2367747`, `ec70e702`) —
  on a normally-completing run, tool-call arguments already streamed live; the final answer's text
  previously did not, and the TUI showed nothing while it was being produced.

**Known limitation.** Only OpenAI-compatible (`openai-chat`) gateways are reachable — this covers the
common case, including Anthropic models served *through* such a gateway. A gateway speaking
Anthropic's own wire protocol directly (Amazon Bedrock, Google Vertex) is not: `AnthropicAdapter`
takes no base URL, deliberately out of scope for this arc, since those endpoints authenticate with
SigV4 and GCP tokens rather than a bearer key, and folding that in would put credential-shape
variation into a design that currently has none.

### Fixed

- **A TUI crash mid-render while an MCP server was armed left that server's process running**
  (`c6add1ce`) — the crash path now kills it, matching every other exit path.
- **An uncaught exception or unhandled rejection lost the in-progress session entirely**
  (`8d567df6`) — Ctrl+C already saved it; both crash paths now persist the session the same way, so
  a crash is resumable like an interrupt.
- **Two TUI panels painted a background fill with no explicit foreground colour** (`0128df6e`),
  which measured as inverted, near-invisible contrast (1.08:1) against a dark terminal's default
  foreground. Every painted surface now pairs its fill with an explicit, readable foreground.

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
