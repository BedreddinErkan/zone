# Zone

Open-source AI coding agent with TypeScript AST-based validation. Self-hostable, BYOK (bring your own key).

[zonecli.dev](https://zonecli.dev) · [Desktop app](https://github.com/BedreddinErkan/zone-desktop) · [CLI](https://github.com/BedreddinErkan/zone-cli)

## What it does

Zone runs a code-modification loop with an AST-based validator as a defensive layer. Each iteration is checked for scope discipline, syntax integrity, and a growing set of structural smells (duplicate JSDoc, declaration identity swaps, out-of-scope mutations). Per-file failure tracking escalates: after 3 failures on the same file, the agent is hard-blocked from `apply_patch` and forced to switch strategies (`write_file` with full content).

## Why Zone

### Real cost — 30 days, single developer

| Provider | Spend | Requests | Tokens |
|---|---|---|---|
| OpenAI (GPT-4o) | $4.79 | 4,708 | 28.2M |
| Anthropic (Sonnet 4.6, with prompt caching) | $0.83 | 5 runs | 1.13M |
| **Total** | **$5.62** | **4,713** | **29.3M** |

Same volume on subscription tools:

- **Cursor Pro** ($20/mo) — $20 credit pool covers ~225 Sonnet or ~500 GPT-5 requests; 4,700+ requests pushes you to Pro+ ($60) or Ultra ($200)
- **Claude Code Max** ($100-200/mo) — 5-hour rolling windows constrain sustained sessions
- **Codex Pro** ($20-200/mo) — quota-based; OpenAI-only

With Zone BYOK you pay your provider directly — no markup, no subscription floor, no rolling time windows. Anthropic prompt caching is enabled by default; cached iterations typically save 50-80% on input cost. A typical multi-iter Zone run costs ~$0.05-0.50 on Sonnet 4.6 depending on task complexity.

Pay your provider directly. No subscription, no per-seat fees, no message caps, no rolling time windows. With Anthropic prompt caching enabled by default, a typical multi-iter Zone run uses ~$0.05–0.50 BYOK Sonnet 4.6 depending on task complexity.

## Quick start (self-hosted)

```bash
git clone https://github.com/BedreddinErkan/zone.git
cd zone-api
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
