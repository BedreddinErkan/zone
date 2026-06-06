# Zone Capability-Parity Roadmap (Claude Code gaps)

Close the capabilities Claude Code has that Zone lacks, ordered by win × tractability × Zone-fit, cost-conscious throughout. Work in order; update status as each lands.

1. Multi-turn conversation memory — iterative refinement  [DONE — all 5 phases, dogfood-validated]
   Gap: dispatch-based with a single rolling prior summary; can't work WITH it across turns.
   Win (highest): dispatcher → collaborator; natural extension of the shipped session-memory primitive.
   Shipped: atomic `{type:"turn"}` records per dispatch → pure tiered window builder (`src/llm/sessionWindow.ts`,
   ≤4096 B: newest turn full-fidelity + older turns one-line) injected through the existing `priorSessionSummary`
   seam into the first user message; static directive pluralized + kept unconditional; cache-invariant test stands.
   → DESIGN-multi-turn-memory.md

2. Web search / fetch for the agent  [DONE — 6 phases, default-on Anthropic, cost-transparent (ledger+telemetry), injection-safe, provider-graceful, validated]
   Gap: agent is offline (codebase + training only); can't look up current docs/errors/APIs/versions.
   Win (best win-per-effort): unblocks external-info tasks. Provider-native web search (Anthropic-first) — no extra key.
   Shipped: provider-native web search, default-on for Anthropic, gated by a WHEN-to-fire directive + server-enforced
   `max_uses` cap; results treated as DATA (injection-safe); per-search cost surfaced (usage ledger + telemetry);
   graceful no-op when a provider lacks native search.
   → DESIGN-web-search.md

3. TodoWrite — visible task plan + progress  [DONE — store slice + bus subscriptions + pinned live PlanPanel, adoption dogfood-validated, ~$0 client consumer]
   Gap: the TodoWrite tool + live plan/progress already shipped end-to-end (agent tool, three events, Web-UI sidebar);
   the TUI alone dropped the events.
   Win: long-run UX + agent coherence; the structured-task instance of background-progress-UI (TUI.10.M).
   Shipped: TUI now consumes the three already-flowing events (`todos_initialized`/`todo_revised`/`todo_status_changed`)
   via named-const `bus.on` subscriptions → a `todos: RunTodo[]` store slice → a pinned live `PlanPanel` below the
   Composer (Claude Code style: in-place updates, glyphs ✓/▶/○/⊘, disappears on run completion). Pure client consumer —
   no agent, tool, or prompt/cache change.
   → DESIGN-todowrite-tui.md

4. User-defined slash commands  [DONE — `.zone/commands/*.md` → palette + body fires as a task; dogfood-validated; ~$0 client-side]
   Gap: built-ins only; no project-specific commands.
   Win: power-user stickiness (.zone/commands/*.md → /review, /test-this). Low effort, ~zero cost.
   Shipped: loader (never-throws, 50 cmd / 16 KB / strict charset bounds) reads `.zone/commands/*.md` using
   `config.repoPath` at TUI startup → `userCommands: UserCommand[]` store slice → Composer palette merge (built-ins
   win dedup, `(project)` tag, ≤59-char desc) → body fires via the typed-task path (dispatch `USER_PROMPT` +
   `onSubmit(body, ac)`) so all downstream guards apply (tool approvals, scope guard, USD cap, mode). Local-only v1;
   deferred: gitignore-sharing override, `$ARGUMENTS` substitution, `/reload`, subdir namespacing, global `~/.zone/commands/`.
   → DESIGN-user-slash-commands.md

Deprioritized:
- Full MCP / multimodal-images / IDE integration — niche, hard in-terminal, or a different surface (Zone is CLI).
- Subagents — already exist (0% adoption); an effectiveness/routing problem, not a missing capability.
- Checkpoint/rewind — now enabled by the git work (rewind = git reset to a prior auto-commit); possible quick follow-on, lower urgency.
