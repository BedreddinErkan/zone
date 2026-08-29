# The MCP approval gap — investigation and options

Every MCP tool call bypasses Zone's approval machinery. `agentLoop.ts` routes any name starting
`mcp__` straight to `mcpManager.callTool()`, so `onApprovalRequired` never fires. Before commit
`7e9baeb7` this was narrow — MCP tools cleared both filters only in one accidental combination.
That commit made them reachable in every pipeline, which ledger item 408 records as a consequence it
knowingly created. Commit `ce419b0b`'s per-server tool allowlist narrowed it — an unlisted tool is
never offered — but every *listed* tool is still ungated. A user who lists `browser_click` gets
clicking with no approval prompt, in any archetype.

This pass establishes why, what Zone can actually know about a tool's effects, and what a gate would
look like. **It proposes; it implements nothing.**

Provenance is marked throughout:

- **[first-hand]** — I ran the command or read the file myself for this report.
- **[static reading only]** — established by reading code, not by executing it.

**No live run was possible.** Both provider balances are exhausted, and the MCP server was not
spawned. Everything requiring a run is named as unverified where it appears.

---

## Q1 — Why does the MCP dispatch bypass `executeTool`?

**It is an artifact of how MCP was bolted on, not a deliberate separation. But routing it back
through `executeTool` would buy nothing, because there is no generic gate there to inherit.** That
second half is the most consequential finding in this report, and it reframes the options below.

### The dispatch is a two-armed ternary, and only one arm is wired

**[first-hand]** — `src/llm/agentLoop.ts`:

```ts
// MCP dynamic dispatch: route mcp__<server>__<tool> calls to the client manager;
// all other tool names go through the static executeTool if-else.
const result = name.startsWith("mcp__") && input.mcpManager
  ? await ((): Promise<import("../tools/toolExecutor.js").ToolResult> => {
      input.onStructuredEvent?.({ type: "mcp_tool_called", status: "info", title: name, … });
      return input.mcpManager!.callTool(name, parsedArgs);
    })()
  : await executeTool(name, parsedArgs, input.repoPath, input.onProgress, {
      runId: rid || undefined,
      onApprovalRequired: async (command, runId) => { … },
      onEditApprovalRequired: …,
      executionPlan: …, stagingFiles: …, allowedTools: effectiveAllowedSet, …
    });
```

The entire options object — every callback, the plan, the staging map, the allowed set — is
constructed **only on the else arm**. The MCP arm passes a name and args and nothing else. There is
no code path by which an MCP call could reach `onApprovalRequired`, because the callback is never
built for it.

### What `executeTool` assumes that an MCP tool cannot supply

**A known, literal tool name.** **[first-hand]** `executeTool` is a flat
`if (toolName === "<literal>")` chain, terminating in:

```ts
return {
  success: false,
  output: `Unknown tool: ${toolName}`,
};
```

An `mcp__<server>__<tool>` name is composed at connect time from the user's own config; it matches
no literal. Routing MCP into `executeTool` unchanged would return "Unknown tool". It needs a new
prefix-matching branch, and `executeTool` would need the `mcpManager` threaded in as a new input
field — the dispatch site already holds it, `executeTool` does not.

**A capability mapping is *not* an obstacle**, contrary to what one might expect: `executeTool`
never consults `BUILTIN_TOOL_CAPS`. Capability filtering happens earlier, in `resolveToolList`, and
MCP tools are registered directly with `capabilities: ["mcp.call"]`. **[static reading only]**

**A file path is not an obstacle either** — but only because the scope check that would use one is
not generic. See below.

### The gates are per-branch, not generic — counted, not assumed

**[first-hand]**, by call site:

| Gate | Call sites inside `executeTool` | Where they live |
|---|---|---|
| `onApprovalRequired` | 2 | inside the `run_command` and `run_command_background` branches only |
| `onEditApprovalRequired` | 2 | inside the two write-tool branches only |
| `checkWriteScope` | 3 | inside the three write-tool branches only |

The **only** thing at `executeTool`'s entry that applies to every tool is the allowed-set check:

```ts
if (input?.allowedTools && !input.allowedTools.has(toolName)) {
  return { success: false, output: `Tool "${toolName}" is not in the allowed set for this run.` };
}
```

— and the MCP path already effectively satisfies it, because `effectiveAllowedSet` is derived from
`toolsForLLM`, which contains the MCP names by construction.

**So the framing "route MCP through `executeTool` so it inherits every existing gate" rests on a
false premise: there is nothing to inherit.** Any MCP gate must be written new wherever it lives.
The choice is *where it goes and what triggers it*, not whether existing machinery can be reused.
And the existing dispatch site is the better location on the merits: it already has `mcpManager`,
`onStructuredEvent` and `abortSignal` in scope, all of which `executeTool` would have to be handed.

