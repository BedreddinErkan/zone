# UI locator discovery — investigation

Can Zone find and verify UI locators itself, from a live application, rather than guessing them from
source or asking the user to point at an element? Web first; the pass also has to establish whether a
design forecloses Android/iOS later.

The target capability has three parts, and they turn out to have very different costs:

1. **Capture** a pruned interaction tree from a live page.
2. **Propose** a locator, informed by project guidelines rather than a generic heuristic.
3. **Verify** the proposal against the live page by running it and counting matches — 0 wrong, >1
   fragile, exactly 1 valid.

Part 3 is the whole point. Without it the tool still guesses, only better informed.

> **Amended 2026-08-28.** A constraint arrived after the original pass: the capability must serve
> *any* test framework the project uses — Playwright, Selenium, Cypress, Puppeteer, Appium,
> Cucumber/BDD, JUnit, TestNG and others — across web and mobile. **[Q7](#q7--the-multi-framework-constraint-added-after-the-original-pass)**
> works through the consequences. They are significant: the three-part split above is too coarse,
> one claim in the original Option C was wrong, and the Recommendation's verification half is
> superseded. Q1–Q6 are unaffected and stand as written.
>
> **Amended again, same day.** **[Q8](#q8--first-live-run-of-option-a-the-server-connects-and-the-model-never-sees-its-tools)**
> and **[Q9](#q9---force-tier-complex-moves-the-budget-but-not-the-tier)** record the first *live* run
> of Option A. They supersede the Evidence-base note below on one point — a browser MCP server has now
> been configured and connected — and they revise Option A's cost from "zero Zone code" to
> "small-but-nonzero". The recommendation's shape is unchanged.
>
> **Amended a third time, same day.** **[Q10](#q10--six-live-measurements-against-a-working-mcp-server)**
> records six live measurements from a working MCP server — closing unknown 1, adding data to
> unknowns 3, 7, 11 and 12, and correcting 8.4's own inference about which archetypes reach MCP
> tools. It also surfaces the largest open obstacle found so far: locator discovery classifies as a
> read-only archetype, and no read-only archetype can reach MCP tools at any tier. The Recommendation
> section itself is not edited here — this only records the obstacle.
>
> **Amended a fourth time, same day.** **[Q11](#q11--the-full-capability-unprompted-on-a-live-external-page)**
> records the first run where capture, propose, and verify all fired in one turn, unprompted, live
> against an external page — after `7e9baeb7` closed unknown 14. The recommendation's shape is
> unchanged; this is confirming evidence, not a new finding about it.

---

## Evidence base, and provenance

Six questions were researched in parallel and each was then adversarially verified by a second agent
told to refute rather than agree. **All six verifications returned PARTLY_UNSOUND** — 29 refuted
claims, 8 unsupported absence claims, 21 conflations. The corrections were substantial enough that
one question's headline answer inverted entirely (Q1). What follows is the corrected record, not the
first pass.

Provenance is marked throughout:

- **[first-hand]** — I ran the command or read the file myself for this report.
- **[verified]** — produced by research, then independently re-derived by the adversarial pass.
- **[static reading only]** — established by reading code, not by executing it.

Two limits on this pass, stated rather than left implicit. **No `.zone/mcp.json` exists on this
machine**, so nothing about a real MCP server's runtime behaviour was measured — only Zone's side of
the contract. And **no browser MCP server was installed or run**; claims about `@playwright/mcp` come
from its registry metadata and published README, marked as such.

---

## Q1 — What browser automation does Zone already have?

**Answer: none today — but the first pass's history answer was wrong, and the correction is the most
decision-relevant fact in this investigation.**

### 1.1 At HEAD: zero, and the absence is clean

No browser driver is a dependency, peer dependency, optional dependency, or bundled binary.
`package.json` has 26 dependencies and 13 devDependencies and **no `peerDependencies`,
`optionalDependencies` or `bundledDependencies` blocks at all**; `node_modules/playwright`,
`node_modules/@playwright` and `node_modules/puppeteer` are all absent. **[first-hand]**

There is no CDP/DevTools-Protocol code anywhere. `ws` is a dependency but is used at exactly one
production site — `src/remote/controlServer.ts` — for Zone's own token-authenticated remote-control
protocol, not a browser. That name collision was checked and correctly not conflated. **[verified]**

### 1.2 Zone once shipped a real in-process Playwright driver, and deleted it on purpose

This is the correction. The first pass reported that Zone's browser-adjacent history was only prompt
strings. It was not. **[first-hand]**

```
$ git show 9805d055^:src/tools/verifyVisual.ts | head -1
import { chromium, type Browser, type Page } from "playwright";

$ git show 9805d055^:package.json | grep -i playwright
40:    "playwright": "^1.50.0",
```

`verify_visual` was a registered `ZONE_TOOLS` entry dispatched by `toolExecutor`, holding a **browser
singleton**, writing to `SCREENSHOT_DIR = <cwd>/.zone/screenshots`, and returning `pageTitle` and
`consoleErrors`. It was actively maintained — 7 fix commits, growing 119 → 182 lines — and was
**not** removed for being broken. **[verified]**

The removal rationale, verbatim from the commit body of `9805d055` (2026-05-17): **[first-hand]**

> 2. Remove Visual verification tab + verify_visual agent tool +
>    Playwright dependency — production concern (headless Chromium
>    install across user OS). Removed cleanly across UI, backend
>    handler, agent tool registry, and package.json.

**A prior maintainer already evaluated bundling a browser driver into Zone and rejected it, for a
reason that has not changed.** Any proposal that reinstates Playwright as a Zone dependency is
re-litigating a settled decision and must answer that objection explicitly. This single fact does
more to constrain the design than anything else in this report.

Residues survive at HEAD, all unused: `.env.example` still advertises `ZONE_DEV_SERVER_URL` under
"Dev server URL the agent targets when calling verify_visual"; `.gitignore` still says "Runtime
artifacts (verifyVisual screenshots…)"; and `src/core/agentLifecycleEvents.ts` still documents a
field as existing because "verify_visual surfaces the screenshot via metadata". **[verified]**

### 1.3 Zone does drive the *user's* browser suite — unprompted

Every other browser-tool mention in the tracked tree is Zone **detecting** the user's project
(`detectFramework`, `scanRepo`, `rankRelevantFiles`), **classifying** a command string
(`verdictClassifier`, `noProgressFeeder`), or prose/fixture. None is Zone driving a browser.
(The first pass's census of "24 hit lines" was wrong — re-running its own command gives **49**;
the 20-file count was right. **[verified]**)

But the classification understates one thing. Zone's automatic verification can **issue**
`npx playwright test` itself: `detectFramework` sets `testCommand` to that literal string when the
target repo declares Playwright and has no `test` script, and `runStagingVerification` execs it with
a 90 s timeout and no approval gate. Separately, `npm test` and `npm run test` are on the
auto-approve whitelist — so a project whose `test` script *is* Playwright gets a browser launched
with no prompt. **[verified]**

**Inference.** Zone already causes browsers to run and already parses Playwright failure output; what
it lacks is a *control channel* to one. That is a narrower gap than "no browser capability".

---

## Q2 — How is a tool added?

`fetch_url` is the right exemplar and is genuinely recent: it landed in one commit `d0b4bc09`
touching 8 files. **[verified]**

**Mandatory (5 sites):** `src/tools/toolDefinitions.ts` (the `ZONE_TOOLS` entry + JSON schema),
`src/tools/builtinCapabilities.ts` (capability mapping — enforced by a module-load guard *and* a
test), `src/tools/toolExecutor.ts` (the dispatch handler), the implementation module itself, and
`src/core/toolCallIdentifyingArg.ts` (added 2026-07-31; its test iterates `ZONE_TOOLS` and fails
without a fixture).

**Not needed:** `tierToolSubsets.ts` — a new tool is complex-tier-only for free, because
`tierToolFilter` is an allowlist. And `scopeGuard.ts` is name-agnostic; a write tool calls the
generic `checkWriteScope` from its own handler instead. **[verified]**

**Test absolutes that move.** The most dangerous planning fact in this section: the cumulative
tool-description budget in `agentLoop.r3guard.test.ts:145` asserts `toBeLessThan(4400)`, and
importing `ZONE_TOOLS` and summing gives **4372 across 20 tools**. Since the bound is strict, the
maximum a new description can add is **27 characters**. Essentially any real tool breaks it and the
bound must be raised, exactly as `d0b4bc09` did when it went 4000 → 4400. **[first-hand]**

Also moving: `toolRegistry.test.ts` and `agentLoop.tierToolSubset.test.ts` length assertions; and
`src/llm/toolAbsenceNotice.test.ts`, which the first pass under-counted — it carries **six** literal
roster sets (three 20-name, two 18-name, one 19-name) and **seven** byte-pinned prompt strings, plus
five `it()` titles carrying counts. **[verified]**

**Three additional registration paths the checklist misses**, each relevant here:

- **MCP.** `src/mcp/mcpClientManager.ts` calls `registerTool({ name: namespacedName, capabilities:
  ["mcp.*"] })` at runtime. **An MCP-provided tool touches none of the five sites above and moves no
  test absolute.** **[verified]**
- **Provider-native server tools.** `web_search` is appended after translation in
  `convertParams.ts`, with no Zone-side registration site at all.
- **`src/llm/subagents.ts`** hand-lists `WORKER_ALLOWED_TOOLS` (5 names) and `AUDIT_ALLOWED_TOOLS`.

**Three production tool-name lists are already stale** — `agentLoop.ts`'s `allToolNames` (6 phantom
names, 9 missing) and `simpleSet`, plus `tokenBreakdown.ts` naming four tools that do not exist.
**[verified]**

---

## Q3 — Does anything hold a long-lived external process across turns?

**Yes: exactly one thing — the MCP stdio server pool.**

`McpClientManager` spawns its child processes once during `runTui` startup, before React mounts. The
manager is seeded into the Ink reducer state as `armedMcpManager`, read fresh at the top of every
turn, and **no reducer action clears it** except an explicit trust denial. Its only teardown is
process death. Answering the question's own triple: it survives (a) a tool call, (b) agent-loop
iterations, and (c) **TUI turns**. **[verified]**

The four background-command tools are the opposite. Their `ChildProcess` handles live in a
module-level `Map` keyed by `runId` — so they survive within one run, but each turn mints a fresh
`randomUUID()` runId and every accessor does `registry.get(input.runId)`, making them structurally
unreachable next turn. **[verified]** A real defect surfaced in passing: their cleanup is inline
rather than in a `finally`, so an Esc-abort skips it, and because the children are spawned
`detached: true` they do not die with Zone either — measured directly. Out of scope here; worth
filing separately.

**So a stdio browser MCP server would inherit the exact lifecycle this capability needs, with zero
new Zone code.** But three qualifications matter, and two are severe:

1. **Process persistence ≠ page persistence.** Zone's facts establish only that the *child process*
   survives. Whether a given browser MCP server holds a browser context open between JSON-RPC calls
   is a property of that third-party server and **was not measured**. *(Inference, medium
   confidence: `@playwright/mcp` hands out element `ref` handles from a snapshot that later tools
   consume, which only works if the page persists. Suggestive, not measured.)*
2. **Subagents cannot reach MCP tools at all.** `toolExecutor.ts` builds the subagent's
   `runAgentLoop({...})` input with no `mcpManager` — confirmed with paired greps and a positive
   control: **[first-hand]**
   ```
   $ command grep -n "mcpManager" src/tools/toolExecutor.ts   → exit 1 (no matches)
   $ git grep -n "mcpManager" -- src/tools/toolExecutor.ts    → exit 1 (no matches)
   $ git grep -c "mcpManager" -- src/llm/agentLoop.ts         → 4   (positive control)
   ```
3. **MCP tool calls skip every approval gate.** `agentLoop.ts` routes `mcp__*` straight to
   `mcpManager.callTool()`, bypassing `executeTool` entirely, so `onApprovalRequired` never fires.
   **[verified]**

MCP servers are also loaded **only on the TUI path** — headless never loads MCP — are stdio-only,
come only from a user-authored `<repoPath>/.zone/mcp.json`, and are SHA-256 trust-gated. **[verified]**

---

## Q4 — What does the tool-result budget look like?

**There is no general truncation layer.** Every cap is hand-rolled at each tool's own `return` site
in `toolExecutor.ts`, and the caps disagree on unit. **[verified]**

| Tool | Cap | Unit |
|---|---|---|
| `run_command` / `run_command_readonly` | head 100 + tail 50 | lines |
| `read_file` (>10K chars) | head 100 + outline + tail 50 | lines (mode switch, not a cap) |
| `search_in_files` (content mode) | 500 matches, then 4,000 | matches, then chars |
| `search_in_files` (`files_with_matches`/`count`) | 4,000, no count cap | chars |
| `list_files` | 100 entries, then 4,000 | entries, then chars |
| `find_references` | 50 | results |
| `fetch_url` | 100,000 | chars |
| `Task` (worker + explore) | `summary` 500 (`SUMMARY_MAX_CHARS`) | chars |
| **`mcp__*`** | **none** | — |

Corrections worth carrying: the `read_file` 10,000 figure is a **mode switch, not a cap**, and the
outline mode it selects is itself unbounded — measured, `read_file` on a 1,001,489-char file returned
**752,405 chars**. `Task` *is* capped at 500 (the first pass said "no cap"), though `explore`'s
`findings` array is uncapped. `toolResultSizeTracker.ts` is measure-only. The one generic 32,000-char
per-result cap, `BudgetReductionProcessor`, is registered only behind an env var nothing ever sets.
**[verified]**

**Practical budget:** from 988 real `[zone-tool-result-size]` records, per-result median is ~2.9 KB
(`read_file`) and ~2.2 KB (`search_in_files`); a whole run's tool-result mass has median 9,807 bytes
and max 75,244 across 105 runs. **A new tool should target ≤4,000 chars — the house cap — and must
cap itself, because nothing downstream will.** **[verified]**

**This is a direct constraint on part 1 of the capability**, and it cuts against MCP: an MCP-supplied
snapshot is the one result shape with *no* cap anywhere in the path.

---

## Q5 — What locator / test guidance exists?

**`docs/locator-guidelines.md` and `docs/test-strategy.md` do not exist.** **[first-hand]** Nor does
any locator vocabulary anywhere: no `.md` in the tree contains `data-testid`, `getByRole`,
`getByLabel`, or `css selector`. **[verified]**

The question's premise therefore needs correcting before it can be answered, and two near-misses have
to be separated from each other:

- **"No test-strategy document" (a filename claim) is true; "no test-strategy guidance" (a substance
  claim) is false.** `CLAUDE.md`'s "Operational notes for changes" is specific, prescriptive
  test-authoring guidance, and part of it is machine-checked —
  `src/test/homeWriterImportStyle.test.ts` scans `src/**` for a forbidden authoring pattern and fails
  the suite. **[verified]**
- Locator guidance *did* exist, in `src/roles/testEngineerContext.ts`, deleted wholesale at
  `2efee011` along with the whole role flow. It was **prompt-level** text. **[verified]**
- `src/core/validateLlmOutput.ts` is a genuinely machine-checkable rule set with a
  `PLACEHOLDER_SELECTOR` regex over `data-testid` — six issue codes gated to test files. It is
  orphaned *today*, but it had **five production call sites** until an unrelated server removal at
  `2cb7afaa`. It is dormant precedent, not a failed idea. **[verified]**

**Name collisions correctly not conflated:** `src/ast/astSymbolLocator.ts` is a Babel AST symbol
locator; every "selector" in the TUI design docs is a Redux-style state selector. Neither is a UI
locator. **[verified]**

### The mechanical constraint that decides part 2

Zone **does** ingest target-repo guidance at runtime: `readProjectMemoryBlock(repoPath)` reads the
target's `.zone/memory.md` into all three system-prompt assemblers. But it does not inject the file.
Reading it first-hand, it pushes exactly two things: **[first-hand]**

```ts
const initMatch = INIT_BLOCK_RE.exec(raw);
if (initMatch) parts.push(initMatch[1].trim());     // the <!-- ZONE_INIT_BEGIN/END --> block
const entries = parseEntries(raw);
if (entries.length > 0) parts.push(/* "## Session notes" + dated bullets */);
```

So free-form prose outside the `ZONE_INIT` markers **and** outside the dated-entry format is silently
dropped. A locator-guidelines document cannot simply be pasted into `.zone/memory.md`; it must occupy
one of those two structures. There is no `AGENTS.md` ingestion anywhere. **[verified]**

Cost of using it is settled by measurement already in the ledger: one uncached prefix pass on
iteration 1, then absorbed into cache breakpoint #2 — not a per-iteration re-bill. **[verified]**

**Conclusion for part 2: the precedent is decisively prompt-level, and the channel exists and is
live** — with a structural constraint on where the text has to sit.

---

## Q6 — Is there a "target application" notion?

**It exists in *delegated* form, and existed directly until it was deleted. It is not net-new.**

Deleted: `src/visual/devServerProbe.ts` exposed `DevServerConfig {baseUrl, defaultViewport}`,
resolved `ZONE_DEV_SERVER_URL` → `~/.zone/visual-verification.json` → `http://localhost:3000`, with
`probeDevServer(baseUrl)` for readiness. Removed in the same `9805d055` commit as `verify_visual`.
`.env.example` still declares `ZONE_DEV_SERVER_URL` with **zero readers**. **[verified]**

At HEAD there is no field, env var, or file naming a URL/host/port of a user-facing application.
Every `baseUrl` in production `src/` is one of three unrelated things — the LLM gateway endpoint,
tsconfig's `compilerOptions.baseUrl` (a filesystem path), or Zone's own hosted inference endpoint.
`--repo <path>` is a filesystem path. Of 120 distinct `ZONE_*` env vars, the four URL-shaped ones are
all Zone's own infrastructure. **[verified]** *(The user's rule against conflating same-named things
matters here: an LLM gateway `baseUrl` is not a target-app URL.)*

**The delegated form is the important part.** `detectFramework` detects a `devCommand` *string*
(`npm run dev`) — never a port or URL. But Zone routinely runs the project's own Playwright suite,
and **a Playwright project's own `playwright.config.ts` already carries `baseURL` and a `webServer`
block that starts the app**. Zone never parses either; it inherits both by handing off. **[verified]**

One live blocker if a tool tried to reach the app over HTTP itself: `fetch_url`'s `ssrfGuard` blocks
`localhost` and all of `127.0.0.0/8` before any request. **[verified]** That is narrower than "Zone
cannot reach a local app" — `run_command` running `curl` can, subject to one approval. **[verified]**

---

## Q7 — The multi-framework constraint (added after the original pass)

**Constraint:** the capability must serve any framework the user's project uses — named: Playwright,
Selenium, Cypress, Puppeteer, Appium, Cucumber/BDD, JUnit, TestNG, and others unnamed. Web and mobile.

**Answer up front: this makes the design simpler, not harder — but only after one axis error is
corrected and one of my own claims is retracted.** The original recommendation's verification half
does not survive; the capture and propose halves do.

### 7.1 The named list mixes two axes, and conflating them is the trap

Applying this report's own no-conflation rule to the constraint itself: the eight named frameworks are
not eight of the same kind of thing.

| | Carries a locator syntax? | Examples from the list |
|---|---|---|
| **Expression languages** | yes — this is what a locator is written in | Playwright, Selenium (`By.*`), Cypress (`cy.get`), Puppeteer, Appium |
| **Runners / harnesses** | **no** — they organise and execute tests, and delegate element lookup to a driver underneath | Cucumber/BDD, JUnit, TestNG |

**A JUnit or TestNG project tells you nothing about locator syntax.** Java + Selenium, Java +
Playwright-for-Java and Java + Appium are all "JUnit" projects with three incompatible locator
languages. Cucumber is a *specification* layer that sits above whichever driver is wired into its
step definitions. So "which framework?" is really two questions, and only the second one — *which
driver?* — constrains the expression step. **[Inference, high confidence — this is a property of
those tools, not of Zone.]**

### 7.2 The three-part split is too coarse; the real split is finding / expressing / verifying

| Stage | Varies by | Substrate |
|---|---|---|
| **Finding** an element | **nothing** — universal | the page's element tree: roles, names, attributes, position |
| **Expressing** a locator | the **driver**, not the runner | `getByRole` vs `By.xpath` vs `cy.get` vs an Appium accessibility id |
| **Verifying** a locator | the **expression language**, not the runner | a count over the tree, or a browser primitive |

The original report collapsed *expressing* and *verifying* into one framework-dependent step. They are
not the same: two frameworks with different syntax can share a verification mechanism whenever their
syntax reduces to the same query.

### 7.3 Most expression languages verify without their runner — including, it turns out, the ARIA case

| Expression family | Used by | How to count matches | Needs the framework's runner? |
|---|---|---|---|
| **CSS selector** | Selenium `By.cssSelector`, Cypress `cy.get`, Puppeteer `$`, Playwright `locator('css=')`, WebdriverIO | `document.querySelectorAll(s).length` | **No** — standard DOM API |
| **XPath** | Selenium `By.xpath`, Puppeteer `$x`, Appium | `document.evaluate(...).snapshotLength` | **No** — standard DOM API |
| **id / name / class / tag** | Selenium `By.id`/`By.name`/… | trivially reducible to CSS | **No** |
| **link text** | Selenium `By.linkText` | a DOM walk over `<a>` text | **No** — small shim |
| **visible text** | Cypress `cy.contains`, Playwright `getByText` | DOM text scan | **Approximate** — normalisation/substring rules differ per framework |
| **ARIA role + accessible name** | Playwright `getByRole`, Testing Library, Cypress+TL | see below | **No** — but not via plain DOM either |
| **Appium UiAutomator / iOS predicate / class chain** | Appium | driver-evaluated DSLs | **Yes** — device required |

**The retraction.** The original Option C said CDP "cannot verify semantic locators at all — CDP gives
`querySelectorAll`, not `getByRole`." **That was wrong.** The Chrome DevTools Protocol Accessibility
domain exposes `queryAXTree`, documented as *"Query a DOM node's accessibility subtree for accessible
name and role"*, taking `accessibleName` and `role` parameters and returning matching nodes; `AXNode`
carries computed `role` and `name`. **[external — CDP published protocol docs]** Role and accessible
name are computed *by the browser*, not by Playwright.

**Consequence:** all three dominant expression families — CSS, XPath, and ARIA role+name — are
countable using browser primitives alone, with no test framework installed. The genuinely
runner-bound cases are Appium's driver DSLs and the exact-fidelity edges of text matching.

There is a second route to the ARIA case that needs no CDP at all: **the captured accessibility tree
already contains roles and names**, so counting role+name matches is a query over the snapshot the
capture step already produced. Less faithful than executing the locator (no visibility or strictness
semantics), but free and framework-independent.

**Honest limit on both routes:** browser-computed role+name matching is a *high-fidelity
approximation* of `getByRole`, not a guarantee of identity — Playwright layers its own visibility
rules, name normalisation and `exact` option on top. Unmeasured; see unknown 7 below.

### 7.4 What Zone knows about the project's framework — a much weaker signal than expressing needs

`detectFramework` produces `ProjectFramework.testFramework`, typed as a bare `string`, not a union.
**[first-hand]** Across every language branch it can emit exactly: `vitest`, `jest`, `mocha`,
`cypress`, `playwright`, `pytest`, `cargo`, `go test`, `junit`, `phpunit`, `rspec`, `unknown`.

Three defects for this purpose, all first-hand:

1. **Selenium, Puppeteer, Appium, WebdriverIO and Cucumber are not detected at all.** Paired greps
   over `src/repo/`, with the stale `rankerBaseline.snapshot.json` fixture excluded — its hits name
   *deleted* files and are exactly the hazard CLAUDE.md warns about:
   ```
   $ command grep -rniE "selenium|puppeteer|appium|webdriverio|cucumber" src/repo/   → only testng.xml + the stale fixture
   $ git grep     -niE "selenium|puppeteer|appium|webdriverio|cucumber" -- src/repo/ → same
   $ git grep -c -iE "cypress|playwright" -- src/repo/detectFramework.ts             → 10  (positive control)
   ```
   TestNG appears only as the config *filename* `testng.xml` in a file-existence list; it never sets
   `testFramework`.
2. **The JS/TS branch is first-match-wins**, ordered `vitest → jest → mocha → cypress → playwright`.
   A project with Jest for unit tests and Playwright for e2e reports **`"jest"`** — the Playwright
   half is invisible. This is the common shape in real repos.
3. **`junit` names a runner, not a driver** (7.1), so the Java answer carries no locator information.

A richer taxonomy did once exist: `src/core/confidenceGate.ts` branched on `selenium_java`,
`cucumber_java`, `playwright_ts` and `cypress`. The module is still live at HEAD (imported by
`src/cli/index.ts:50`, called at `:749`), but **those framework values were removed** — deleted with
the role flow at `2efee011`. **[first-hand]** Prior art exists for a driver-level taxonomy; it was
taken out.

**The plumbing to give a tool this knowledge already exists and is live.** `toolExecutor.ts:24`
imports the type and `:980` declares `framework?: ProjectFramework` on the tool input;
`agentLoop.ts:5262` populates it from `input.framework`. The only current consumer is
`toolExecutor.ts:1147`, which forwards it to subagents — **no tool handler reads it for its own
logic.** A new tool could read `input.framework` with zero new plumbing. **[first-hand]**

**So: detection reaches a tool, but what it detects is too coarse to choose an expression language.**
Closing that gap means either extending `detectFramework` (reinstating something like the deleted
driver taxonomy) or asking the model to infer the driver from the repo's existing test files — which
it can already read.

### 7.5 Mobile: the split holds, and breaks in one identifiable place

**[static reading only / external — no device or Appium server was run in this pass.]**

- **Finding** is per platform: Android exposes a UiAutomator view hierarchy, iOS an XCUITest
  accessibility hierarchy. Appium normalises both to an **XML page source**.
- **Expressing** is per driver, as on web.
- **Verifying** splits cleanly in two: XPath and attribute/accessibility-id matches are queries over
  that XML and are countable **offline, from a captured page source, with no device attached** —
  structurally the same move as counting over a captured a11y tree on web. What *breaks* is
  `-android uiautomator`, `-ios predicate string` and `-ios class chain`: these are DSLs the driver
  evaluates on-device, and no offline query reproduces them.

So the three-way split survives the platform change; only the runner-bound tail grows.

### 7.6 What this does to the three options

- **Option A (MCP)** is *strengthened*. Its weakness was "cannot verify Playwright's semantic
  locators." Under the constraint, most target frameworks don't use those, and the ones that do can be
  served by counting over the snapshot `browser_snapshot` already returns. Critically, **the capture
  driver is not the project's framework** — driving a page with Playwright MCP to inspect it does not
  require the project to use Playwright, any more than opening DevTools does.
- **Option B (bundle Playwright)** is *weakened*, not strengthened. Its sole advantage was exact
  `locator.count()` fidelity — which is now one framework's fidelity out of many, bought at the price
  the `9805d055` objection already rejected. It would give perfect answers for Playwright projects and
  nothing extra for Selenium, Cypress, Puppeteer or Appium ones.
- **Option C (CDP)** is *less wrong than I said* — `queryAXTree` does give role+name — but its other
  objections stand unchanged: Chrome-only, forecloses mobile hardest, and reimplements session and
  navigation management that an MCP server already provides.

---

## Implementation options

> **Note (amended).** Option C's ARIA claim below is retracted — see 7.3. The rest stands.

### Option A — Browser MCP server, via the existing MCP seam

Zone ships nothing. The user configures `@playwright/mcp` (registry-confirmed: v0.0.79, bin
`playwright-mcp`, depends on `playwright` + `playwright-core` **[first-hand]**) in
`<repoPath>/.zone/mcp.json`.

- **Part 1 (capture): solved, and well.** `browser_snapshot` returns an accessibility snapshot with
  `ref` handles and has `depth` and `boxes` parameters — pruning controls, purpose-built for LLM
  context. **[from published README]**
- **Part 2 (propose): unsolved by this option** — prompt-level work either way (Q5).
- **Part 3 (verify): only partially.** There is **no tool that takes a Playwright locator string and
  returns a match count.** `browser_evaluate` runs arbitrary JS, so it can count
  `document.querySelectorAll(css).length` — but it cannot faithfully evaluate `getByRole` /
  `getByLabel`, whose ARIA-role and accessible-name computation is exactly what makes those locators
  worth proposing. **[from published README]**
- **Touches:** nothing in Zone. No tool registration, no test absolutes (Q2).
- **Answers the `9805d055` objection cleanly:** the browser is installed by the user who opts in;
  Zone ships no Chromium and no postinstall.
- **Leaves unsolved / costs:** no subagent access; no approval gate; **no output cap** on the one
  result shape that most needs one (Q4); TUI-only; page-persistence unmeasured.
- **Mobile:** does not foreclose — `@mobilenext/mobile-mcp` (1.0.2) and `appium-mcp` (1.92.9) exist.
  **[first-hand]**

### Option B — First-class Zone browser tools, Playwright as a dependency

Reinstate something close to `verify_visual`, extended with snapshot + locator-count tools.

- **Parts 1 and 3: both fully solved**, with exact `locator.count()` semantics and full control over
  pruning policy and the 4,000-char budget.
- **Touches:** all five registration sites, the 4,372/4,400 description budget, `toolAbsenceNotice`'s
  six rosters and seven byte-pinned strings, plus a new long-lived-process owner replicating the MCP
  manager's teardown at four process-death sites (Q3).
- **Leaves unsolved:** **it re-litigates `9805d055` head-on.** The headless-Chromium install burden
  is unchanged, and `optionalDependencies` would be a new pattern for this repo (it has none).
- **Mobile:** forecloses without a driver abstraction — Playwright has no native mobile.

### Option C — CDP directly over the existing `ws` dependency

Attach to a user-launched Chrome on `--remote-debugging-port`.

- **No new dependency.** ~~But it reimplements accessible-name and role computation from scratch, and
  **cannot verify semantic locators at all** — CDP gives `querySelectorAll`, not `getByRole`.~~
  **SUPERSEDED — this was wrong (see 7.3).** CDP's Accessibility domain exposes `queryAXTree`, which
  takes `accessibleName` and `role` and returns matching nodes, with computed `role` and `name` on
  every `AXNode`. CDP needs no reimplementation of accessible-name computation; the browser does it.
- **The objections that survive:** Chrome-only; forecloses mobile hardest; and it would have to
  reimplement browser launch, session lifetime and navigation — all of which an MCP server already
  provides for free (Q3).
- Still assessed as weakest, but for transport and lifecycle reasons rather than capability ones.

---

## Open unknowns, and the cheapest instrument for each

| # | Unknown | Cheapest instrument |
|---|---|---|
| 1 | ~~Does a browser MCP server keep a page open between JSON-RPC calls? (Q3's live caveat)~~ **CLOSED — see 10.1.** | Install `@playwright/mcp` in a scratch `.zone/mcp.json`, call `browser_navigate` then `browser_snapshot` in two separate turns, and see whether the second still sees the page. **Run live: yes — the page was still open two turns after navigation.** |
| 2 | Can `browser_evaluate` be used to faithfully count a *semantic* locator? | Ask it to evaluate a role+name match against the snapshot's own tree; compare with `npx playwright` running the same `getByRole(...).count()` on the same page. Disagreement is the answer. |
| 3 | What does an MCP snapshot actually cost in chars on a real app page? Q4 says nothing caps it. | One `browser_snapshot` against a mid-complexity page; measure the result string. Compare against the 4,000-char house cap. **Partial data from 10.2 (n=1): the tool result reaching Zone was 324 bytes, not the tree — `browser_snapshot` hands back a reference. The 13,142-char tree exists, but on disk, not in the prompt, so this instrument as originally phrased measured the wrong string; not closed.** |
| 4 | Does the suite still pass with a 21st tool? Q2's "six always / four conditional" split is inferred, never run. | Add a no-op tool on a scratch branch, run `npm test`, read the failure list. Discard the branch. |
| 5 | Would a `webServer`-backed Playwright run start the app for us, or expect it already running? | Read a real target repo's `playwright.config.ts` `webServer` block; `npx playwright test --list` shows resolution without executing. |
| 6 | Is the `9805d055` Chromium objection still live for the *maintainer*, given MCP moves the install to the user? | Ask. It is a judgement about product burden, not a fact about the code — no instrument closes it. |
| 7 | **(Q7)** How closely does browser-computed role+name matching track Playwright's `getByRole`? 7.3 calls it high-fidelity but unmeasured. | On one page, compare three counts for the same role+name: `queryAXTree`, a count over `browser_snapshot`'s tree, and `npx playwright` running `getByRole(...).count()`. Any divergence bounds the approximation. **First data point from 10.6 (n=1, one synthetic page, one locator, one browser): Playwright and CDP `queryAXTree` agreed exactly; a plain DOM count under-matched. Supports 7.3; does not settle it — this measurement compared Playwright/CDP/plain-DOM, not a count over `browser_snapshot`'s own captured tree as specified here.** |
| 8 | **(Q7)** Is counting over a *captured* snapshot equivalent to counting against the *live* page? Snapshots may omit hidden/offscreen nodes the live query would match. | Same page, same locator: count over the snapshot vs. via `browser_evaluate` against the live DOM. |
| 9 | **(Q7)** Can the driver be inferred from the repo's test files when `detectFramework` says only `"jest"` or `"junit"`? | On 3–5 real repos, grep their test sources for `By\.`, `cy\.`, `page\.getBy`, `driver\.findElement`, `@AndroidFindBy`. Compare with what `detectFramework` reports. |
| 10 | **(Q7)** Does an Appium page source support offline XPath counting in practice (7.5 argues structurally, nothing was run)? | Capture one `getPageSource` XML from an emulator; run an XPath count over it offline; compare with the same locator through the driver. |

---

## Recommendation

*This section is the recommendation. Everything above is findings and inferences.*

**Do not reinstate Playwright as a Zone dependency.** Option B is the exact design a prior maintainer
already removed, and the stated reason — headless-Chromium install burden across user OSes — is
unchanged by anything in this investigation. Proposing it again without new information would be
re-litigating a settled decision.

**Do not build Option C.** It cannot verify the locators worth proposing, and it forecloses mobile.

**Recommended: a hybrid that uses each existing seam for what it is actually good at.** The three
parts of the capability do not want the same mechanism, and the mistake to avoid is picking one
mechanism for all three.

- **Capture (part 1) → browser MCP server.** This is nearly free: no Zone code, no registration
  sites, no test absolutes, and `browser_snapshot`'s `depth`/`boxes` parameters are already a pruning
  policy. **One caveat must be handled rather than inherited:** MCP results have no cap anywhere in
  Zone's path (Q4), and this is the single largest result shape in the system. If snapshots routinely
  exceed a few thousand chars, that argues for a thin Zone-side wrapper whose only job is to prune
  and cap — which is a much smaller thing to build than a browser driver.

- **Propose (part 2) → prompt-level, through the existing project-memory channel.** Q5 settles this:
  the precedent is prompt-level, the mechanism is live, and the cost is one uncached prefix pass.
  Write the guidance as a `<!-- ZONE_INIT_BEGIN -->` block in the target repo's `.zone/memory.md` —
  **not** as free prose, which `readProjectMemoryBlock` silently drops. If a machine-checkable rule
  set is wanted later, `validateLlmOutput.ts`'s `PLACEHOLDER_SELECTOR` is dormant precedent with five
  historical call sites, not a new idea.

  **Amended by Q7:** this is now the *only* framework-dependent step, which raises its stakes — it
  must emit `By.xpath` for a Selenium project and `getByRole` for a Playwright one. Zone's own signal
  is too coarse to decide that (7.4): `detectFramework` cannot see Selenium, Puppeteer, Appium,
  WebdriverIO or Cucumber at all, reports first-match-wins so a Jest+Playwright repo reads as
  `"jest"`, and answers `"junit"` for every Java project regardless of driver. Two ways to close it,
  and **prefer the second to start**: extend `detectFramework` with a driver-level taxonomy
  (reinstating what `confidenceGate.ts` lost at `2efee011`), or let the model infer the driver from
  the repo's existing test files, which it can already read and which needs no code at all. The
  `framework` field already reaches tool handlers unread (7.4), so the first option is plumbing-free
  if it is wanted later.

- ~~**Verify (part 3) → the project's own Playwright, which Zone already runs.** This is the part worth
  arguing for. Verification must execute in an engine with Playwright's own role and accessible-name
  semantics, because that is precisely what `getByRole` encodes — and neither `browser_evaluate` nor
  CDP has it. Zone already shells out to the user's Playwright suite and already parses its failure
  output (Q1.3). Running a generated one-line check in that context inherits three things for free:
  the correct locator semantics, the project's `baseURL`, and its `webServer` block that starts the
  app — which is why **Q6 needs no new target-app config on this path**.~~

  **SUPERSEDED by Q7.** Two of its premises fail under the multi-framework constraint. Its factual
  premise was wrong — CDP *does* compute role and accessible name (7.3) — and its architectural
  premise assumed a Playwright project, which is now one case among many; a Selenium, Cypress,
  Puppeteer or Appium project inherits none of the three free things it claimed. **Replaced below.**

- **Verify (part 3) → a framework-independent count over the captured tree, with the project's runner
  demoted to an optional high-fidelity check.** Q7.3 is the reason: CSS, XPath and ARIA role+name all
  count using browser primitives alone, so verification does not need — and should not wait on — the
  project's test framework. Concretely: CSS and XPath via `browser_evaluate`
  (`querySelectorAll` / `document.evaluate`); role+name by querying the tree `browser_snapshot`
  already returned. That one mechanism serves Playwright, Selenium, Cypress, Puppeteer and
  WebdriverIO projects identically, and mobile follows the same shape over an Appium page source
  (7.5). Delegating to the project's own runner stays available for the two cases it genuinely earns
  — confirming an ARIA locator at exact fidelity, and Appium's on-device DSLs — but it is a fallback,
  **not the general mechanism.**

**Does the constraint favour Option B instead? No — it weakens it.** The question deserves a direct
answer because the constraint plausibly cuts the other way. Option B's one advantage over A was exact
`locator.count()` fidelity. Under the constraint that is fidelity for *one* driver among many, and
7.3 shows the other drivers' expression languages are countable with browser primitives that need no
Playwright at all. So Option B would pay the full `9805d055` cost — the headless-Chromium install
burden across user OSes, which remains unanswered and which I am not proposing to re-litigate — to
buy an advantage that now applies to a minority of target projects. **The constraint makes A better
and B worse.**

**Sequence it so the cheap half proves itself first.** Unknowns 1–3 remain the gate on part 1, and
Q7 adds 7–9 as the gate on part 3 — all closable in well under a day with no Zone code written.
Unknown 7 in particular decides whether the fallback to the project's runner is ever needed or is
just insurance. Nothing should be built before they are answered — the history in Q1.2 is a direct
warning about building browser capability into Zone ahead of the evidence.

**On mobile:** the recommended shape does not foreclose Android/iOS, and Q7.5 firms up why. The MCP
seam is protocol-agnostic and mobile servers already exist; the finding/expressing/verifying split
survives the platform change; and Appium's XML page source supports the same offline counting that
the web a11y tree does. The one part that does not carry over is Appium's on-device DSLs
(`-android uiautomator`, `-ios predicate string`, `-ios class chain`), which need the driver and are
exactly what the fallback path is for. Option B is still the one that would foreclose mobile.

**One thing this recommendation does not solve.** The read path is clean, but an MCP-supplied browser
tool bypasses `onApprovalRequired` entirely (Q3), so navigation and interaction would occur with no
approval gate — on a capability whose whole purpose is driving a live application. That is acceptable
for read-only snapshotting and is not acceptable for a tool that clicks. If this grows past capture
and verification into interaction, the approval gap has to be closed first, and closing it means
Zone-side code — at which point the Option A/Option B boundary moves.

---

## Q8 — First live run of Option A: the server connects, and the model never sees its tools

*Added after the recommendation, from a real run. This is the first live measurement against Option A
and it changes what that option costs.*

**Measured by the user**, live, in an empty repo with a valid `.zone/mcp.json` declaring
`@playwright/mcp`:

```
[zone-mcp-connected] { serverName: 'playwright', tools: 24 }
```

The server connects and registers 24 tools. Across three runs, `toolsAvailable` contained no `mcp__*`
tool at all:

```
archetype "question",   tier simple → ["read_file","run_command_readonly"]
archetype "simple_add", tier simple → ["apply_patch","multi_edit","read_file","run_command","write_file"]
```

Both observed lists are **reproduced exactly** below, from the real filter code. Nothing about this
is environmental.

### 8.1 The observation is a real defect, not a misread log

The question was posed with an escape hatch: if MCP tools never enter `toolsAvailable` and reach the
model some other way, the log means something else and there is no defect. **That is not the case.**

`toolsForLLM` — the array `[zone-agent-loop-entry]` logs as `toolsAvailable` (`agentLoop.ts:3199`) —
is built by `const resolvedTools = resolveToolList(effectiveFilter);` (`agentLoop.ts:2626`).
`resolveToolList` iterates the module-level `registry` Map in `toolRegistry.ts`, which is **the same
Map** `mcpClientManager.ts:116` writes into via `registerTool({ name: namespacedName, capabilities:
["mcp.call"], definition })`. Same module, same process, same Map. **MCP tools are architecturally
eligible to appear in `toolsAvailable`, and do.** **[first-hand]**

Confirmed by measurement — registering a fake MCP tool exactly as `mcpClientManager` does, then
running the real `resolveToolList` across the real filters:

```
MCP tool visible to the model under each filter:

  YES  (21 tools)  no filter at all (filterSource 'none')
  no   ( 5 tools)  tier simple      -> allowToolNames
  no   ( 9 tools)  tier medium      -> allowToolNames
  YES  (21 tools)  tier complex     -> undefined
  no   ( 2 tools)  dispatcher: read-only pipeline (question/investigation)
  YES  (19 tools)  dispatcher: non-read-only, excludes present
  YES  (21 tools)  dispatcher: non-read-only, no excludes
  YES  (21 tools)  dispatcher: null pipeline (debug / complex_multi_file)
  no   ( 8 tools)  hypothetical allow: READ_ONLY_CAPABILITIES
  YES  (21 tools)  hypothetical allow: ALL_CAPABILITIES
```

The two `no` rows matching the live runs resolve to the observed lists byte-for-byte: **[first-hand]**

```
question/investigation (read-only, no exploration): ["read_file","run_command_readonly"]
tier simple:  ["apply_patch","multi_edit","read_file","run_command","write_file"]
```

### 8.2 The gate: no `allow` set in the codebase contains `mcp.call`

`resolveToolList`'s rule (`toolRegistry.ts:52`) is
`hasAllowFilter = allow !== undefined || allowToolNames.size > 0`. When that is true, a tool survives
only by being named in `allowToolNames` or by having **every** capability present in `allow`.

An MCP tool carries exactly one capability, `mcp.call`. That string occurs in exactly four places in
the tracked tree — both instruments agree, and the fourth is the tell: **[first-hand]**

```
$ git grep -n 'mcp\.call' -- src/ ':!src/repo/rankerBaseline.snapshot.json'
src/mcp/mcpClientManager.test.ts:155:it("T-SUBAGENT-EXCLUDE: capability-allow without mcp.call excludes mcp tools", …)
src/mcp/mcpClientManager.ts:116:      registerTool({ name: namespacedName, capabilities: ["mcp.call"], definition });
src/tools/capabilities.ts:22:  | "mcp.call";          # the Capability union member
src/tools/capabilities.ts:32:  "mcp.call",            # inside ALL_CAPABILITIES
$ command grep -rn 'mcp\.call' src/ --include=*.ts   # same four (plus the union line)
```

The only allow-set containing `mcp.call` is `ALL_CAPABILITIES` — and `ALL_CAPABILITIES` is **never
used**: its sole occurrence in the tree is its own declaration (`git grep -n "ALL_CAPABILITIES"` →
one line, `capabilities.ts:24`). `READ_ONLY_CAPABILITIES` is `{fs.read, shell.exec}` and does not
contain it.

The `allowToolNames` route is closed by construction rather than by omission: `tierToolFilter` returns
`{ allowToolNames: SIMPLE_TIER_TOOLS }` / `{ allowToolNames: MEDIUM_TIER_TOOLS }`
(`tierToolSubsets.ts:46-50`), and those are literal name lists fixed at authoring time. **An MCP tool
name is not knowable when they are written** — it is `mcp__<serverName>__<toolName>`, composed at
connect time from the user's own config.

**So every allow-shaped filter excludes every MCP tool, and there is no filter anywhere that does
otherwise.** Two tests pin this rather than merely permitting it — `T-SUBAGENT-EXCLUDE`
(`allow: {fs.read, fs.write}` excludes MCP) and its sibling (`allowToolNames: SIMPLE` excludes MCP).
**This is designed, tested behaviour, not an oversight in the filter.** The design gap is one level
up: nothing ever puts `mcp.call` into an allow set or MCP names into `allowToolNames`.

### 8.3 Why the model could name a tool it was never offered

The user noted the model named `mcp__playwright__browser_navigate` specifically, and inferred it could
see the tools were excluded rather than being ignorant of them. **That inference is exactly right, and
the mechanism is `buildToolAbsenceBlock`** (`toolAbsenceNotice.ts:64`), whose first line is
`const fullNames = resolveToolList(undefined).map((t) => t.name);` — the **unfiltered** list, which
the matrix above shows includes MCP tools. Measured, with two fake MCP tools registered and the
read-only filter applied: **[first-hand]**

```
TOOLS NOT AVAILABLE THIS RUN — withheld by this task's archetype (question), not a permission error:
Task, TodoWrite, apply_patch, ask_user, fetch_url, find_references, kill_background, list_background,
list_files, mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot, multi_edit,
read_background_output, revert_patch, run_command_background, search_in_files, suggest_scope_change,
update_memory, write_file. Do not attempt these via another tool or a shell workaround.
```

Zone tells the model these tools exist and are withheld, by name, in the same run in which it refuses
to offer them. That is coherent behaviour — but it means the capability is not merely missing, it is
**visibly** withheld, which is why the model reported it so precisely.

### 8.4 The window in which MCP tools do reach the model

From the matrix, MCP tools appear iff `hasAllowFilter` is false — i.e. `effectiveFilter` is
`undefined` **or** carries only `excludeToolNames`. Given the precedence chain
(`capabilityFilter > tierFilterFromClassifier > allowedTools > modeDefault`, `agentLoop.ts:2471-2486`)
that requires **all** of:

- **complex tier** — `tierToolFilter` returns `undefined` only there (`tierToolSubsets.ts:49`); and
- a **non-read-only or null** dispatcher pipeline — `buildDispatcherCapabilityFilter` attaches
  `allow: READ_ONLY_CAPABILITIES` only for `readOnlyPipeline`, and returns `undefined` for a null
  config (`archetypeDispatcher.ts:160-178`), i.e. archetypes `debug` and `complex_multi_file`; and
- no `allowedTools` and no explicit `mode`.

**Inference (high confidence, follows from the measured matrix plus the precedence chain):** a browser
MCP server is unusable at simple and medium tier, and unusable in the `question` and `investigation`
archetypes — which are precisely the read-only, inspect-the-page shapes a locator-discovery task most
naturally classifies as. The one archetype pair where it works, `debug`/`complex_multi_file`, is also
the pair where `checkWriteScope` is bypassed entirely (Q6 of the original pass).
**Narrower than now known — see 10.3: `simple_add`/`complex` also reaches the full toolset, measured
live, so "the one archetype pair" understates how many write-shaped archetypes clear this window.**

### 8.5 What this costs Option A

Option A was recommended partly on "**touches nothing in Zone** — no tool registration, no test
absolutes." **That is still true of getting the tools registered, and false of getting them used.**
The corrected cost:

- A capability filter must learn to grant `mcp.call`, or MCP names must reach `allowToolNames`. Either
  is a small change, but it is a change to `resolveToolList`'s inputs at every site that builds an
  allow-shaped filter — the tier subsets and the dispatcher — not a one-line addition.
- Two tests pin the current exclusion and would have to move. Per the original pass's own rule: this
  is a case where a pinned test must move, so it needs reporting before changing, not changing.
- This is **separate from, and additional to,** the two MCP caveats Q3 already recorded (no subagent
  access, no approval gate). Option A's "zero Zone code" claim now holds only for the connect path.

None of this changes the recommendation's *shape* — MCP is still the cheapest capture route and still
the one that answers `9805d055`. It changes the estimate: Option A is small-but-nonzero Zone work, not
zero.

---

## Q9 — `--force-tier complex` moves the budget but not the tier

**Measured by the user:** `zone --force-tier complex` still logged `tier: "simple"` from the
classifier and simple-tier constraints, while `[zone-iter-budget-discarded]` showed
`effectiveMaxIterations 120` rather than 45.

**The flag is read, is threaded, and is applied — at exactly one behavioural site.** Nothing overrode
it; it was never wired to the other one.

**The path that works.** `--force-tier <tier>` is a registered commander option (`cli/index.ts:1255`),
read at `:124`, resolved by `resolveForceTier` (`config.ts:287-288`, which also accepts
`ZONE_FORCE_TIER`), carried on `CliConfig.forceTier`, threaded through `dispatch.ts` →
`runLlmPatchFlow.ts:5904` → `agentLoop`. There it reaches **one** consumer that changes behaviour:

```ts
const tierLimits = isSubagentLoop
  ? null
  : resolveTierLimits(input.taskClassification, { forceTierOverride: input.forceTier });   // agentLoop.ts:2540-2542
```

`resolveTierLimits` honours it first, ahead of the classification (`tierLimits.ts:57-60`). Measured
directly against a task classified `simple`: **[first-hand]**

```
--force-tier (unset):   softIterWarn 15  -> *3 = 45    maxSubagentCalls 0    tool subset 5 tools
--force-tier complex:   softIterWarn 40  -> *3 = 120   maxSubagentCalls 4    tool subset 5 tools
```

The `45 → 120` the user saw is exactly `softIterWarn × 3` moving from the simple to the complex
`TIER_LIMITS` row. The subagent quota moves `0 → 4` in the same step — a second effect of the flag
that the run did not surface.

**The path that does not.** The tool subset is derived from the classifier's tier, and does not
consult `forceTier`:

```ts
const tierFilterFromClassifier = (!isSubagentLoop && input.taskClassification?.tier)
  ? tierToolFilter(input.taskClassification.tier)      // agentLoop.ts:2454 — classification, not forceTier
  : undefined;
```

And the classifier never sees the flag at all — paired, with a positive control: **[first-hand]**

```
$ command grep -n "forceTier" src/llm/taskClassifier.ts   → exit 1 (no matches)
$ git grep     -n "forceTier" -- src/llm/taskClassifier.ts → exit 1 (no matches)
$ git grep -c "tier" -- src/llm/taskClassifier.ts          → 67   (positive control)
```

So `classifyTask` runs normally, returns `tier: "simple"`, and that value is what the log reports,
what `tierToolFilter` reads, and what every other `taskClassification.tier` consumer reads. The only
other `forceTier` reference in `agentLoop.ts` is the `forceTier === "simple"` mismatch detector
(`:2621`), which is diagnostic, not corrective.

**Finding:** `--force-tier` is a tier-*limits* override, not a tier override. Its `--help` text —
"Force classification tier: simple | medium | complex" (`cli/index.ts:1255`) — describes the one
thing it does not do. The split the user observed is the exact and complete signature of that.

**Why it matters here, and not only in general.** Forcing complex tier is the natural workaround for
8.4 — complex is the one tier where `tierToolFilter` returns `undefined` and MCP tools survive. That
workaround does not work, because the flag does not move the tier that `tierToolFilter` reads. The two
findings compound: **there is currently no user-facing way to make a browser MCP server reachable**
short of a task the classifier independently rates complex with a `debug` or `complex_multi_file`
archetype. `ZONE_FORCE_TIER` shares `resolveForceTier` with the flag and reaches the same single
consumer, so it is not an alternative route. **[static reading only — the env-var path was not run.]**

**Open unknowns from Q8/Q9, with the cheapest instrument for each:**

| # | Unknown | Cheapest instrument |
|---|---|---|
| 11 | Do MCP tools actually appear at complex tier in a real run, as the matrix predicts? The matrix is unit-level; no live run has hit that window. | One live run on a task phrased to classify `debug` or `complex_multi_file`, with the MCP config in place; read `toolsAvailable`. **Partial answer from 10.3: yes, live, but only jointly with a write-shaped archetype — `question`/`complex` was also run and still showed no MCP. Not fully closed: the five runs measured don't cover every archetype at complex tier.** |
| 12 | Does the 24-tool `@playwright/mcp` surface fit the 4,000-char house budget once offered (Q4 says nothing caps MCP results, and the tool *definitions* also enter the prompt)? | Sum `JSON.stringify` over the 24 registered definitions after connect; compare against the 4,372/4,400 description budget in Q2. **First data point from 10.5: `tool_descriptions` measured 33,128 chars in one 8-iteration run — roughly 8x this budget. n=1 run, not yet a general rate; not closed.** **Second data point from 11.4: 67.4% / 21,907 chars in a separate run, same 24-tool load — agrees with 10.5 on shape, differs in absolute chars (consistent with different prompts/iteration counts, not a fixed figure). Also the first direct measurement of the minimal set: 3 tools used (`browser_navigate`, `browser_find`, `browser_run_code_unsafe`) out of 24 loaded.** |
| 13 | Is `--force-tier`'s behaviour a deliberate limits-only design or an incomplete wiring? | Read the commit that introduced `forceTierOverride` in `tierLimits.ts` for a stated rationale, as `9805d055`'s body settled the Chromium question. |
| 14 | ~~**(Q10)** Locator discovery classifies as a read-only archetype, and 10.3 shows no read-only archetype reaches MCP tools at any tier — only a write-shaped archetype does, confirmed live across five runs. What closes the gap: forcing a non-read-only archetype for this task, a narrow `mcp.call` grant on the read-only pipeline, or something else not yet evaluated?~~ **CLOSED — commit `7e9baeb7` (item 408) escapes MCP tool names past the tier/capability filters in every pipeline, not only the one accidental combination.** | ~~Not reachable by instrument — this is a design choice, the same way unknown 6 is: a judgement about which layer should bend, not a fact about the code.~~ **Closed by the fix, not by measurement — see item 408, docs/deferred-work.md.** |

---

## Q10 — Six live measurements against a working MCP server

*Taken in `~/zone-locator-lab`, the first environment where the server Q8/Q9 connected is actually
exercised end to end rather than reasoned about from the filter code. Every measurement below is
tagged "Measured by the user," matching Q8/Q9's own convention for user-supplied live data. A
measurement taken once, on one page, is reported as n=1 rather than as a general property.*

### 10.1 MCP end to end works — closes unknown 1

**Measured by the user.** With a valid `.zone/mcp.json`, the server connects (`tools: 24`) and, in
the same run, the agent called `browser_navigate`, then — two LLM turns later — `browser_snapshot`,
then wrote the result to a file.

This closes unknown 1: the page was still open at the second call, two turns after navigation. Q3's
live caveat about whether an MCP server holds a page across JSON-RPC calls is answered for this
server, in this run.

### 10.2 Snapshot size: the tool returns a reference, not the tree

**Measured by the user.** `browser_snapshot`'s tool result reaching Zone was 324 bytes; the snapshot
content written to disk was 13,142 characters — a difference of roughly 40x.

So the MCP tool call itself hands the model a reference, not the interaction tree. This bears on
unknown 3 and on Q4's "MCP results have no cap anywhere in Zone's path" concern: the concern is
smaller than it looked **for what the model actually receives**, since 324 bytes is nowhere near any
cap. It does not make the concern disappear, though — the 13,142-char tree exists and is written to
disk uncapped, and if a later design has the model read that file back into context rather than
working from the 324-byte reference alone, the original cap question re-attaches at that hop instead
of the one Q4 first named. n=1: one page, one snapshot call.

### 10.3 Archetype, not tier alone, is what gates MCP — the largest open obstacle

**Measured by the user**, across five runs, reading `toolsAvailable`:

```
question       / simple  → 2 tools, no MCP
question       / complex → 2 tools, no MCP
investigation  / complex → 5 tools, no MCP
simple_add     / simple  → 5 tools, no MCP
simple_add     / complex → 43 tools, ALL 24 MCP tools present
```

MCP tools require **both** complex tier and a write-shaped archetype — neither alone is sufficient.
`question`/`complex` (2 tools, no MCP) is the case that isolates this: tier is already complex, and
MCP is still absent, so tier cannot be the whole gate 8.4 described.

This narrows Q8's finding that `mcp.call` is never granted anywhere: the capability filter
(archetype dispatcher) and the tier filter are two separate layers in the precedence chain, and an
MCP tool must clear both, not just the one 8.4 measured in isolation. It also corrects 8.4's own
inference — noted directly at 8.4 as well, not only here — which named `debug`/`complex_multi_file`
as "the one archetype pair where it works": this measurement shows `simple_add`/`complex` reaches
the full toolset too (43 tools, not the 5-tool simple-tier subset), so the working set of archetypes
is at least one pair wider than 8.4 stated, not narrower.

**The consequence for this investigation's own recommendation.** Locator discovery is inherently an
inspection task — the natural archetype for "look at this page and tell me what's there" is
`question` or `investigation`, and those are exactly the two archetypes this measurement shows can
never reach the browser, regardless of tier. This is the largest open obstacle to the Recommendation
section's capture step: the capability that section recommends is unreachable by construction from
the archetype a locator-discovery request would classify into on its own. (Recorded here as an
obstacle, not resolved — the Recommendation section's own text is not edited by this pass.)

### 10.4 Archetype classification is highly sensitive to the leading verb

**Measured by the user.** The same request, same underlying work, phrased two ways:

- "count how many X, write it to a file" → classified `question` (2 tools)
- "Write a file containing the number of X" → classified `simple_add` (43 tools)

Reordering which action leads the sentence changes the archetype, and per 10.3 that changes whether
MCP tools are reachable at all — from zero to all 24. n=1 pair of phrasings, one task.

### 10.5 Tool descriptions dominate cost once MCP tools are offered

**Measured by the user.** With 24 MCP tools present, `tool_descriptions` was 33,128 chars per
iteration — 65.1% of total tokens across an 8-iteration run costing $0.16. Only three of the 24
tools are needed for locator work (navigate, snapshot, evaluate).

This is a single run's cost breakdown (n=1 run), not a general rate — but it is the same
`tool_descriptions` bucket Q2 sized a house budget against (4,372/4,400 chars), and 33,128 is
roughly eight times that. The connecting figure is also recorded at unknown 12, above.

### 10.6 Role and accessible name are browser-computed, not Playwright-specific — bears on unknown 7

**Measured by the user, directly, outside Zone**, on one synthetic page built with five edge cases:
an `aria-label` overriding visible text, a `display:none` element, a link named via `img alt`, a
button sharing the same accessible name, and an element padded with whitespace. Counting the same
role+name locator three ways:

```
playwright getByRole(link, "Kaydet", exact)   → 3
CDP Accessibility.queryAXTree                  → 3
plain document.querySelectorAll + textContent  → 2
```

Playwright and CDP agree exactly; the plain-DOM count under-counts, missing the `aria-label` and
`img alt` cases. This is first empirical support for Q7.3's claim that verification can be
framework-independent — role and accessible name are computed by the browser itself and reachable
without Playwright — though it bears on, rather than settles, unknown 7: the measurement compares
Playwright against CDP and plain DOM, not against a count over `browser_snapshot`'s own captured
tree, which is what unknown 7's instrument specifically names.

**Stated at the scale it was measured, no wider.** One synthetic page, one locator, one browser. And
one result inside it was not conclusive: `cdpAll` equalled `cdpVisible`, so the `display:none`
element was **not** flagged ignored by any of the three methods. Whether that is correct CDP
behaviour, a filter the probe itself got wrong, or Playwright also not filtering on visibility for
`getByRole` was not established here.

### 10.7 What this pass did not measure

An earlier attempt to test the same role+name question through Zone itself, rather than outside it,
was invalid: the model reached for `browser_run_code_unsafe`, which executes Playwright's own API
inside the browser session. That would have measured Playwright against itself, not browser
primitives against Playwright, so it answers nothing about 10.6's question and is recorded here only
so it is not silently retried the same way later.

---

## Q11 — The full capability, unprompted, on a live external page

*Measured live in `~/zone-locator-lab` against the real `@playwright/mcp` server, on commit
`7e9baeb7` — the commit that made MCP tools reachable in every pipeline (item 408). This is the
first run to exercise capture, propose, and verify in one turn without being asked to step through
them.*

### 11.1 The measured run

**Measured by the user.** `.zone/memory.md` carried a `<!-- ZONE_INIT_BEGIN -->` block with four
locator conventions (prefer `getByRole` with an accessible name; scope rather than switch to CSS;
`data-testid` only when no accessible name exists; never `nth-child`, absolute XPath, or class
selectors) plus an instruction to verify against the live page and report the match count.

Task: *"I need a locator for the 'Get started' button on https://playwright.dev/. Propose one
following this project's conventions, verify it against the live page, and tell me the match
count."*

Result, verbatim:

```
page.getByRole('link', { name: 'Get started' })
Verified on https://playwright.dev/: match count is 1.
Note: although you called it a button, the live page exposes "Get started" as
a link, so this follows the project convention to prefer getByRole with the
accessible name.
```

### 11.2 What this establishes

**The project-memory channel is live, not just read.** `[zone-memory] injected project memory (581
chars)` confirms the `ZONE_INIT` block reached the prompt. Q5 concluded the propose step is
prompt-level and the channel exists; this is the first measurement of it actually firing end to end
— closing the gap between "the mechanism exists" and "the mechanism ran."

**The three-part capability ran in one turn, unprompted.** The model chose `browser_navigate`, then
`browser_find`, then `browser_run_code_unsafe` to count matches, without being told to step through
capture/propose/verify separately.

**The model corrected a false premise in the request.** The user said "button"; the live page
exposes a link. That correction — reading the live page rather than trusting what the user assumed
— is the capability's actual value, distinct from writing a locator for an element description
alone.

### 11.3 Limits — stated plainly

n=1 throughout: one page, one element, one framework's conventions (Playwright-shaped, since the
seeded `.zone/memory.md` conventions were written for it), one model. This does not test Q7's
multi-framework constraint — a Selenium-conventions run is the obvious next measurement and was not
done here. Verification went through `browser_run_code_unsafe` again, i.e. Playwright's own API —
the same limitation 10.7 already recorded, not a new one. The archetype/tier this run classified
into was not logged in what was measured, so this does not independently confirm which matrix cell
of 10.3 was exercised — the closure of unknown 14 rests on the commit, not on this run's archetype.

### 11.4 Cost — a second measurement of the same shape as 10.5

**Measured by the user.** `tool_descriptions` was 67.4% of total tokens — 21,907 chars per
iteration, 24 MCP tools loaded. The run used three: `browser_navigate`, `browser_find`,
`browser_run_code_unsafe`. Two measurements of the same shape now exist — 65.1% / 33,128 chars
(10.5) and 67.4% / 21,907 chars (here) — agreeing on shape (majority of tokens, same 24-tool load)
while differing in absolute chars, consistent with different prompts and iteration counts rather
than a fixed per-run figure. This run also measures the actual minimal set directly, rather than
naming one from inspection: three tools used out of 24 loaded.
