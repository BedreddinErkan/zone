# Zone

> Most AI coders happily commit broken syntax. Zone refuses.
> AI code edits with guardrails — catches broken syntax, duplicate imports,
> and malformed templates before they touch your disk.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)

---

Zone is an open-source AI code agent. You give it a task, it edits your code,
and a built-in validator double-checks every change for common syntax bugs
before letting it stick. If the AI produces broken code, Zone catches it,
reverts the file, and tries again — instead of silently committing nonsense.

## Why Zone?

- **Built-in safety net.** Every patch goes through AST validation. Broken
  syntax, malformed template literals, duplicate JSX attributes, and
  duplicate imports get caught and reverted automatically.
- **Bring your own API key.** Free to use. You pay OpenAI directly for what
  you use. No subscription, no Zone account, no data sent to our servers
  (your key stays in your browser).
- **Open source.** MIT licensed. Read the code, fork it, contribute, or
  self-host.
- **Honest about limits.** Zone handles single-line edits and small refactors
  well. Big multi-file changes and complex JSX still trip it up — see
  "What works, what doesn't" below (coming soon).

## Quick Start

Requirements: Node.js 18+, an OpenAI API key.

```bash
git clone https://github.com/<BedreddinErkan>/zone
cd zone
npm install
npm run build
npm run serve
```

Open http://localhost:3000 in your browser. On first run, you'll be prompted
to enter your OpenAI API key — it's stored in your browser only and never
sent to any server other than OpenAI's.

That's it. Try a task like:

> *"In src/utils/format.js, add JSDoc comments to the formatDate function"*

## Roadmap

Zone is being actively developed (in spare time). Planned next:

- Architecture documentation (`docs/decisions/`)
- Smoke test report with detailed task results
- Plan mode (agent shows its plan before executing, like Cursor)
- Anthropic Claude support (currently OpenAI only)
- VSCode extension (eventually)

This is a hobby project — releases happen when they happen.

## Contributing

Zone is small enough that the easiest contribution is **trying it and
opening an issue**. What didn't work? What confused you? What would you
want it to do?

PRs welcome too, but please open an issue first to discuss the change.

## License

MIT — see [LICENSE](LICENSE).