### A correction to item 408's "no approval gate fires for any of them"

One gate already does. **User PreToolUse hooks run *before* the ternary**, so they cover MCP calls,
and they are fail-closed — non-zero exit, timeout, or error all veto. `matchesHook` applies no
tool-name restriction: **[first-hand]**

```ts
if (entry.matchTools && entry.matchTools.length > 0) {
  if (!entry.matchTools.includes(toolName)) return false;
}
```

A hook with no `matchTools` matches every tool including `mcp__*`; one naming
`mcp__playwright__browser_click` matches exactly it. (`extractFileArg` returns `null` for an MCP
call, so `matchPaths` matchers will not fire — tool-name matchers are the usable form.)

So the accurate claim is **"no *built-in* gate fires."** A user-authored PreToolUse hook is an
existing, working answer today, and it should be named as such in any documentation of this gap.
**[static reading only — established by reading the dispatch order; no hook was fired against an MCP
call.]**

---

## Q2 — What does Zone know about an MCP tool's effects?

**The premise that Zone cannot tell `browser_snapshot` from `browser_click` except by name is wrong,
and wrong in Zone's favour. The protocol declares it, the server in use populates it, and Zone
discards it at the one place it arrives.**

### The protocol carries effect annotations

**[first-hand]**, enumerated by running the SDK's own schema (1.29.0) rather than reading docs:

```
Tool shape keys: name, title, icons, description, inputSchema, outputSchema, annotations, execution, _meta
annotations keys: title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint
```

This is the same instrument the Q10 filtering pass used to establish that `tools/list` has no
client-side filter — there, the answer was "the protocol has nothing"; here it is the opposite.

### `@playwright/mcp` populates them, for every tool, as a clean binary

**[first-hand]**, read out of the cached dependency bundle
(`playwright-core/lib/coreBundle.js`, via `@playwright/mcp@0.0.79`) — the real `toMcpTool`:

```js
function toMcpTool(tool) {
  const readOnly = tool.type === "readOnly" || tool.type === "assertion";
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zod.toJSONSchema(tool.inputSchema),
    annotations: {
      title: tool.title,
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      openWorldHint: true
    }
  };
}
```

Every tool gets both hints, derived from the server's own internal `tool.type`, and they are
mutually exclusive by construction (`destructiveHint: !readOnly`). So for this server the signal is
not merely present — it is total and unambiguous.

**[static reading of the bundled server source. The server was not spawned and the `tools/list` wire
payload was not observed.]** The cheap measurement that would settle it — run the server, list its
tools, read the annotations — needs only a subprocess, not an LLM call, and was left undone in this
read-only pass. **Now done — see the Addendum.** It confirms the binary; it also finds that Option
D's own stated default for the measured flow does not hold.

### Zone drops it on the floor

**[first-hand]** — `mcpClientManager`'s registration keeps three fields:

```ts
const definition: ChatCompletionTool = {
  type: "function",
  function: {
    name: namespacedName,
    ...(tool.description ? { description: `[MCP:${serverName}] ${tool.description}` } : {}),
    parameters: tool.inputSchema as Record<string, unknown>,
  },
};
registerTool({ name: namespacedName, capabilities: ["mcp.call"], definition });
```

`annotations` is not read here or anywhere. Paired greps across `src/`, both shown, with a positive
control: **[first-hand]**

```
$ git grep -n "readOnlyHint\|destructiveHint\|idempotentHint\|openWorldHint" -- 'src/**'   → exit 1
$ command grep -rn "readOnlyHint\|destructiveHint\|idempotentHint\|openWorldHint" src/     → exit 1
$ git grep -c "registerTool" -- src/mcp/mcpClientManager.ts                                → 3  (control, exit 0)
```

**Zone reads no MCP effect annotation anywhere.**

### The caveat that survives

The SDK's own documentation is explicit that these are hints:

> NOTE: all properties in ToolAnnotations are **hints**. They are not guaranteed to provide a
> faithful description of tool behavior (including descriptive properties like `title`).
>
> Clients should never make tool use decisions based on ToolAnnotations received from untrusted
> servers.

Zone's servers are user-authored in `<repoPath>/.zone/mcp.json` and SHA-256 trust-gated, so
"untrusted" carries different weight here than in the generic warning — the user chose the command
line and approved its hash. But a server *update* can change what a name does, and the hash gate
covers the config file, not the package the config launches. A gate resting on hints should treat a
missing annotation as destructive and let an explicit user declaration override the server.

