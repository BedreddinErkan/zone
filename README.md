# Zone

Open-source AI coding agent with TypeScript AST-based validation. Self-hostable, BYOK (bring your own key).

[zonecli.dev](https://zonecli.dev) · [Desktop app](https://github.com/BedreddinErkan/zone-desktop) · [CLI](https://github.com/BedreddinErkan/zone-cli)

## What it does

Zone runs a code-modification loop with an AST-based validator as a defensive layer. Each iteration is checked for scope discipline, syntax integrity, and a growing set of structural smells (duplicate JSDoc, declaration identity swaps, out-of-scope mutations). Per-file failure tracking escalates: after 3 failures on the same file, the agent is hard-blocked from `apply_patch` and forced to switch strategies (`write_file` with full content).

## Why Zone

| | Zone | Cursor Pro | Claude Code Max | Codex Pro |
|---|---|---|---|---|
| **Pricing** | BYOK only | $20–200/mo | $100–200/mo | $20–200/mo |
| **Usage limits** | None | Quota-based | 5-hour rolling windows | Quota-based |
| **Providers** | OpenAI + Anthropic | Multiple cloud | Anthropic only | OpenAI only |
| **AST validation** | ✓ | — | — | — |
| **Self-hostable** | ✓ | — | — | — |
| **Open source** | AGPL-3.0 | — | — | — |

Pay your provider directly. No subscription, no per-seat fees, no message caps, no rolling time windows. With Anthropic prompt caching enabled by default, a typical multi-iter Zone run uses ~$0.05–0.50 BYOK Sonnet 4.6 depending on task complexity.

## Quick start (self-hosted)

```bash
git clone https://github.com/BedreddinErkan/zone-api.git
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

Issues and PRs welcome at [github.com/BedreddinErkan/zone-api](https://github.com/BedreddinErkan/zone-api).
