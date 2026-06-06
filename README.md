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

## Slash commands

| Command | What it does |
|---------|--------------|
| `/model` | Switch the provider + model mid-session (e.g. Opus to plan, Sonnet to execute) |
| `/keys` | Add or manage API keys — masked input, stored locally, persisted across sessions |
| `/sessions` | Browse and resume past runs |
| `/init` | Scan the current repo and set up project context |
| `/metrics` | Token + cost breakdown for the session |
| `/limits` | View usage and spend limits |
| `/commit` | Commit the last run's changes with an editable message |
| `/autocommit` | Toggle automatic commit after each successful run |
| `/summary` | Show a summary of the current session |
| `/websearch` | Toggle web search for tasks |
| `/export` | Export the session (markdown / JSON) |
| `/copy` | Copy the last output to the clipboard |
| `/feedback` | Send feedback |
| `/help` | List every command |
| `Shift+Tab` | Toggle plan mode |

## Cost

Stop guessing what your coding agent costs. Every task shows its real cost, and you only pay for what you use — for most developers, far less than a Max plan.

Real Zone runs: a full Astro site scaffold costs **$0.09**; a typical cached feature or refactor runs **$0.20–0.50**. At ~5 sessions/day and ~$0.30/session, that's roughly **$45/mo** in API spend.

| Plan | Monthly |
|------|---------|
| Claude Pro + Zone | ~$65 |
| Claude Max 5× | $100 |
| Claude Max 20× | $200 |

Anthropic rates (Jun 2026): **Sonnet 4.6** $3 / $15 per MTok · **Opus 4.8** $5 / $25 · cache-hit input **$0.30** (−90%). Prompt caching is on by default, so multi-iteration runs get *cheaper* per turn, not more expensive.

> Consumer Claude plans don't include API access, and Claude Code under a plan is rate-limited. Zone is BYOK on the provider API — `/metrics` shows real history from your own runs.

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