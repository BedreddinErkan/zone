# Zone

Open-source AI coding agent with TypeScript AST-based validation. Self-hostable, BYOK (bring your own key).

[zonecli.dev](https://zonecli.dev) · [Desktop app](https://github.com/BedreddinErkan/zone-desktop) · [CLI](https://github.com/BedreddinErkan/zone-cli)

## What it does

Zone runs a code-modification loop with an AST-based validator as a defensive layer. Each iteration is checked for scope discipline, syntax integrity, and a growing set of structural smells (duplicate JSDoc, declaration identity swaps, out-of-scope mutations). Per-file failure tracking escalates: after 3 failures on the same file, the agent is hard-blocked from `apply_patch` and forced to switch strategies (`write_file` with full content).

## Why Zone

### Real cost — 30 days of solo development

OpenAI usage on this volume:

| Spend | Requests | Tokens |
|---|---|---|
| **$4.79** | **4,708** | **28.2M** |

That's roughly **$0.001 per request**. Same volume on subscription tools:

- **Cursor Pro** ($20/mo) — $20 credit pool covers ~225-650 premium requests; 4,700+ requests pushes to Pro+ ($60) or Ultra ($200)
- **Claude Code Pro / Max** ($20-200/mo) — coding tokens shared with Claude chat, with 5-hour rolling windows
- **Codex Pro** ($20-200/mo) — quota-based, OpenAI-only

**Already pay for Claude Pro or Max?** Zone lets you offload everyday coding tasks — small refactors, bug fixes, scoped edits — to BYOK API at fractional cost, preserving your subscription quota for chat, research, and the complex multi-step agent sessions where Claude Code's deeper context truly shines.

Anthropic Sonnet 4.6 is supported with prompt caching enabled by default. Cached iterations save 50-80% on input cost — a typical multi-iter Zone run costs ~$0.05–0.50 depending on task complexity.

With Zone BYOK you pay your provider directly — no markup, no subscription floor, no rolling time windows.

## Quick start (self-hosted)

```bash
git clone https://github.com/BedreddinErkan/zone.git
cd zone
npm install
cp .env.example .env
# Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env
npm run build
npm run serve
```

Open `http://localhost:3000`. Point Zone at any local repo and start prompting.

## Environment

See `.env.example` for the full list. Minimum: one of `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

Anthropic prompt caching is enabled by default — empirically observed 50%+ input savings on multi-iter runs (hit ratio reaches 90-96% by iter 3+). Set `ZONE_ENABLE_MESSAGE_CACHE=0` to opt out.

## Stack

TypeScript end-to-end. AST validator + tool executor + agent loop in `src/`. Single-page UI in `src/ui/index.html` (vanilla JS, Tauri-aware for desktop bundling).

Supported providers: Anthropic (Sonnet 4.6 / Haiku 4.5 / Opus 4.7), OpenAI (GPT-4o / GPT-4-Turbo).

## License

[AGPL-3.0-or-later](LICENSE). Forks must release their source under the same license. Commercial use is allowed; closed-source SaaS forks are not.

## Contributing

Issues and PRs welcome at [github.com/BedreddinErkan/zone](https://github.com/BedreddinErkan/zone).

## Debugging

By default Zone shows only high-level run summaries and errors. To see verbose internal logs (request flow, cache hits, tool calls, performance traces), set the verbose flag:

```bash
ZONE_VERBOSE_LOGS=1 npm run serve
```

Useful when filing a bug report or investigating agent behavior locally.
