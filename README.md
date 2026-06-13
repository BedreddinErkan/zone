# Zone

**A coding agent that's actually yours.** Self-host, BYOK, open source — Claude Code / Cursor capability on real tasks, with no caps and full cost transparency. Your code and your key never leave your machine.

[zonecli.dev](https://zonecli.dev) · [GitHub](https://github.com/BedreddinErkan/zone)

## Not another subscription

Subscription agents (Cursor, Codex, Claude Code) hide your usage behind rate limits and a flat monthly price. Zone runs on your own API key — so you pay per token, never get throttled, and see the real cost of every task.

| Zone | Subscription agents |
|------|---------------------|
| Your key, direct to the API | Locked to one vendor's plan |
| No caps — never blocked mid-session | Rate-limited (5-hour rolling windows) |
| Every cent visible, per task | Usage hidden behind a flat price |
| Runs on your machine | Their cloud |
| Open source (AGPL-3.0) | Closed |

## Quick start

```bash
# 1 — clone & build
git clone https://github.com/BedreddinErkan/zone && cd zone
npm install && npm run build

# 2 — add your API key
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY

# 3 — run, from any repo
cd ~/your-project && zone
```

Press **Shift+Tab** for plan mode. You can also add and manage keys from inside the TUI with `/keys` — no `.env` needed for personal use.

## How it works

1. **Describe a task.** In plan mode, Zone drafts a step-by-step plan and waits — you approve, refine, or give feedback before it touches a file.
2. **It works.** It reads your code, makes AST-validated edits, and runs commands behind a safety layer — reading the output and fixing its own mistakes until the task is done.
3. **You see the cost.** Tier-aware model routing and prompt caching keep it cheap; every run ends with exact tokens, time, model, and dollars.

## Features

- **BYOK** — Anthropic + OpenAI, your keys, direct.
- **No caps** — pay per token, never throttled.
- **Cost telemetry** — real dollars on every run.
- **Plan mode** — a read-only investigation (reads files, searches, runs `build` / `test` / `typecheck`) finds the real root cause and shows a plan before it edits. Approve, refine, or reject.
- **Atomic safety** — patches stage in memory, typecheck on the staged tree, flush all-or-nothing, and auto-rollback on failure. Your working tree never enters a half-broken state.
- **Sessions** — resume any run where you left off (`--resume`).
- **Model routing** — the right model per task; switch any time with `/model`.
- **Self-hosted & open** — AGPL-3.0, inspect everything. No telemetry, no vendor dependency beyond your LLM provider.
- **@file context injection** — type `@path` in the composer to inline a file's contents into the task; tab-complete shows matching repo files.
- **/image** — attach a local image (jpeg/png/gif/webp) for vision-capable models with `/image <path>`.
- **/undo** — snapshot-based revert of the last run's file changes; shows a drift warning if files were edited since.
- **Web fetch** — the agent can fetch a URL via `fetch_url`; SSRF-guarded, streaming-capped, re-validates redirects.
- **User hooks** — `.zone/hooks.json` defines `PreToolUse` veto rules and `PostToolUse` side-effects; home-dir content-hash trust gate.
- **MCP client** — `.zone/mcp.json` configures stdio MCP servers; their tools register as `mcp__<server>__<tool>` and are available to the agent automatically.

## Slash commands

| Command | What it does |
|---------|--------------|
| `/help` | Show key bindings and commands |
| `/exit` | Exit zone |
| `/clear` | Clear transcript |
| `/cost` | Show session cost |
| `/permissions` | View and remove trusted command prefixes |
| `/keys` | Manage API keys (BYOK) |
| `/sessions` | Browse and resume past sessions |
| `/init` | Scaffold `.zone/memory.md` by analyzing repo |
| `/memory` | Show `.zone/memory.md` |
| `/model` | Choose AI model |
| `/effort` | Set reasoning effort (model-dependent: low → max) |
| `/summary` | Set summary format (compact/detailed) |
| `/plan-mode` | Set plan depth (quick/investigate) |
| `/session` | Toggle session memory (off/on) |
| `/metrics` | View run telemetry KPIs |
| `/limits` | Set daily USD cap |
| `/commit` | Commit last run's changes with scoped git commit |
| `/autocommit` | Toggle auto-commit after each run (off/on) |
| `/websearch` | Toggle web search (off/on) |
| `/image` | Attach a local image file to the next task (`/image <path>`) |
| `/undo` | Undo the last run (restore files to pre-run state) |

## Cost

Stop guessing what your coding agent costs. Every task shows its real cost, and you only pay for what you use — for most developers, far less than a Max plan.

Real Zone runs: a small edit costs as little as **$0.02**; a full Astro site scaffold costs **$0.09**; a typical cached feature or refactor runs **$0.20–0.50**; large multi-file refactors top out around **$0.90**. At ~5 sessions/day and ~$0.30/session, that's roughly **$45/mo** in API spend.

| Plan | Monthly |
|------|---------|
| Claude Pro + Zone | ~$65 |
| Claude Max 5× | $100 |
| Claude Max 20× | $200 |

Anthropic rates (Jun 2026): **Sonnet 4.6** $3 / $15 per MTok · **Opus 4.8** $5 / $25 · cache-hit input **$0.30** (−90%). Prompt caching is on by default, so multi-iteration runs get *cheaper* per turn, not more expensive.

> Consumer Claude plans don't include API access, and Claude Code under a plan is rate-limited. Zone is BYOK on the provider API — `/metrics` shows real history from your own runs.

Run `/cost` or `/metrics` in-session for exact per-run figures; full cost logs live in `~/.zone/cost-logs/`.

## Configuration

Keys can be set entirely through `/keys` at runtime — no `.env` file required for personal use. For headless or scripted setups:

```bash
ANTHROPIC_API_KEY=sk-ant-...        # at least one provider key
OPENAI_API_KEY=sk-...

ZONE_ENABLE_MESSAGE_CACHE=1         # Anthropic prompt caching (default on)
ZONE_VERBOSE_LOGS=0                 # 1 for diagnostic output
ZONE_DAILY_USD_CAP=10               # per-user daily spend cap (USD); 0 = unlimited
ZONE_ORG_POLICY_PATH=...            # org-level policy file (JSON)
ZONE_EXPERIMENTAL_SYNTAX_CHECKERS=  # CSV of experimental checker ids (e.g. "go,ruby,java")
```

### Experimental syntax checkers

Zone validates patched files inline before writing them to disk. TypeScript and Python are first-class (always active). Go, Ruby, and Java are experimental and opt-in via `ZONE_EXPERIMENTAL_SYNTAX_CHECKERS`. Each uses a graceful skip — if the binary isn't on PATH, Zone approves the patch rather than blocking. (Rust is omitted; use `run_command: cargo check` instead.)

## Self-host requirements

- Node.js 22+
- npm 10+
- `~/.zone/` directory (auto-created on first launch)

## License

[AGPL-3.0-or-later](LICENSE). Free for personal use, modification, and distribution. Forks must release their source under the same terms; closed-source SaaS forks are not permitted.

If Zone saves you money, you can [sponsor its development](https://zonecli.lemonsqueezy.com).

## Built by

Bedreddin Erkan ([@BedreddinErkan](https://github.com/BedreddinErkan)) — solo dev. Built with TypeScript, Node.js, Ink, and the OpenAI / Anthropic SDKs. Inspired by Cursor; frustrated by SaaS lock-in.