---

## Q3 — How do Zone's approval prompts behave, and would an MCP prompt fit?

### Five layers before a user sees anything

**[first-hand]**, in the order `requestCommandApproval` applies them:

1. **`isSafeCommand(command)`** — allowlist auto-approve; emits `command_auto_approved` for the
   timeline, no prompt.
2. **`investigationMode`** — auto-approves diagnostic commands, and *denies* everything else
   outright rather than prompting, on the reasoning that the investigation agent has no write tools
   and a modal would break a background planning phase.
3. **`isCommandTrusted(runId, command)`** — per-**run**, in-memory, exact string match, plus a
   `trustAllForRun` escape. Cleared when the run ends.
4. Otherwise, emit `command_approval_required` and await resolution (5-minute default timeout).
5. **`sessionTrustedPrefixes`** intercepts that event in `eventToActions` **before** the modal is
   ever shown, matched as `command.trim() === p || command.trim().startsWith(p + " ")`, and is
   disk-backed in `.zone/trust.json` — so it survives across runs within a project.

### Does it generalise to a tool name plus arguments? Half of it does

**Tool name — cleanly.** The name is already a stable string with no whitespace, so prefix matching
works unchanged. The modal's own trust derivation is **[first-hand]**:

```ts
const prefix = command.trim().split(/\s+/)[0] ?? command.trim();
```

For a space-free `mcp__playwright__browser_click` this yields the whole tool name, i.e. **per-tool
session trust** — a sensible default that needs no new code. Server-level trust
(`mcp__playwright__`, "trust everything from this server") would need a different derivation
splitting on `__`, which is a small addition rather than a new mechanism.

**Arguments — no.** The mechanism is string prefix matching end to end; arguments arrive as a
structured object. "Trust clicking, but only this selector" has no representation today and would
need a serialization decision that does not exist.

**The modal already accommodates a third kind.** **[first-hand]** `ApprovalModal` takes
`kind?: "command" | "edit"` and branches its rendering on it (`$ ` for a command, `📄 ` for an
edit), so an `"mcp"` kind is a small extension of an existing polymorphic component, not a new one.
The event payload (`PENDING_APPROVAL_SET` carrying `{approvalId, runId, command}`) would need either
a synthesized display string — the tool name plus a compact argument summary — or one added field.

---

## Addendum — Q2 confirmed live, and its own assumed default broken by the result

**The static read was accurate. The behaviour it implied for Option D was not.** Both belong in the
record together, because the second doesn't invalidate the first — it complicates what to do with it.

### The probe

A standalone Node script, no Zone code and no LLM call: spawn `@playwright/mcp@0.0.79` over stdio
with the raw `@modelcontextprotocol/sdk` client, call `listTools()`, print the result.
**[first-hand]** Reproducible without a funded key — it is a subprocess and a protocol call, not a
model request — and this is the instrument to re-run whenever the server version changes, since an
annotation is the server's own claim about itself and nothing pins it across releases.

### Confirmed: the binary is real, for every tool

All 24 tools carry `annotations`. `readOnlyHint` and `destructiveHint` are a clean
mutually-exclusive binary in every row, exactly as the bundled `toMcpTool` source predicted:

```
readOnly (7):    browser_console_messages, browser_find, browser_network_request,
                 browser_network_requests, browser_take_screenshot, browser_snapshot,
                 browser_wait_for
destructive (17): everything else — including browser_navigate and browser_evaluate
```

**[first-hand]** This retires Q2's own "unverified" caveat: the annotation is no longer a static
read of bundled source, it is an observed wire payload.

### The complication

The measured locator flow calls `browser_navigate`, `browser_find`, `browser_evaluate`. Two of
those three — `navigate` and `evaluate` — are declared **destructive**. Option D's original text
claimed this exact flow "would... never prompt" under D; that claim is false. **[first-hand]**

Worked from the observed classification: on a first run, in a project with no prior trust,
`browser_navigate` gates (prompt 1), `browser_find` does not, `browser_evaluate` gates as a
different tool name that the first prompt's trust does not cover (prompt 2). **A first run of the
measured flow produces two prompts under D alone, not zero.**

### Why the server's classification is defensible, and still not the question Zone needs answered

`readOnly = tool.type === "readOnly" || tool.type === "assertion"` is a real, coherent line: it
separates *does this tool change browser state* from *does it not*. Navigation changes browser
state — a new page is loaded, new DOM exists — so classifying it alongside `browser_click` is not a
bug in the server's own terms.

