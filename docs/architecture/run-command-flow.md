# Zone run_command dispatch and approval flow

This document explains how Zone dispatches the `run_command` tool and how command approval works across the executor, API, agent loop, and UI.

## 1. Where the `run_command` handler is defined

The primary `run_command` tool handler lives in `executeTool()` in `src/tools/toolExecutor.ts`, in the `if (toolName === "run_command")` branch at `src/tools/toolExecutor.ts:572`. That branch resolves the working directory with `resolveRunCommandCwd()` (`src/tools/toolExecutor.ts:574`), blocks obviously dangerous commands with `isBlockedCommand()` (`src/tools/toolExecutor.ts:585`), optionally pauses for approval via `input.onApprovalRequired` (`src/tools/toolExecutor.ts:589-597`), and then executes the command with `execAsync()` (`src/tools/toolExecutor.ts:637-650`).

The agent loop wires approval into that executor call in `src/llm/agentLoop.ts:1675-1681`, where it imports `requestCommandApproval()` and passes an `onApprovalRequired` callback to `executeTool()`. That callback is the bridge between tool execution and the approval subsystem.

There is also a separate HTTP endpoint, `POST /api/run-command`, implemented in `src/api/server.ts:1796`, but that route is a UI terminal runner, not the LLM tool-dispatch path used by the `run_command` tool. The approval architecture for the tool itself flows through `toolExecutor.ts` plus `commandApprovals.ts`.

## 2. Decision flow: auto-approved vs. manual approval

The approval policy is centralized in `requestCommandApproval()` in `src/api/commandApprovals.ts:78-150`. It evaluates commands in a fixed order:

1. Safe commands are auto-approved.
2. Previously trusted commands for the current run are auto-approved.
3. Everything else becomes a pending approval request.

### Safe-command path

