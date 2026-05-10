# Zone

Self-host AI coding agent. Tier-bounded execution. Atomic safety. BYOK transparency.

> [demo gif — dispatch → diff → auto-verify thumbnail → reply bubble]

[zonecli.dev](https://zonecli.dev)

## Why Zone

Existing coding agents (Cursor, Codex, Claude Code) are powerful but:

- **Subscription lock-in** ($20–200/mo with usage caps and rolling windows)
- **No cost predictability** (premium-request quotas, opaque tier ladders)
- **Closed source** (your prompts go through their infrastructure)
- **Editor-bound** (not for terminal / web / multi-machine workflows)

Zone is different:

- **BYOK**: Your OpenAI or Anthropic key. You pay your provider directly — no markup, no subscription floor.
- **Tier-bounded**: Simple tasks ~$0.005, complex tasks ~$0.15. Per-tier token and iteration caps make cost predictable per dispatch.
- **Atomic safety**: Patches stage in memory, typecheck before flush, auto-rollback on failure. Your working tree never enters a half-broken state.
- **Self-host**: AGPL-3.0. No SaaS lock-in, no telemetry, no vendor dependency beyond your LLM provider.
- **Web UI**: Browser-based. Use it from anywhere — laptop, remote dev box, tablet — without an editor extension.

Anthropic prompt caching is enabled by default — empirically 50%+ input savings on multi-iter runs (hit ratio reaches 90–96% by iter 3+). A typical Zone run costs $0.05–0.50 depending on tier.

## Quick start

```bash
git clone https://github.com/BedreddinErkan/zone.git
cd zone
npm install
cp .env.example .env   # add your OpenAI or Anthropic key
npm run build && npm run serve
# Open http://localhost:3000
```

Add your key in **Settings → API Keys**, point at any local repo, dispatch a task.

## Features

### Tier-aware execution (Phase L)

Tasks are classified by a small upstream model into `simple` / `medium` / `complex` tiers before dispatch. Each tier has its own caps:

| Tier    | Token budget | Iter cap | Subagent quota |
|---------|--------------|----------|----------------|
| simple  | 400 K        | 15       | 0              |
| medium  | 600 K        | 25       | 1              |
| complex | 800 K        | 40       | 2              |

User-tunable via **Settings → Tier Limits**, or per-dispatch override with the `forceTier` API field.

### Atomic safety (Phase J)

Every patch goes through:

1. **In-memory staging** — no disk writes until verified
2. **Typecheck pass** — `tsc --noEmit` on the staged tree
3. **Atomic flush** — all-or-nothing write on success
4. **Auto-rollback** — disk restored to pre-apply state on failure, with a "what was attempted" diff rendered under the rollback banner

Your code never enters broken state because the agent guessed wrong.

### Visual verification (Phase I)

After UI patches, Zone takes a Playwright screenshot at your configured dev URL. Thumbnail renders inline in the reply bubble; click to expand into a full-size lightbox. Configure viewport / path / URL in **Settings → Visual**, or via `ZONE_DEV_SERVER_URL`.

### Multi-provider BYOK

- **OpenAI**: `gpt-5.4`, `gpt-5.4-mini`
- **Anthropic**: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`
- Vision-capable models accept image attachments
- Switch provider/model per dispatch from the footer picker

### Image attachments (Phase M)

Click the paperclip → upload PNG / JPEG / WebP / GIF. Limits: ≤5 MB per image, ≤16 MB total, max 4 per dispatch. Vision-capable models analyze the attached images alongside the text prompt; routed to OpenAI's `image_url` format or Anthropic's `image.source.base64` format by the provider adapter.

### Variance dashboard

**Settings → Variance** surfaces per-task cost variance, p50/p95 latency, outlier detection (>2σ), and the last 50 runs. Powered by the sweep CSV — useful for catching regressions in token efficiency across versions.

## What Zone is good at

- Single-file edits ("add this comment", "fix this bug", "rename this variable")
- Scoped refactors inside a 1–3 file blast radius
- Read-only investigation ("why does this test fail?")
- Visual verification ("change the chat background to dark gray, show me the result")
- Tier-classified execution (small tasks stay cheap, large tasks get the budget they need)

## What Zone is NOT (yet)

- Multi-feature coordination ("fix these 3 unrelated bugs in one run")
- Cross-cutting refactors that span 10+ files
- Editor integration — web UI only (VSCode extension on roadmap)
- Active framework dev on Zone itself — use Codex or Claude Code for that; Zone's atomic flow is tuned for single-feature task execution

## Roadmap

Community-driven priorities:

- **Phase O — Plan-First mode**: structured plan rendered before dispatch, checkpoint resume between iterations
- **Phase P — Context compaction**: enables 30+ minute execution windows
- **Phase Q — Organic subagent dispatch**: multi-task delegation with cost propagation
- **VSCode extension**: editor integration via Zone API

## Architecture

```
┌─────────────────────────────────────────────┐
│  Browser UI (vanilla TS, single page)       │
│  src/ui/index.html                          │
└───────────────┬─────────────────────────────┘
                │  HTTP + SSE
┌───────────────▼─────────────────────────────┐
│  Express server                             │
│  src/api/server.ts                          │
│   ├─ /api/chat       (investigation flow)   │
│   ├─ /api/patch      (atomic patch flow)    │
│   └─ /api/sweep-results, /api/usage, ...    │
└───────────────┬─────────────────────────────┘
                │
┌───────────────▼─────────────────────────────┐
│  Agent loop (src/llm/agentLoop.ts)          │
│   ├─ LLM adapters: OpenAI + Anthropic       │
│   ├─ Tool executor + AST validator          │
│   ├─ Tier-bounded budget enforcement        │
│   └─ Atomic staging + rollback              │
└───────────────┬─────────────────────────────┘
                │
        File-based storage
        ~/.zone/, .zone/, dist/
```

TypeScript end-to-end. AST validator + tool executor + agent loop in `src/`. Storage is file-based (`~/.zone/` for user-level settings, `.zone/` for repo-level state). No database required.

## Self-host requirements

- Node.js 22+
- npm 10+
- ~/.zone/ directory (auto-created on first launch)
- Optional: Playwright Chromium for visual verification (`npx playwright install chromium`)

## Configuration

```bash
# .env (minimum: at least one provider key)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Optional
ZONE_DEV_SERVER_URL=http://localhost:3000   # visual verification target
ZONE_ENABLE_MESSAGE_CACHE=1                 # Anthropic prompt caching (default on)
ZONE_VERBOSE_LOGS=0                         # 1 for diagnostic output
PORT=3000
```

All keys can also be set through **Settings → API Keys** after first launch — no `.env` file required for personal use.

## Common workflows

**Add a comment to a file** (tier 1, ~5 sec, ~$0.005)
```
Add a brief header comment to src/utils/files.ts describing what it exports
```

**Investigate a failing test** (investigation mode, read-only, ~$0.05)
```
Why is buildDecisionTrace.test.ts failing on case 3?
```

**Refactor a function signature** (tier 3 complex, atomic verification, ~$0.15)
```
Change normalizeSignals to accept an options object with a strict flag
```

## Troubleshooting

**"Plan 0/5" stuck in chat**
Server restart resets plan state — refresh the page.

**Branch dropdown grayed out**
That branch is in use by another git worktree. `git worktree list` to inspect.

**Vision model rejected with "model_no_vision"**
Switch to `gpt-5.4` or `claude-sonnet-4-6` (vision-capable). `gpt-5.4-mini` and `claude-haiku-4-5` are text-only.

**Sweep CSV missing / changes wiped**
The sweep runner resets the worktree (`git reset --hard HEAD`) before each task for idempotent baselines. Commit your work before running sweep.

**Verbose logs**
```bash
ZONE_VERBOSE_LOGS=1 npm run serve
```
Shows request flow, cache hits, tool calls, performance traces — useful for filing a bug report.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome at [github.com/BedreddinErkan/zone](https://github.com/BedreddinErkan/zone).

Note: Zone's atomic-staging flow is tuned for single-feature task dispatches. For multi-task framework development on Zone itself, Codex or Claude Code is a better fit — Zone's tier caps and rollback strictness aren't designed for sprawling refactors of its own codebase.

## License

[AGPL-3.0-or-later](LICENSE). Free for personal use, modification, and distribution. Forks must release their source under the same terms; closed-source SaaS forks are not permitted.

Commercial license available for teams that need single-tenant deployment, SSO, audit logs, or custom support. Contact: [contact: your email].

## Built by

Bedreddin Erkan ([@BedreddinErkan](https://github.com/BedreddinErkan)) — solo dev, ~6 months. Built with TypeScript, Node.js, OpenAI/Anthropic SDKs, and Playwright. Inspired by Cursor; frustrated by SaaS lock-in.

## Acknowledgments

- Codex, Claude Code, Cursor — different philosophies, same problem space
- Anthropic — vision API, prompt caching that actually pays off in iterative agent loops
- OpenAI — gpt-5.4 reasoning models
- Solo dev community on Twitter / HN — feedback throughout development