But "changes browser state" is not Zone's question. Zone's question is narrower: **does this change
something in the target application** — the thing a locator-discovery task is investigating, not the
tool driving it. Navigating to a page a user already asked to look at and submitting a form on that
page are not the same risk, and `destructiveHint` does not distinguish them; it was never designed
to. The server's binary is honest about what the server can see from inside itself, which is a
different vantage point than the one an approval gate in front of it needs.

**The same coarseness cuts the other way for `browser_evaluate`, and this direction matters more.**
`browser_navigate` is over-gated by the binary — flagged at the same severity as a real mutation
when, for this project's use, it is closer to a read. `browser_evaluate` sits at the opposite end
and gets the identical flag: it runs arbitrary JavaScript in the page, correctly marked destructive,
but "destructive" says nothing about *how* destructive, so a page-load and an arbitrary-code-execution
capability report the same single bit. `browser_navigate` is over-gated for a low-risk action;
`browser_evaluate` is under-warned for a high-risk one — the same flag, pointing the wrong way at
both ends.

Worth one sentence by contrast: `browser_run_code_unsafe` (named in Q10.7/Q11.3 of the locator
investigation) carries its own warning in its name, independent of any annotation — an accident of
naming, not a mechanism, and the only tool in this set whose risk is legible without reading the
annotation at all.

### Consequences, named rather than resolved here

- **`sessionTrustedPrefixes` is what keeps this usable, not decorative.** Two prompts on a first
  run, `[T]rust` on each, and every subsequent call to `browser_navigate` or `browser_evaluate` in
  that project — this run or a later one, since the store is disk-backed — is silent. The
  measurement above is the *worst* case for D alone; the mechanism this report already recommended
  reusing is precisely what bounds it.
- **This strengthens B's role beyond "override for a rare disagreement" — and names a real cost of
  B, not just a reason to build it.** A user now has an ordinary, expected reason to declare
  `browser_navigate` pre-approved for a specific project — not because the server misclassified it,
  but because *this* project's use of it (loading a page to inspect) is not the risk
  `destructiveHint` was tracking. `browser_navigate` is precisely the tool that would go in that
  declaration. But the same mechanism cuts the other way for `browser_evaluate`: a user who
  pre-approves it reasoning "I only use it to count matches" has granted arbitrary code execution
  against whatever page happens to be open, not just the counting use they had in mind. **A per-tool
  approval declaration is only as good as the user's own model of what each tool can do, and the
  tool name does not carry that model for them.** Named as a consequence of building B, not a reason
  against it — B still narrows the surface to what the user chose; it just does not make that choice
  safe by itself.
- **Whether D's own default should be "gate everything destructive" or "gate everything destructive
  except a small built-in allowance" is now a real, open design question this report did not have
  to answer before this measurement.** Named here, not picked: a built-in allowance trades a clean
  binary for a curated exception list with its own maintenance cost, and nothing in this pass
  establishes which side of that trade is right.

---

## Options

Four, not the three the brief listed; the fourth is what Q2 opens. Each is judged on the question
that actually separates them: **what happens when a server update adds a mutating tool to a set the
user already allowlisted?**

### A — Prompt on every MCP call

Gate unconditionally at the dispatch site; every `mcp__*` call raises an approval.

- **Cost.** The measured locator flow made **3–4 MCP calls per run** (Q10/Q11 of the locator
  investigation), so 3–4 modal interruptions for a capture→propose→verify loop whose entire value is
  fluency. MCP is TUI-only, so there is no unattended path to fall back to — the capability simply
  cannot run unsupervised. *(Prompt count is derived from the recorded call counts in those runs, not
  observed under a prompting gate — unverified.)*
- **What it leaves open.** It carries no information about *which* call is dangerous:
  `browser_snapshot` and `browser_click` produce identical prompts, which trains the user to approve
  reflexively — the failure mode that makes a gate worse than useless.
- **Unanticipated tool.** Prompted like everything else. Safe, but the user still gets no signal
  that this one mutates.

Worth stating as the baseline that is unambiguously *safe*, and rejecting on usability rather than
on correctness.

### B — Per-tool approval declaration in `.zone/mcp.json`

Extend the `tools` allowlist that `ce419b0b` added — for example a sibling field naming which of the
listed tools require approval.

- **Cost.** Moderate and well-precedented: schema plus parse in `diskMcp.ts`, a gate at the dispatch
  site. The trust hash already covers the whole file, so editing it re-triggers the trust prompt
  (established in item 410), and the trust modal already renders the declared tool list, so the
  approval marking would be visible at approval time.
- **What it leaves open.** It asks the user to classify tools they may not understand. A tool added
  to `tools` but forgotten in the approval list is silently ungated — the same shape as the defect
  this whole arc keeps rediscovering, where an omission reads identically to a decision.
