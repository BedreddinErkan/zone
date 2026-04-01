## CI Usage

Smile Agent supports a CI-safe evaluation mode for pull requests and manual workflow runs.

### CI behavior

When running with `--ci`, the agent evaluates the task and writes a structured result to:

```bash
.agent-cache/last-result.json