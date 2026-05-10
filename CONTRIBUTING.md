# Contributing to Zone

Thanks for your interest. Zone is AGPL-3.0 — contributions are accepted under the same license.

## Reporting bugs

File an issue at [github.com/BedreddinErkan/zone/issues](https://github.com/BedreddinErkan/zone/issues). Include:

- What you ran (task prompt, repo type, tier)
- What you expected vs. what happened
- Output from `ZONE_VERBOSE_LOGS=1 npm run serve` if relevant

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
npm run build && npm run serve
```

Source layout:

- `src/api/` — Express server + route handlers
- `src/llm/` — Agent loop, tool executor, LLM adapters (OpenAI + Anthropic)
- `src/core/` — Patch flow, validators, decision pipeline
- `src/tools/` — Tool implementations (read_file, write_file, apply_patch, …)
- `src/ui/index.html` — Single-page frontend (vanilla TS)
- `src/visual/` — Playwright-driven visual verification

### A note on framework dev

Zone's atomic-staging and tier caps are tuned for single-feature task dispatches against external repos. They are deliberately strict, which makes them a poor fit for sprawling multi-feature refactors of Zone's own codebase. For development on Zone itself, Codex or Claude Code is usually a better fit — use Zone to dispatch focused tasks against the codebase, not to drive the framework's own evolution.

## License

By contributing, you agree your code is released under AGPL-3.0-or-later, the same license as the project. Forks and downstream derivatives must release source under the same terms.