`isSafeCommand()` is defined in `src/api/commandApprovals.ts:18-22`. It trims the command and rejects empty input (`src/api/commandApprovals.ts:17-18`). It then rejects any command containing shell metacharacters like `&`, `|`, `;`, `` ` ``, `$`, `(`, `)`, `<`, or `>` (`src/api/commandApprovals.ts:19`). If the command passes that filter, it is considered safe only when it exactly matches or starts with one of the prefixes in `SAFE_COMMAND_PREFIXES` (`src/api/commandApprovals.ts:3-11,20-22`).

That allowlist includes `npm run build`, `npm run test`, `npm test`, several readonly shell commands such as `ls`, `cat`, and `grep`, some Git inspection commands, and TypeScript verification commands like `tsc --noEmit` (`src/api/commandApprovals.ts:3-10`).

When `requestCommandApproval()` sees a safe command, it emits a `command_auto_approved` event and resolves immediately with `{ approved: true }` (`src/api/commandApprovals.ts:88-99`). No pending approval record is created in this branch.

### Trusted-command path

If the command is not safe, `requestCommandApproval()` next checks `isCommandTrusted(runId, command)` at `src/api/commandApprovals.ts:102`. `isCommandTrusted()` looks for the trimmed command in the current run’s set inside `trustedCommandsByRunId` (`src/api/commandApprovals.ts:33,39-45`).

When this check passes, `requestCommandApproval()` emits `command_trusted` and also resolves immediately with `{ approved: true }` (`src/api/commandApprovals.ts:103-113`). This is the “approved once, then auto-approved for the rest of the run” path.

### Manual-approval path

If neither safe nor trusted checks pass, `requestCommandApproval()` emits `command_approval_required` (`src/api/commandApprovals.ts:116`) and creates a pending promise stored in `pendingApprovals` under a generated `approvalId` (`src/api/commandApprovals.ts:31,118-133`).

That pending promise is what blocks the `await input.onApprovalRequired(...)` call in `src/tools/toolExecutor.ts:590` until the user responds.

If the request times out, `requestCommandApproval()` resolves it as rejected via `setTimeout(() => finish(false), timeoutMs)` (`src/api/commandApprovals.ts:131`). If the run abort signal fires, it also resolves as rejected (`src/api/commandApprovals.ts:134-149`).

## 3. Trust list lifecycle

The trust store is a per-run map named `trustedCommandsByRunId` in `src/api/commandApprovals.ts:33`.

### When trust entries are added

Trust entries are added only through `addTrustedCommand(runId, command)` in `src/api/commandApprovals.ts:50-61`. That function normalizes the run ID and command, creates a `Set` when needed, and inserts the command string.

The only place that adds trust in this flow is `resolveCommandApproval()` in `src/api/commandApprovals.ts:152-163`. When the user approves a pending command and sends `trust: true`, `resolveCommandApproval()` calls `addTrustedCommand(entry.runId, entry.command)` before resolving the pending request (`src/api/commandApprovals.ts:159-161`).

The HTTP entrypoint for that user response is `POST /api/approve-command` in `src/api/server.ts:1784-1794`, which forwards `approvalId`, `runId`, `approved`, and `trust` into `resolveCommandApproval()` (`src/api/server.ts:1791`).

### When trust entries are cleared

Trust is scoped to a single run. `clearTrustedCommandsForRun(runId)` is defined in `src/api/commandApprovals.ts:67-75`; it removes the run’s trust set and returns the number of commands cleared.

The server clears trust on every run-end path:

- `completeActiveRun()` calls `clearTrustedCommandsForRun(runId)` before updating active-run state (`src/api/server.ts:127-134`).
- `POST /api/cancel` calls both `rejectPendingApprovalsForRun(runId)` and `clearTrustedCommandsForRun(runId)` during cancellation (`src/api/server.ts:717-724`).
- Successful `/api/patch` completion calls `completeActiveRun(runId, "completed")` (`src/api/server.ts:1337-1343`).
- Cancel and error flows in `/api/patch` also call `completeActiveRun(runId, "cancelled")` (`src/api/server.ts:1377-1383,1416-1423`).

So a trusted command never outlives the current run.

## 4. End-to-end UI flow

### Agent loop to approval event

When the LLM invokes `run_command`, the executor reaches the approval gate in `src/tools/toolExecutor.ts:589-597`. If both `runId` and `onApprovalRequired` are present, the executor pauses and awaits the callback.

The callback provided by the agent loop imports `requestCommandApproval()` and calls it with an `emit` function that forwards approval events into `input.onStructuredEvent` (`src/llm/agentLoop.ts:1675-1681`). That is the backend bridge from approval logic into the run progress event stream.

### Server-to-frontend transport

Patch progress is delivered over Server-Sent Events from `GET /api/progress` in `src/api/server.ts:580-606`. That endpoint attaches the HTTP response as an SSE client with `attachDeveloperPatchProgressSseClient(runId, res)` (`src/api/server.ts:593`) and keeps it alive with heartbeat comments (`src/api/server.ts:595-601`).

Because the agent loop emits approval events through its structured-progress callback, the frontend receives `command_approval_required`, `command_auto_approved`, and `command_trusted` over the same SSE stream used for normal run progress.

### Frontend reception of approval requests

The UI reserves a dedicated sticky approval mount point in the input area: `<div id="zoneApprovalStickyContainer" class="zone-approval-sticky" data-state="hidden"></div>` at `src/ui/index.html:1093`.

The sticky approval UI is styled in the approval-specific CSS block at `src/ui/index.html:482-505`. The comment immediately above it explains the behavior: the prompt lives inside `.inputBar`, appears above the chat input, defaults focus to Approve, supports Left/Right focus switching, submits with Enter, and rejects with Escape (`src/ui/index.html:481-483`).

Incoming SSE payloads are checked for `command_approval_required` in the frontend event handler at `src/ui/index.html:3236-3240`, and there is a second defensive check in the replay/live event path at `src/ui/index.html:7798-7801`.

The actual approval card renderer is documented by the inline comment at `src/ui/index.html:5674-5675`, and the implementation starts by targeting `zoneApprovalStickyContainer` at `src/ui/index.html:5799`. It stores the owning `runId` on the container so thread switching can hide approvals that belong to another thread (`src/ui/index.html:5802-5803`), then sets visibility based on `approvalIsForActiveThread(payload?.runId)` (`src/ui/index.html:5814`).

### User response and unblocking execution

When the user clicks Approve or Reject in the sticky card, the frontend posts to `/api/approve-command` with `approvalId`, `runId`, `approved`, and `trust` using `apiFetch()` (`src/ui/index.html:5836-5842`). There is also another approval POST path used in a related UI flow at `src/ui/index.html:3168-3174`.

On the server, `POST /api/approve-command` calls `resolveCommandApproval()` (`src/api/server.ts:1784-1794`). `resolveCommandApproval()` looks up the pending entry, verifies the run ID, optionally adds trust, and then calls `entry.resolve(approved)` (`src/api/commandApprovals.ts:152-163`).

That `resolve()` callback is the `finish()` function created inside `requestCommandApproval()` (`src/api/commandApprovals.ts:119-129`). Calling it clears the timeout, removes the pending approval from `pendingApprovals`, and resolves the promise awaited by the executor.

At that point, the blocked `await input.onApprovalRequired(...)` in `src/tools/toolExecutor.ts:590` resumes. If the command was approved, execution continues into the normal `execAsync()` path (`src/tools/toolExecutor.ts:599-650`). If it was rejected, `executeTool()` returns a failed tool result telling the agent not to retry the command (`src/tools/toolExecutor.ts:591-596`).

### Thread-aware visibility in the UI

The frontend also prevents approval prompts from leaking between threads. `approvalIsForActiveThread()` compares the approval’s `runId` to the active thread’s run state (`src/ui/index.html:1363-1367`), and `applyStickyBandForActiveThread()` shows the sticky approval only when the active thread owns that run (`src/ui/index.html:1411-1439`). If the user switches away, the approval is hidden without being destroyed, so returning to the correct thread reveals the same pending prompt.

## Summary

Zone dispatches the `run_command` tool in `src/tools/toolExecutor.ts:572`, but the approval decision itself is centralized in `src/api/commandApprovals.ts:78-150`, where commands are classified as safe, trusted, or manually gated. The agent loop connects those layers by supplying an `onApprovalRequired` callback that turns approval decisions into structured progress events on the normal SSE channel (`src/llm/agentLoop.ts:1675-1681`, `src/api/server.ts:580-606`). Trust is strictly per-run: it is added only when a user approves with `trust: true` and is cleared on completion or cancellation (`src/api/commandApprovals.ts:50-75`, `src/api/server.ts:127-134,717-724`). On the frontend, a sticky approval panel receives the request, scopes it to the correct thread, and posts the user’s decision back to `/api/approve-command` (`src/ui/index.html:1093,5799-5842`). That response resolves the pending promise in `requestCommandApproval()`, which directly unblocks the paused executor and either continues command execution or returns a rejection result.