- **Unanticipated tool.** Already handled for *offering*: `ce419b0b` means a newly shipped tool is
  not registered at all unless the user names it. So the dangerous case is narrower than it looks —
  it requires the user to have deliberately allowlisted a tool and then mis-classified it.

### C — Route MCP through `executeTool`

- **Refuted by Q1.** There is no generic gate to inherit: `onApprovalRequired` (2 sites),
  `onEditApprovalRequired` (2 sites) and `checkWriteScope` (3 sites) all live inside specific tool
  branches. The only entry-level check is `allowedTools`, which the MCP path already passes.
- **Cost.** Strictly additive plumbing for no gain: thread `mcpManager` into `executeTool`, add a
  prefix-matching branch to a dispatch built on literal names, and then still write the gate by hand
  inside that branch — the same gate that could have been written at the existing dispatch site,
  which already holds every dependency it needs.
- **Recommended against**, on the call-site measurement rather than on preference.

### D — Gate on the server-declared `destructiveHint`, with B as an override

Stop discarding `annotations` at registration; gate at the dispatch site when the tool is not
declared read-only; treat a missing annotation as destructive (fail closed); let an explicit user
declaration in `.zone/mcp.json` win where the two disagree.

- **Cost.** Small and localised: keep one field at registration, read it at dispatch, reuse the
  existing approval bus and modal with an added `kind`.
- **Behaviour on the measured flow.** ~~`browser_navigate`, `browser_find` and `browser_evaluate`
  would be declared read-only by the server's own `toMcpTool` and never prompt; the first
  `browser_click` prompts once~~ — **wrong, per the live probe in the Addendum: `browser_navigate`
  and `browser_evaluate` are both declared destructive, only `browser_find` is read-only, and a
  first run of this exact flow produces two prompts under D alone, not zero.**
  `sessionTrustedPrefixes` on the tool name still makes each of those two once per project rather
  than once per call — see the Addendum's first consequence.
- **Unanticipated tool.** **The only option that handles it correctly by default.** A newly shipped
  mutating tool declares itself destructive and is gated without the user knowing it exists or
  having to classify it.
- **What it leaves open.** Hints are hints. A server update can change a tool's behaviour without
  changing its annotation, and the SHA-256 trust gate covers the config file, not the package it
  launches. This is precisely why the user declaration must remain authoritative, and why "no
  annotation" must mean "gate it".

---

## Recommendation

*This section is the recommendation. Everything above is findings.*

**Build D with B as the override, and document the PreToolUse hook as the answer available today.**

1. **D is the default** because it is the only option where a tool nobody anticipated is gated
   without anybody anticipating it. Every other option degrades to "the user classified it correctly
   in advance," which is exactly the assumption that fails.
2. **B overrides D**, not the reverse. Annotations are hints from a package the user launched but did
   not write; the declaration is the user's own statement. Where they disagree, the human wins —
   and a user who wants a declared-destructive tool ungated should have to say so explicitly.
3. **Missing annotation ⇒ gated.** A server that declares nothing gets the safe reading, matching
   the allowlist's own fail-closed choice in item 410 and the same reasoning
   `READ_ONLY_CAPABILITIES` records about denylists granting what they forget.
4. **Reuse the trust layers rather than inventing one.** Per-tool session trust falls out of the
   existing prefix mechanism with no change; server-level trust is a small derivation change. This
   is what keeps D usable rather than merely safe — without it, D degrades toward A.
5. **A is the safe baseline** and should be named as such in whatever is built — if D's annotation
   plumbing is deferred, unconditional prompting is the correct interim, not leaving the gap open.
6. **C should not be built.**

**Gate at the existing dispatch site**, not inside `executeTool`. Q1 establishes it already holds
every dependency a gate needs, and that `executeTool` offers nothing to inherit.

### Done — the one measurement this pass could not run, and what it changed

**Now measured, see the Addendum.** The annotations are real on the wire, which confirms D's central
premise. But the same probe found `browser_navigate` and `browser_evaluate` both declared
destructive, so D's own assumed default does not hold for the measured flow — the recommendation
to build D + B stands, but not on the "the flow stays quiet, only `browser_click` prompts" basis
this section originally argued from. Re-run the same probe whenever the server version changes;
nothing pins an annotation across releases.

### One thing this does not close

`checkWriteScope` still does not apply to MCP tools under any option here, because it is a
per-branch check keyed on file paths and an MCP tool exposes none. An approved `browser_click` is
gated by approval alone. That is a separate gap from the one this report addresses, and naming it
avoids the impression that an approval gate makes MCP calls scope-constrained. They are not.
