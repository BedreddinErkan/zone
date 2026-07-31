# Contributing to Zone

Thanks for your interest. Zone is AGPL-3.0 — contributions are accepted under the same license.

## Reporting bugs

File an issue at [github.com/BedreddinErkan/zone/issues](https://github.com/BedreddinErkan/zone/issues). Include:

- What you ran (task prompt, repo type, tier)
- What you expected vs. what happened
- Output from `ZONE_VERBOSE_LOGS=1 node dist/cli/index.js` if relevant

## Pull requests

1. Fork the repo and branch off `master`.
2. Run `npm run typecheck` and `npm test` before pushing.
3. Open the PR with a short summary and a test plan. Link the issue it closes.
4. Squash-merge expected; preserve the issue/PR reference in the commit body.

### Development environment

```bash
git clone https://github.com/BedreddinErkan/zone.git
cd zone
npm install
cp .env.example .env   # add at least one provider key
npm run build && node dist/cli/index.js
```

Source layout:

- `src/cli/` — CLI entry point and the Ink-based terminal UI (`src/cli/tui/`)
- `src/llm/` — Agent loop, provider adapters (OpenAI + Anthropic), task classification
- `src/core/` — Atomic patch flow, decision pipeline
- `src/tools/` — Tool implementations and definitions (read_file, write_file, apply_patch, …)
- `src/api/` — Disk-persisted config and approvals (BYOK keys, sessions, trust) — no HTTP server
- `src/audit/` — Scope-audit pipeline

### A note on framework dev

Zone's atomic-staging and tier caps are tuned for single-feature task dispatches against external repos. They are deliberately strict, which makes them a poor fit for sprawling multi-feature refactors of Zone's own codebase. For development on Zone itself, Codex or Claude Code is usually a better fit — use Zone to dispatch focused tasks against the codebase, not to drive the framework's own evolution.

## License

By contributing, you agree your code is released under AGPL-3.0-or-later, the same license as the project. Forks and downstream derivatives must release source under the same terms.
