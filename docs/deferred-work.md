# Zone — Deferred Engineering Items

This document is written to be read cold, without the conversation that produced it. Every
entry stands alone: what it is, why it's deferred, what would close it, and where the code
lives (a few entries are marked closed instead, recorded for completeness rather than as open
work) — referenced by shape (function name, branch condition, marker tag, symbol), never by
line number. Four stale line-number references were found in this exact area in one session
(see the closing section); this document is deliberately built to not become a fifth.

Shape references have their own failure mode, and it's the right tradeoff, not a free one:
they don't drift silently the way line numbers do, but they do break — loudly — if a symbol
is renamed, retired, or a handler is restructured enough that the referenced marker tag or
function name no longer exists. A search for the name coming back empty is not corruption in
this document; it's the signal to re-derive that entry from the current code, not to guess
where the reference used to point.

This is not a changelog, not a roadmap, and not a priority ordering. Items are numbered for
reference, not ranked.

## 1. P1 — line-anchored marker recount, partially closed

`[zone-apply-patch-marker-imbalance]`'s payload (emitted from the marker-imbalance rejection
branch inside `apply_patch`'s handler in `toolExecutor.ts`) carries two count pairs: the
original substring-anywhere counts (`findMarkerCount`/`replaceMarkerCount`) and a line-anchored
recount (`findMarkerCountLineAnchored`/`replaceMarkerCountLineAnchored`), added to make one
class of false positive legible from records.

**What's closed:** a marker-looking string that's quoted or sits mid-line (e.g.
`"--- FIND ---"` inside a comment or string literal) inflates the substring count but not the
line-anchored one — the two pairs disagree, and the record is identifiable as a false
rejection.

**What's still open, and why this item isn't closed:** an embedded marker that is genuinely
alone on its own line — the realistic trigger, e.g. a doc/example block showing the
apply_patch syntax — satisfies the line-anchored count exactly as readily as a real marker.
Both pairs agree; the record stays indistinguishable from a genuine model formatting error.

**What would close the rest — three options, none built:**
- **A content hash** of the patch or the matched region. Doesn't decide anything about a
  single record; only lets a reader notice the same false-positive-shaped patch recurring
  across multiple records — a corpus-level pattern aid, not a per-record classifier.
- **The index of the first marker occurrence** (already computed nearby, for a different
  check, to detect content before the first FIND marker). Might correlate statistically with
  false positives clustering late in long REPLACE bodies — an empirical claim with no data
  behind it, and a correlation isn't a per-record decision procedure.
- **Whether the occurrence falls inside a REPLACE region per the parser's own segmentation** —
  the most structurally promising option. Tracing the parser's own block-splitting walk
  against this exact patch shape surfaced item 2 below instead of a clean answer: the parser
  doesn't segment this case cleanly either.

**Where the code lives:** the recount and a comment describing this exact split sit directly
above the `[zone-apply-patch-marker-imbalance]` `log(...)` call, inside `apply_patch`'s
marker-imbalance rejection branch, in `toolExecutor.ts`.

## 2. The parser's silent misparse on a matched, own-line embedded pair — partially closed

**What it is:** the FIND/REPLACE block-splitting walk (the loop that consumes
`FIND_MARKER`/`REPLACE_MARKER` occurrences in `apply_patch`'s handler, `toolExecutor.ts`) uses
the same substring-anywhere marker matching as the imbalance counter above it. If a patch's
REPLACE content contains an embedded, own-line, **matched** FIND/REPLACE pair (both markers
present, e.g. a doc example demonstrating the syntax), the walk splits there — truncating the
real block's replacement short and fabricating a second, unintended block from the example
text.

**It reproduces — confirmed by probe against built `dist/`, not by tracing.** A patch built to
this exact shape was run through the real compiled `apply_patch` handler against a temp repo,
both with and without the fabricated block's FIND text present in the target file. Both
outcomes below were observed directly, not inferred.

**Two outcomes, and the FIND-not-found gate is what separates them — the single most
load-bearing fact about real-world severity, which the original framing of this entry ("silent
wrong content, not a rejection") omitted.** When the fabricated block's FIND text is absent
from the target file — the common case, since it's accidental example text rather than
something the model verified against the file — the whole patch is rejected: the model is told
"Block 2: FIND content not found" when there is no real block 2, and it re-reads the file
looking for text it never wrote. When that FIND text happens to independently exist in the
file, the FIND-not-found gate never fires: the real block's replacement is silently truncated,
an unrelated line is edited, and the tool reports success. Confusing-but-harmless is the common
outcome; silent-and-wrong is the rare one — the original entry only described the rare one.

**Reachability is narrower than the raw marker count suggests.** 60 tracked files in this repo
contain the marker substring somewhere; only 2 contain it on its own line, the shape that
actually triggers this. A marker quoted or sitting mid-line (inside a string literal, say)
mostly gets caught by the imbalance check first, since such patches tend to be unbalanced —
only a *balanced* embedded pair ever reaches the walk at all. The protocol has no escape
mechanism, and `apply_patch`'s tool description says nothing about markers appearing inside
content.

**What the detection-only telemetry pass added:** `[zone-apply-patch-marker-split]`, emitted
once per multi-block `apply_patch` call — every one, not just suspected instances. The gate is
deliberately the broad "more than one block," not the content-embedded heuristic, specifically
so every record carries a denominator (see item 5 — the same structural-zero trap that marker's
own gate avoided is why this one's gate isn't narrower). Each record carries the parsed block
count, a blank-line-before-marker heuristic count (explicitly not a classifier — a model that
omits the blank line produces a false negative, and a legitimate multi-block edit whose first
replacement happens to end in one produces a false positive), the raw total marker count
(independent of how the walk itself parsed the patch, so a better predicate can be re-derived
from existing records without a new deploy), and whether the FIND-not-found gate fired. Zero
change to parsing, acceptance, or rejection.

**Why it still can't be recorded under `[zone-apply-patch-marker-imbalance]` specifically:** a
matched embedded pair raises `findMarkerCount` and `replaceMarkerCount` together, so they stay
equal — the rejection branch that emits that marker never fires, and there's no payload shape
under that tag that could capture this, since it isn't an imbalance rejection at all. This is
unchanged; the new marker records it under a different tag entirely, not by extending this one.

**Still open — the parsing defect itself, unfixed.** What would close it: line-anchoring the
parser's own segmentation (not just the counter, which item 1 already did) — a real behavior
change to which patches get *accepted*, deliberately out of scope for both the recount and the
telemetry passes that touched this area. Note the ordering constraint if this is ever done:
line-anchoring the walk in `toolExecutor.ts` without also line-anchoring the identically-
segmenting `parsePatchBlocks` in `agentLoop.ts` (feeding `hashPatchBlocks`'s failure-dedup key —
see item 16) would leave the dedup hash disagreeing with what the applier actually did. The
structural alternative — sidestepping the parsing question entirely — is recorded separately as
item 17. Two sharper, related consequences of this same defect are recorded as items 15 and 16.
Item 16 has since been corrected and now records the concrete, behavior-preserving shape this
line-anchoring work would need — share segmentation only, leave `normalizeSmartQuotes` as a
post-pass at the walk. Item 20 records the prerequisite that now exists for attempting either
parser change safely: `a7f4ff03`'s characterization tests, which pin exactly the values a shared
implementation would need to preserve and didn't exist when this constraint was first written.

**Where the code lives:** the block-splitting walk and the comment describing this defect sit
directly above it in `apply_patch`'s handler, `toolExecutor.ts`. The new marker's emission sites
sit just after that walk and inside the FIND-not-found rejection branch, in the same handler.

## 3. P2, R1, R2, R3 — definitions lost

These were established during the original bare-catch/marker-imbalance investigation and
recorded only in conversation and a plan file under `.zone/`, which is gitignored. Both are
gone.

- **R1** survives as a one-line gloss: "blocks the model's legitimate escape hatch." Understood
  to be about a prevention option for marker imbalance that would cost the model some
  legitimate recovery path if applied too aggressively — but the specific mechanism is not
  recoverable from this fragment alone.
- **P2, R2, R3** survive as labels only. No description, no rationale, no acceptance criteria
  are recoverable.

**What would close this:** nothing — these need to be *re-derived*, not decided. A future pass
revisiting marker-imbalance prevention/recovery options should treat this as starting from zero
on these three items specifically, not as "already scoped, just blocked on data."

**Where the code lives:** nowhere yet — these were option labels for work that was never
started.

## 4. 2b — thread marker-imbalance counts through seven sites

**What it is:** `[zone-apply-patch-marker-imbalance]`'s counts exist only in the marker payload
today. Threading them into the coaching text the model sees after a rejection (so the model
knows the real direction of the imbalance, not just that one exists) requires carrying the
counts through `ToolResult`, `ToolEventContext`/`FailureSignal`, `FailureContext`, and the
coaching options object — five files, seven sites, established and recorded in an earlier pass.

**Why it's deferred:** this is decidable from data already being collected (not blocked on a
new field or a design decision) — whether the imbalance runs a consistently one-sided
direction across real occurrences is answerable once enough
`[zone-apply-patch-marker-imbalance]` records exist. It wasn't answerable before the marker was
routed through `log()` instead of `debugLog()` (fixed earlier); now it's purely a matter of
accumulation.

**What would close it:** roughly 10-20 real records. At 3 occurrences across 45 distinct runs
(`[zone-apply-patch-retry]`'s `reason: "marker_imbalance"` records, already on `log()`
throughout) — a rate of 4.4%, but **n=3: an order-of-magnitude estimate only, not a
measurement with a defensible confidence interval.** The resulting ~230-450-run projection is
a sense of scale, not planning input — three events don't support a rate precise enough to
schedule against, and could be off by a large multiple in either direction.

**Where the code lives:** nowhere yet — this is unbuilt. If the seven-site trace needs
redoing, re-derive it starting from `[zone-apply-patch-marker-imbalance]`'s emission site,
`CoachingController`'s `buildCoachingPrompt` call, and the `FailureContext`/`FailureSignal`
types in the coaching and tool-event-handler modules.

## 5. `[zone-search-in-files-read-error]` cannot fire on this development machine

**What it is:** `search_in_files`'s in-process fallback — the two-loop path used when `rg` is
unavailable — is instrumented, but the fallback only runs when ripgrep detection fails.

**Why it's structurally unreachable here, not just unlikely:** ripgrep is installed on this
machine, and the detection result is cached at module scope for the lifetime of the process (a
path variable set once on first check) — so even a mid-process PATH change couldn't flip it.
This marker will read zero records here indefinitely, by construction.

**What this means for interpretation, not what needs closing:** any future "which markers have
zero records" tally must exclude this one explicitly, or it will misread structural
unreachability as a silent-failure signal. The lesson generalizes past interpretation, into
design: item 2's telemetry marker was deliberately gated broad (`blocks.length > 1`, not its
own content-embedded heuristic) specifically to avoid reproducing this same structural-zero
shape for a different marker — see item 2.

**Where the code lives:** the ripgrep-availability cache and the fallback's two read loops are
both in `search_in_files`'s handler in `toolExecutor.ts`; the cache variable is set once in the
function that shells out to check for `rg`'s presence.

## 6. Closed — `rehydrateFileAccess`'s hardcoded `success: true` is deliberate, not a defect

**What it is:** the warm-resume path that rebuilds `toolCallLog` entries from a reconnected
conversation (`rehydrateFileAccess` in `agentLoop.ts`) synthesizes an entry with
`success: true` hardcoded, for a fixed set of tool names (`read_file`, `write_file`,
`apply_patch`) — it never re-checks whether those prior calls really succeeded.

**Why this is closed, not fixed:** the function's own header comment already states a
tradeoff as deliberate for the consumer it names: a rehydrated tool call proves the call was
*issued*, not that it succeeded, and the alternative — rehydrating failure accurately — blocks
every warm resume's first patch. That comment is correct as far as it reasons. Closing this
item meant checking whether its reasoning covers every consumer of the field it defends. It
doesn't: a second consumer, below, is separately fixable, and closed for a different reason —
value, not feasibility.

**The correct-vs-loses split:** the hardcoded `success: true` feeds two consumers with
different correctness requirements. The read-before-patch gate (`wasFileReadOrWritten`)
accepts `read_file`/`write_file` entries unless `success === false` and requires `apply_patch`
entries to be exactly `success === true`. For the chain-saturation nudge, the same field is
sometimes right and sometimes wrong: right when the prior `apply_patch` really did succeed
before interruption (the nudge's premise — many iterations without a successful write — is
genuinely false, so suppressing it is correct), wrong when it failed right before interruption
(the premise is true, but the nudge is suppressed anyway).

**Why the shared field itself can't be fixed:** making rehydrated `success` accurate would
require knowing which prior calls really succeeded, and rehydration has no cheap way to know
that — real verification means re-reading files or re-deriving state, and the only other
source of real outcome data in the resume conversation is prose result text, the same fragile
classification shape this document rejects elsewhere (see item 12). The read gate needs
`success: true` hardcoded unconditionally: the alternative is treating every rehydrated entry
pessimistically, which blocks the first patch of every warm resume, not just the rare genuine
failure. That's the header comment's actual claim, and it stands.

**Chain saturation is a separate question, and is cheaply fixable — closed anyway on value:**
the read-gate argument above does not extend to it. The chain-saturation filter doesn't need a
per-call `success` at all — it only needs to know whether the prior run staged real work, and
a cheap, already-existing signal answers exactly that (two concrete options below, under "If
this is ever revisited"). So this consumer is not stuck the way the read gate is — it just
isn't fixed. It's closed rather than left open because the miss is small: the nudge fires at
most once per run, and only misses in the minority case where the immediately-pre-interruption
`apply_patch` genuinely failed. When it succeeded — the ordinary case — suppressing the nudge
is already correct, since the nudge's own premise would be false. One suppressed advisory
message, once, in an uncommon case, isn't worth building either option for today.

**What the header comment's reasoning does and doesn't cover:** it reasons all the way through
the read-before-patch gate and stops there — it never mentions chain saturation. Read on its
own terms, its justification (blocking every warm resume's first patch) is specific to the
read gate's strict/lenient `success` checks; it doesn't transfer to chain saturation, which has
no such all-or-nothing failure mode. That's the actual gap — not that the tradeoff was
reconsidered and accepted for this second consumer, but that the written argument never
addresses it.

**If this is ever revisited:** two options were identified, in preference order, for the
chain-saturation consumer specifically — the read gate's `success: true` stays untouched
either way. First, cheapest: read `resumeStagingFiles` directly in the chain-saturation
filter — it's already seeded into `stagingFiles` on warm resume, and non-empty staging already
means the prior run staged real work, independent of any per-entry outcome classification.
Second: flag the entry rather than overload `success` — add a field marking a `toolCallLog`
entry as rehydrated (provenance only, not an outcome claim), the same shape as the
`filesStaged` field that fixed the sibling `multi_edit` defect, so
`countsTowardChainSaturation` can discount flagged entries specifically. Neither option should
classify from the resume conversation's `role:"tool"` prose result text:
`reconcileDanglingToolCalls` proves that text is technically present and recoverable, but
string-classifying an outcome from human-readable prose is the same fragile shape already
rejected twice this session — once for marker-imbalance counts, and now again here. It's also
the subject of a related finding in the same log, now partially closed — see item 12.

**Where the code lives:** the hardcoded `success: true` is in the entry-construction step
inside `rehydrateFileAccess` in `agentLoop.ts`, gated on the tool-name allowlist described
above; the header comment defending it sits directly above the function. The asymmetric gate
it defends, `wasFileReadOrWritten`, sits later in the same file; `resumeStagingFiles` is seeded
into `stagingFiles` nearby, in the same warm-resume wiring.

## 7. Closed — the checkpoint gate now reads the current call's result, not the sticky iteration flag

**What it was:** within a single agent-loop iteration, the per-iteration failure flag on the
tool-event context was set once a write-tool failed and never reset until the next iteration. The
durable-resume checkpoint write was gated on that same flag being clear for
`apply_patch`/`write_file`/`multi_edit`, so one failing write-tool call silenced checkpointing for
every later, successful write-tool call in the same iteration — measured, not assumed: 53.9% of
real iterations run multiple tool calls, and the exact shape (four `apply_patch` calls sharing one
iteration) occurred in recorded data.

**Fixed by `af3125f0`, landed and never recorded here until now.** One line: the gate condition
changed from `!toolEventCtx.failureDetected` (the sticky, iteration-wide flag) to `result.success`
— the current call's own outcome, already in scope at the gate for something else eighteen lines
above. No change to `ToolEventContext`, no flag reset, no new field — exactly the scoping this
item's own text asked for, at the narrowest possible diff. 281 lines of new integration coverage
in a dedicated file, where none existed before, including the read-before-patch variant sharing
the same stale-flag mechanism.

**Where the code lives:** the checkpoint call is in the per-tool-call loop in `runAgentLoop`
(`agentLoop.ts`); the tests are in `agentLoop.checkpointGate.test.ts`.

## 8. Closed — `multi_edit`'s path-escape return now carries `filesStaged`

Recorded for completeness, not as an open item. `multi_edit`'s path-escape rejection (inside
its handler in `toolExecutor.ts`, the branch returning `multi_edit_blocked_path_escape`) used
to omit `filesStaged` entirely, so files staged in earlier loop iterations before the escape
never reached `ctx.filesModified` even though `finalizeStaging` still flushed them to disk.
Fixed in the same pass that threaded `filesStaged` into chain-saturation counting — the escape
return now carries the array as it stood at the moment of the escape.

## 9. `search_in_files`'s six unconditional `success: true` returns — never on the original list

**What it is:** three `success: true` returns in the in-process fallback, two more on the
ripgrep-available path, and one inside the JSON-parsing helper the ripgrep path calls — all
unconditional, regardless of whether anything was actually found or read successfully.

**Why this was never folded into the bare-catch work:** found during that investigation but
explicitly out of scope for it — a different question (whether the *result* should be
considered a failure) than the one that investigation answered (whether read failures inside
the fallback were silently dropped, which they were, and are now marked via
`[zone-search-in-files-read-error]`).

**Why it isn't a simple copy of the `multi_edit`/write_file fix:** `search_in_files` is a
read-only tool. Making `success: false` conditional would also break read-only transcript
batching, which groups consecutive successful read-only tool calls into one collapsed line
and is keyed on `success` — a UI-visible behavior change, not just an internal bookkeeping
one.

**Where the code lives:** the fallback's returns are in the two count/content-building
branches of `search_in_files`'s in-process path; the ripgrep-path returns are in the
`files_with_matches` and `count` branches of the same handler; the JSON-parsing one is in the
helper the ripgrep path calls to build content-mode output. All in `toolExecutor.ts`.

## 10. Sink's trim is not atomic across processes

**What it is:** when `~/.zone/markers.jsonl` crosses its size cap, the sink trims it back down
by reading the whole file, dropping the oldest lines, and rewriting it —
read-trim-rewrite, not an atomic replace. The trim function's own header comment already
states the consequence: a concurrent process's append landing between the read and the
rewrite is lost.

**Why it's deferred:** currently low-risk — the file sits at roughly 39% of its cap, so trims
are rare. The risk isn't evenly distributed, though: it can only manifest exactly when the
sink is full and multiple Zone processes are appending concurrently, which is also exactly
when records matter most — busy, active use, the moment a rare marker is likeliest to fire.

**What would close it:** either an atomic rewrite (write to a temp file, then rename over the
original — rename is atomic on the same filesystem) or switching from in-place trim to
append-only rotation (roll to a new file, keep N generations), removing the read-modify-write
window entirely.

**Where the code lives:** the trim function lives in the marker-sink module, called from the
append function whenever a write pushes the file past its size cap.

## 11. Sink data cannot be forced — passive accumulation only

**What it is:** the markers described above (and others) only accumulate through real,
interactive use. A dogfood run to deliberately generate records was considered and rejected.

**Why it can't be done cheaper:** the test suite redirects the home directory to a temp path
for the whole run and a home-directory write guard actively fails any test that writes to the
real `~/.zone` — by design, so tests can never pollute or depend on real sink state. The
stdout/stderr interception shield that captures markers is also never installed during tests.
This isn't a gap to close; it's deliberate isolation that happens to mean sink data is
unreachable below an interactive-run cost tier.

**Why a forced run was rejected anyway:** the item with the clearest payoff (item 4 above) has
a measured 4.4%-per-run trigger rate — a single forced run is closer to a lottery ticket than
a measurement at that cost tier. Passive accumulation over ordinary use reaches the same
records for free.

## 12. `didApplyPatch`'s string-matching — partially closed

`didApplyPatch` (`src/llm/verification/logUtils.ts`) decides whether a run applied anything —
feeding the run's final reported verdict, not an internal nudge. This entry originally led with
the rehydration link (see item 6); a fuller pass found that was the smallest of the reachable
problems, and two load-bearing defects it didn't name are now fixed.

**What was wrong:** the predicate classified `apply_patch`/`write_file` entries by
string-matching `result` text for "error"/"not found"/"fail", case-insensitively with no word
boundary, and never checked `multi_edit` at all.
- **The path-name false negative.** Every write-tool success message embeds `${filePath}`. A
  patch to any of the 16 tracked files in this repo whose path contains one of those three
  substrings — an ordinary single-file edit to `src/core/parseVerificationError.ts`, for
  instance — reported as having applied nothing.
- **`multi_edit` was never checked.** A `multi_edit`-only run with real replacements and staged
  files returned `false` regardless of what actually happened.

Both produced the identical user-visible wrong output — a warning that tests failed because of
the patch, on a run where tests never ran and the patch was fine.

**Fixed by `e21aab93`:** the predicate now reads structured fields instead of prose —
`success === true` for `apply_patch`/`write_file`, and `success === true` plus non-empty
`filesStaged` for `multi_edit`, reusing `multiEditChangedSomething` (the predicate `86ba4bd1`
built for chain-saturation counting) rather than re-deriving it. Establish confirmed
`success: true` is unreachable in `apply_patch`/`write_file` without a prior real write — why
bare `success` is a sound proxy for those two tools but was never sufficient for `multi_edit`,
where `success: true` survives zero replacements. Also closed: the false-positive class where
scope-guard blocks and marker-imbalance rejections — real failures — counted as applied.

**Still open, and what would close each:**
- **Rehydrated entries still count.** Rehydration hardcodes `success: true` (item 6), and the
  fixed predicate now reads exactly that field, so a rehydrated `apply_patch`/`write_file`
  counts as applied regardless of what happened before interruption — unchanged by this fix.
  Reading `resumeStagingFiles` — non-empty exactly when the prior run staged real work — would
  close this without a new field, but needs threading into `inferVerificationFromLog`, which
  today only receives a bare tool-call log.
- **The no-op patch.** A FIND==REPLACE `apply_patch` stages byte-identical content and returns
  `success: true`; neither `apply_patch` nor `write_file` has a no-op guard. Closing it needs
  either such a guard, or a `filesStaged`-equivalent added to both write tools' returns —
  established as a bigger pass than swapping a predicate, and explicitly out of scope for the
  fix that landed.

**The general lesson, past this fix:** classifying an outcome by pattern-matching
human-readable text instead of reading a structured field meant to carry that outcome is the
same shape of fragility that motivated the line-anchored marker recount (item 1) — prose is not
a data model. See item 6 for the sibling defect this connects to: rehydration's hardcoded
`success: true`, and why the read-before-patch gate it serves makes that hardcoding correct on
its own terms even though it leaves this entry's first "still open" item unclosed.

**Where the code lives:** `didApplyPatch` and `multiEditChangedSomething` both live in
`src/llm/verification/logUtils.ts` (`multiEditChangedSomething` moved there from `agentLoop.ts`,
which re-exports it for existing importers). Called from `composer.ts`
(`src/llm/runCompletion/`) directly, and from `inferVerificationFromLog` in `classify.ts`
(`src/llm/verification/`). `deriveVerdict.ts` imported it but never called it — that dead import
is gone now too (see item 13).

## 13. Dead-code detection is absent

**What it is:** `deriveVerdict.ts` carried an unused `didApplyPatch` import that survived every
`tsc --noEmit` run because `tsconfig.json` omits `noUnusedLocals`, and survived every commit
because ESLint is configured (`eslint.config.mjs`) but not wired into any npm script — `npx
eslint <path>` has to be run by hand to catch it.

**Why this matters:** the import itself is gone now (`e21aab93`, found and removed as a
byproduct of an unrelated fix — see item 12), but the detection gap that let a dead import live
undetected is not closed. The next dead import, dead export, or unreachable branch has the same
free pass.

**What would close it, and what it would actually cost:** either enabling `noUnusedLocals` in
`tsconfig.json`, or wiring ESLint into the npm scripts. Checked, not assumed: `npx tsc --noEmit
--noUnusedLocals` surfaces 56 errors across 23 files, spanning `cli/`, `core/`, `engine/`,
`llm/`, `repo/`, `roles/`, and `tools/` — a real, repo-wide backlog, confirming the "repo-wide
fallout" concern rather than assuming it. Enabling the flag would mean clearing that backlog in
the same change or accepting a red build; wiring lint into npm scripts changes what a green CI
run means going forward. Either is a repo-wide change with its own fallout, which is why this
is a ledger entry and not a drive-by fix.

**Where the code lives:** `tsconfig.json`'s compiler options (`noUnusedLocals` absent);
`eslint.config.mjs` (configured, not invoked by `npm test`/`npm run build`).

## 14. Closed — `filesModified` now tracks persisting mutations, not write attempts

**What it was:** `handleToolResult`'s Step 9 added a tool call's `filePath` to `ctx.filesModified`
for `apply_patch`/`write_file` unconditionally — no `success` check — so a failed attempt landed
in the set exactly like a successful one. `multi_edit` was already accurate, gating on its own
`filesStaged` field instead.

**The entry's own proposed fix was wrong, established by reading rather than assumed correct on
a second look:** the original text above proposed gating the two additions on `success`, the same
asymmetry fix already applied elsewhere in this file family. Two independent findings falsified
that, both from reading the actual code, not from reasoning about it:
- `multi_edit` does not gate on `success` at all — it gates on *evidence of mutation*. Its
  path-escape return carries `success: false` with a real, partially-accumulated `filesStaged`
  array; a `success` gate would have dropped those files, the exact defect item 8 closed.
- A `success` gate would have lost the one case where a failed write leaves a genuinely changed
  tree: a new-file `write_file` whose post-write rollback `unlinkSync` call itself throws. The
  file survives, unreported, under a blanket gate.

**What landed (`3fa62c4a`):** `apply_patch` and `write_file` now return `filesStaged` themselves,
on every return that leaves a *persisting* content change, matching `multi_edit`'s own contract
instead of approximating it with `success`. `handleToolResult`'s Step 9 collapsed to one branch
reading `result.filesStaged` uniformly for all three tools. This also closed a second, smaller
defect found during the same pass: the old two branches stored different path formats (the raw
model-supplied string vs. `multi_edit`'s `resolveAgentPath` output) — both tools now reuse the
same `resolveAgentPath` local they already computed for themselves, so all three tools produce
identical normalization.

**The prerequisite (`c1570c7e`):** `performReplan`'s scope-widening used to depend on the blocked
path having leaked into `filesModified` via the same unconditional Step 9 this item closes.
Fixed first, separately, so gating Step 9 couldn't silently strand a scope-blocked path outside
the widened plan the moment this item landed.

**The measurement (`44adc59f`, `ecfd42e0`):** four characterization tests pinned the affected
consumers' pre-fix behavior — anti-thrash P5/P6 suppression, Stage-2's C2 no-net-progress check,
`validateUnrelatedClaim`'s unrelated-failure demotion — before any fix code was written, and the
real fix was run as a mutation against them ahead of being built. All four predictions matched
what the real fix produced.

**Honest asymmetry, worth recording so it isn't rediscovered as a surprise:** for `apply_patch`
alone, the shape that landed and a blanket `success` gate produce identical behavior — every one
of `apply_patch`'s persisting-change returns is already `success: true`; none of its rollback
returns persist anything. The richer design was required by `write_file`'s unlink-survivor case
and by uniformity with `multi_edit`, not by anything `apply_patch` itself needed.

**The unlink-check decision:** the new-file rollback path wraps `fs.existsSync` in its own
try/catch, defaulting to `false` (not staged) when the check itself throws, and logs
`[zone-write-file-unlink-check-failed]` on that path. The default was decided on cost asymmetry,
not likelihood: `git add -- <paths>` fails atomically on a single phantom pathspec, silently
losing an entire run's otherwise-legitimate auto-commit; a missed `filesStaged` entry on an
inconclusive check is recoverable and visible in `git status`. Defaulting to the lower-blast-radius
wrong guess was deliberate.

**Where the code lives:** `filesStaged` population is in `toolExecutor.ts`'s `apply_patch` and
`write_file` handlers, on their own success/persisting-change returns; Step 9 is in
`handleToolResult.ts`; the unlink-check is inside `write_file`'s shared syntax/semantic-smell
rollback block, guarding only the new-file sub-case.

## 15. The restage-prompt generator can produce text the walk would mis-parse

**What it is:** `diffToFindReplace` (the function that renders a computed diff into
FIND/REPLACE text) can produce output that is itself ambiguous under the walk's own parsing
rules — a one-block diff whose added content happens to include the patch syntax renders as
text the walk (item 2) would split into two blocks if it were fed back through it. No model is
needed to produce this text: ordinary staged content that happens to include patch syntax is
enough — item 2 already establishes such content exists in this repo.

**Confirmed by feeding the real generator's output into the walk's exact algorithm, not
guessed.** The walk itself is inline inside `executeTool`, not a separately callable function,
so this was checked by transcribing its exact logic from `toolExecutor.ts` and feeding it
`diffToFindReplace`'s real, unmodified return value for a one-block diff. The transcribed walk
produced two blocks from a one-block change — matching item 2's shape exactly.

**Where this actually flows, and the gap this pass left open:** `buildStagedDiffs` calls
`diffToFindReplace` per staged file; `buildRestageSeedBlock` renders each file's result,
verbatim, into a "PRIOR STAGING ATTEMPT — ...Revise or replace them" block threaded into the
first user message on a restage (never the system prompt, preserving the cache-breakpoint
invariant). That is as far as this pass traced it: the ambiguous text reaches the model's
prompt unparsed — `buildRestageSeedBlock` only renders it, it does not itself invoke the walk.
The misparse only completes if the model reuses that exact text in a subsequent `apply_patch`
call, which the surrounding prompt text invites but which this pass did not separately observe
a model do. The confirmed fact is narrower than "Zone corrupts its own representation
automatically": Zone hands the model a syntactically live hazard, with no model action needed
to generate it, sitting one resubmission away from the corruption item 2 describes.

**Why still worth its own entry:** every other instance of item 2 needs a model to write
content shaped like the trigger. This is the one place the hazardous text is generated by
Zone's own code from ordinary diff content, with no model involvement in that step.

**What would close it:** the same fix as item 2 — line-anchoring the walk closes this
regardless of whether the model ever resubmits the hazardous text, since the walk itself would
stop mis-splitting it.

**Where the code lives:** `diffToFindReplace`, `buildStagedDiffs`, and `buildRestageSeedBlock`
are all defined in `fileDiff.ts`; `buildRestageSeedBlock` is called from `agentLoop.ts`, where
its result is threaded into the first user message on a restage.

## 16. Three independent parsers of one format, two different algorithms — corrected

**This entry originally overstated where the three parsers disagree. That claim is false and
is corrected below, not softened.** The original text said the applier's walk and
`parsePatchBlocks` are "a near-identical copy, not a shared implementation," and that all three
parsers "can disagree about what the patch even contains… on exactly the patch shape item 2
describes." A mechanical diff and a differential probe (all 126 marker sequences of length ≤ 6,
plus a 200k-case fuzz) found otherwise on both counts.

**The two index-walkers are character-for-character identical in their segmentation logic.**
The loop condition, the `indexOf` calls, the `repIdx === -1` break, and the trim regexes are the
same text in both `toolExecutor.ts`'s walk and `parsePatchBlocks`. They differ in exactly three
places: an entry-coercion difference (`String(patch || "")` vs bare `patch`) that is not
observable, since both call sites already pre-coerce to a string before calling in; a pair of
smart-quote counters that exist only in the walk, for telemetry, and don't change what's
returned; and the walk's call to `normalizeSmartQuotes` on FIND/REPLACE content, which is the
only one of the three that changes output. That third difference is a live defect with its own
consequences — see item 18.

**`DiffView`'s `.split()`-based parser disagrees with the index-walkers only on `FF`-shaped
input — two consecutive FIND markers with no REPLACE between them.** Every disagreement found
across the full differential and the fuzz required that shape; every non-`FF` sequence agreed,
including item 2's own shape (an embedded, matched FIND/REPLACE pair). On that shape
specifically, `DiffView` fabricates the identical second block the applier does — the rendered
diff is faithfully showing the misparse, not lying about it. `FF` patches are malformed and
mostly rejected by the marker-imbalance check before reaching either walk; where a balanced `FF`
patch does reach parsing, unifying the third parser would be a rendering-behavior change with no
test asserting which of the two readings is the correct one to show a user. **Recommend it stays
out**, for that reason — folding it in belongs to a pass that first decides what `DiffView`
should show on malformed input, which this one doesn't.

**What would close the real half — the two index-walkers sharing one implementation — has one
working shape, not two.** Sharing the walk's full logic, normalization included, changes every
existing `hashPatchBlocks` dedup key for a smart-quote-bearing patch — a deliberate behavior
change, not an extraction (see item 18). Sharing the segmentation with normalization removed
from both sides breaks the applier's own smart-quote tests, which require the walk to normalize
before matching against the file. The only behavior-preserving shape is sharing the segmentation
loop alone and leaving `normalizeSmartQuotes` as a post-pass applied at the walk's call site
only. Note this only ever concerns smart quotes — item 18's other two normalization classes
(line endings, the read_file prefix) live in the match-time loop this extraction doesn't touch,
in either shape; unifying segmentation resolves at most one of item 18's three classes, not the
divergence as a whole.

**Candidate home: `core/fileDiff.ts`.** It's a genuine leaf (imports only `node:fs` and
`node:path`), it already generates this exact format (`diffToFindReplace`, the subject of item
15), and `agentLoop.ts` already imports it. `toolExecutor.ts` would gain one new edge to a leaf
module — no cycle in either direction.

**The two marker constants would move with it, but that centralizes less than it sounds like.**
`FIND_MARKER`/`REPLACE_MARKER` are declared once each in `toolExecutor.ts` and not exported or
imported anywhere. But the literal marker strings appear independently on sixteen further lines
in the same file, none of them referencing the consts: the imbalance counter's own regex checks,
the line-anchored recount's regex checks, and every error-message body shown to the model (the
imbalance-rejection message's two example blocks, the content-before-FIND message and its
example, the no-valid-blocks message and its example, and one further usage message elsewhere in
the file) all inline the text separately. Moving the two declarations centralizes 2 of 18
functional occurrences of the string in this file, not the string itself.

**Where the code lives:** the applier's walk is in `toolExecutor.ts`; `parsePatchBlocks` and
`hashPatchBlocks` are in `agentLoop.ts`; `parseBlocks` is in `DiffView.tsx`; the candidate shared
home, `fileDiff.ts`, already holds `diffToFindReplace`.

## 17. `apply_patch`'s delimiter ambiguity is self-inflicted — `multi_edit` shows the alternative

**What it is:** `apply_patch` packs a FIND string and a REPLACE string into one delimited blob
and parses them back apart with a walk — which is what makes item 2 possible at all. `multi_edit`
takes `find` and `replace` as separate JSON arguments; the model can put anything in either
string, including literal marker text, with no delimiter to confuse it with, because there is
no delimiter.

**Why this is worth recording as its own option, not just a note under item 2:** it's additive
— a `blocks: [{find, replace}]` structured argument wouldn't change how any patch that works
today parses, since nothing about the existing delimited format would need to be removed to add
it. This is the only option under item 2's "what would close it" that requires no
model-facing behavior change to any patch that isn't already hitting the defect.

**What would close it:** adding a structured `blocks` argument to `apply_patch`'s schema —
unbuilt, unscoped beyond this observation.

**Where the code lives:** `multi_edit`'s schema (the precedent) and `apply_patch`'s schema
(what would change) are both in `toolDefinitions.ts`.

## 18. The applier's normalization was never mirrored into the dedup hash — corrected, three classes not one

**This entry originally framed the divergence as a smart-quote defect. That framing is
incomplete, not just narrow: it is one of three live classes, corrected below.** The original
title and text described only `normalizeSmartQuotes`. A follow-up establish pass found the same
applier-normalizes/hash-doesn't shape recurring for two more classes, independently
probe-confirmed against the real compiled applier: the walk writes byte-identical output for
each pair below, and `hashPatchBlocks` assigns different dedup keys.

- **Smart quotes** (parse-time, inside segmentation) — `normalizeSmartQuotes`.
- **Line endings, CRLF and bare CR** (match-time, after segmentation) — the walk's own
  `.replace(/\r\n/g,"\n").replace(/\r/g,"\n")` chain.
- **The `read_file` line-number prefix** (match-time, after segmentation) —
  `stripReadFilePrefix`.

**The architectural asymmetry this creates constrains any fix, and the entry's original "what
would close it" only addressed one class.** Smart quotes live *inside* `parsePatchBlocks`'s own
segmentation and could be mirrored there directly. Line endings and the read-file prefix live in
the *match-time* loop, which `parsePatchBlocks` has no equivalent of at all — closing those two
requires replicating the transformation in `hashPatchBlocks` itself, not in the parser.
"Normalize in `parsePatchBlocks`," this entry's original fix, closes exactly one of three.

**Measured, with the measurement's limits stated — not assumed rare.** Smart quotes: 0
occurrences across 24 apply_patch calls that reached the walk. A *measured* zero, not a
structural one — the marker (`[zone-self-validation]`, `rule:"smart_quote_autofix"`) predates the
sink's observation window by months, and its sibling rules on the same tag have 42 records in
that same window, so the tag is live and would have recorded a hit had one occurred. Line endings
and the read-file prefix had **no telemetry of any kind** until the pass described below —
"rare" for those two was a guess borrowed from the one class that happened to be instrumented,
not a measurement.

**What the denominator pass (`563d5b63`) added:** `[zone-apply-patch-normalization-parity]`, one
record per apply_patch call that reaches block-level normalization, carrying `blockCount`,
`smartQuoteChanged`, `eolChangedBlocks`, `prefixStrippedBlocks`. Detection only — zero change to
parsing, matching, or hashing.

**The record's population, stated precisely — the part most likely to be misread later.** Its
denominator is calls that survived ten earlier rejection paths and produced at least one parsed
block; it is **not** all apply_patch calls. `[zone-self-validation]`'s `rule:"read_before_patch"`
`"approved"` count is a *looser upper bound*, not the same population — an approved call can
still exit at any of several later rejections before ever reaching this record. The opposite
relationship holds for `[zone-apply-patch-marker-split]`: its population is exactly this
record's `blockCount > 1` slice, so this record's own count — not `read_before_patch`'s — is the
correct denominator for marker-split's rate.

**Still open — the divergence itself, for all three classes.** What would close it: normalizing
all three in `hashPatchBlocks` — importing `normalizeSmartQuotes` and `stripReadFilePrefix` from
`toolExecutor.ts` (`agentLoop.ts` already imports from that file; no cycle). This **changes
every existing dedup key** for any patch that ever contained a smart quote, CRLF, or a pasted
`read_file` prefix — a deliberate behavior change, not a silent rider on item 16's extraction.
`a7f4ff03`'s characterization tests pin the current, unnormalized values for two of the three
classes by name and would need deliberate edits: **T7** (smart quotes) and **T6** (line
endings). T6 is worth flagging specifically — it was written, in the pass that added it, as a
neutral parsing property ("CRLF line endings inside find/replace content survive unparsed"). It
is not neutral: it pins class 2 of this same defect as correct behavior, under a comment that
never named it as such.

**The real cost when it fires, not previously stated.** In the coaching path
(`CoachingController`), the demotion is label-only — every consumer of `repeatPattern` treats it
as `!== null`, `.filePath`, or `.reason` threaded into telemetry; routing and escalation behave
identically regardless of which of the four reasons fired. In `antiThrash.detectFailureStall` it
is worse: Verdict 1 misses on the hash, and Verdict 2 is excluded by its own
`last.trigger !== prev.trigger` guard (a normalization-class resubmission has the *same*
trigger), so the `failure_stall` signal is **skipped outright for that comparison, not
relabelled to a weaker verdict**. Self-clearing on the next failure, once both compared records
are hash-consistent again.

**The resume interaction.** `failureHistory` persists `patchHash` into the run envelope
(`FailureRecordLite`) with no version marker on the value itself — only the envelope's own
`version: 1`, which has never been bumped. This repo's actual schema-drift precedent is additive
optional fields with a stated default (`runId?`, `createdPaths?`), never invalidating a value
already written — which is what fixing this would be. Bounded, not open-ended: only
normalization-class-bearing patches produce a changed hash, and the stale-comparison window is
at most one comparison per file path (the next failure after a resume makes both compared
records new-style again).

**Where the code lives:** `normalizeSmartQuotes` and the walk's own EOL-replace chain are in
`toolExecutor.ts`, inside `apply_patch`'s handler; `stripReadFilePrefix` is also there.
`parsePatchBlocks` and `hashPatchBlocks` are in `agentLoop.ts`. The wrong "normalized" comment is
in `antiThrash.ts`, directly above its own `patchHash` equality check; `detectRepeatedFailure`'s
matching check is in `agentLoop.ts`. `[zone-apply-patch-normalization-parity]`'s pre-pass and
emission sit in `apply_patch`'s handler, `toolExecutor.ts`, right after the existing smart-quote
telemetry. The characterization tests pinning current values are in
`agentLoop.patchBlocksCharacterization.test.ts`.

## 19. Five parsers of FIND/REPLACE text exist, not three

**What it is:** two more places in this codebase parse the same FIND/REPLACE marker text that
item 16 describes, on a different path — the developer-patch / `plan_full_patch` flow rather
than the `apply_patch` tool path, which is why item 16's investigation never surfaced them.
`developerPatchParse.ts`'s `parseFindReplacePatch` extracts a single pair with one regex.
`patchConversion.ts`'s `extractFindReplacePair` is more tolerant: it tries four regex patterns
in sequence, accepting variants none of the other four parsers do — extra dashes in the marker,
arbitrary internal whitespace, and a bare `FIND:`/`REPLACE:` form with no dashes at all. Both
are single-pair only; neither handles the multi-block syntax `apply_patch` supports.

**Why this is worth its own entry — a checked data path, not a described one.** All three of
`tryRecoverDeveloperPatchFromModelOutput`'s call sites were traced to where `recovered
.strictPatchText` actually goes. `runLlmPatchFlow.ts`'s own direct call site feeds it straight
into `applyDeveloperPatchText`, which itself calls `parseDeveloperPatchText` to parse the text
it was just handed — that parse is what determines the file's new content. The other two call
sites (`planFullPatch.ts`) reach the same consumer by a longer path: `recovered.strictPatchText`
becomes `patchText` on `planFullPatchWithLlm`'s return value, which `runLlmPatchFlow.ts` reads
as `fullPatch.patchText` and passes to `parseDeveloperPatchText` directly (for a debug-log
anchor line only — diagnostic, not the applying call) and, separately, into
`applyDeveloperPatchText` again, the real consumer. All three call sites converge on the same
parser: `parseDeveloperPatchText`/`parseFindReplacePatch` in `developerPatchParse.ts`. This
path means `patchConversion.ts` can accept patch text none of the other four parsers would
recognize as valid on their own, then hand it onward as if it were written in the strict form to
begin with — and that handoff is confirmed, not assumed.

**What this means for item 16's "what would close it":** unifying only the three parsers item
16 names — even successfully, even choosing the behavior-preserving shape recorded there — would
leave the format with three implementations, not one: the shared index-walker, `DiffView`'s
`.split()` parser (if ever folded in), and this single-pair, four-regex-tolerant one. A "one
parser" goal that stops at item 16's three is narrower than it sounds.

**Where the code lives:** `parseFindReplacePatch`/`parseDeveloperPatchText` are in
`developerPatchParse.ts`; `extractFindReplacePair` and `buildStrictDeveloperPatchText` are both
in `patchConversion.ts`, inside `tryRecoverDeveloperPatchFromModelOutput`'s recovery pass;
`applyDeveloperPatchText`, the confirmed consumer, is in `runLlmPatchFlow.ts`, called both from
the recovery pass's own direct call site and from the `mode === "patch"` branch that reads
`planFullPatchWithLlm`'s return value.

## 20. Closed — parsePatchBlocks is exported, and its tests now name the field a mutation broke

**What it was:** `parsePatchBlocks` had no directly testable surface — every characterization
claim about its segmentation was pinned only indirectly, through the exported `hashPatchBlocks`
and a test-local helper (`expectedHash`) replicating its concatenation formula.

**What landed (`5f5f66fe`):** the function is exported; all seven segmentation-specific
characterization tests now call it directly. **The proof is the failure message, not the
export.** Before: `expected '567f4bfff58b' to be 'a3899fe5aa34'` — an opaque hex mismatch naming
nothing. Under the identical mutation, after: a field-level diff — `"find": "const label =
"hello";"` vs `"find": "const label = \"hello\";"` — naming the exact field and the exact
character that changed. That difference is what this closure was for, not the export line
itself.

**What narrowed, deliberately, and measured rather than assumed:** the separator mutation inside
`hashPatchBlocks` — the original characterization pass's own proof that its formula-mirroring
helper wasn't a silent second source of truth — killed 8 of the block's tests before this
closure, and exactly 1 after: the ANCHOR test alone, the one test in the file with no formula
replicated anywhere in its own path. The other seven, now calling `parsePatchBlocks` directly, no
longer route through `hashPatchBlocks` at all and are correctly blind to a change in its formula.
**ANCHOR is the sole remaining detector for that mutation and must not be weakened** — confirmed
by running the mutation against the converted file, not inferred from the conversion alone.

**`expectedHash` and its only consumer, the `createHash` import, were deleted** as dead code —
nothing else in the file called either.

**Only one of the two paths this entry named was taken.** Extracting `parsePatchBlocks` into a
shared module (item 16's own work) remains open and untouched; this closure took the export path
only, deliberately not preempting item 16.

**Where the code lives:** `parsePatchBlocks` and `hashPatchBlocks` are in `agentLoop.ts`; the
characterization tests are in `agentLoop.patchBlocksCharacterization.test.ts`.

## 21. Closed — retired one site, reduced a second, kept the third; the item's own premise was wrong twice

**What it was:** two pre-existing `debugLog` sites in `apply_patch`'s handler, each incomplete in
opposite directions — a CR-only check that missed ordinary CRLF, and a `detectLineEnding`-based
site whose regexes couldn't see a bare `\r` at all. A third, unrelated site shared the CR-only
check's tag while reporting on the *target file's* own mixed line endings, not FIND/REPLACE
content.

**The item's own premise was wrong in two ways, both found while establishing the actual fix, not
assumed from the item's own text.** First: `[zone-apply-patch-normalization-parity]` (`563d5b63`)
does not subsume all three sites — only the CR-only check's trigger condition, and even that with
less resolution. The parity marker collapses to one boolean per block; it cannot distinguish CRLF
from bare CR, cannot say which half of the block changed, and reports a count rather than block
indices. Retiring all three sites, which this item's own "what would close it" offered as one live
option, would have discarded the target-file site's signal with nothing replacing it.

**Second: "neither reaches the sink regardless... both are `debugLog`" was false, not just
imprecise.** The stdout shield's `appendMarkerRecord` classifies a line as sink-eligible by tag
pattern, never by which logging function emitted it — so both `debugLog` sites were, and the
surviving one still is, sink-eligible under `ZONE_VERBOSE_LOGS=1`. The sink currently shows zero
records for all four related tags — both former `debugLog` sites, the unrelated third, and the
`log`-based parity marker alike — but that is because the sink has no records after 2026-08-01
while the parity marker (`563d5b63`) landed 2026-08-02: a stale sink, not structural silence. The
`log`-based marker reading zero alongside the `debugLog` ones is the proof — if the logging
function were the reason, a `log` site would read differently from a `debugLog` one, and it
doesn't.

**What landed (`c839399b`):** the CR-only site deleted outright. The target-file site left
untouched — it answers a question nothing else does, and the parity marker has no equivalent of
it. The `detectLineEnding`-based site reduced from ten fields to six:
`matchedAfterNormalize`/`occurrencesAfterNormalize` are the only place anything reports whether
normalization actually rescued a match, and neither is reported anywhere else; `scopeActive` was
kept because it changes what the occurrence count means (a scoped search vs. the whole file);
`originalEol` was kept as context for what state normalization started from. `fileHadBOM` and
`fileEndedWithNewline` were dropped — both are consumed before or after the match decision, never
during, so neither can explain a match outcome. `reEncodedTo` was dropped as redundant with
`originalEol` for every non-mixed file, and already carried by the target-file site for mixed
ones.

**A gap found only while doing the reduction, invisible from the item's own text:** the surviving
site never carried a block index — the deleted site was the only one of the two that did.
Deleting it would have made the survivor's per-block counts unattributable across any multi-block
patch's resulting log lines. `block` was added, matching the deleted site's own convention.

**`debugLog` was kept deliberately, not left by default.** The surviving site fires unconditionally
once per block, on every `apply_patch` call — unlike the parity marker, which fires once per
*call* regardless of block count. Promoting it would multiply steady-state sink volume by average
block count, and item 10's own read-trim-rewrite race gets proportionally more exposure the more
often the sink actually trims.

**Where the code lives:** the surviving, reduced site and the untouched target-file site are both
in `apply_patch`'s handler, `toolExecutor.ts`. The test pinning the reduced payload's exact field
set is `toolExecutor.eolMatchOutcomeTelemetry.test.ts`.

## 22. Closed — `multi_edit` carries a fourth, independent copy of the EOL-normalization transformation — recount: six, not four

**What it was:** six character-identical inline copies of the same two-step EOL-normalization
transformation, five of them in `toolExecutor.ts` alongside the one canonical `normalizeEol`
implementation they never called.

**What landed (`4df53b05`):** the five in-file copies — `apply_patch`'s search target,
`multi_edit`'s find/replace/content, `write_file`'s `"cr"` re-encode prefix — now call
`normalizeEol` directly. Zero behavior change, proven two ways: the full suite moved by zero
tests, and the thirteen bare-CR tests `da3db4be`/`7665ee95` added at exactly these sites stayed
green by name.

**The proof is the mutation, not the green suite.** Breaking `normalizeEol`'s own bare-CR step
produced a *different* single failing test before the substitution than after — same count,
different member, which is stronger evidence than a plain size increase would have been. Before:
only `apply_patch`'s FIND/REPLACE routed through the helper, so the still-inline search target
stayed correctly normalized and disagreed with the now-broken FIND — one test failed on that
mismatch. After: the search target shares the same broken helper as FIND now, so the two coincide
again and that failure clears — but the target's own stray-CR-flattening, now also routed through
the broken helper, fails for the first time instead.

**A single-site revert confirmed both directions independently.** Reverting only the search-target
substitution (keeping the other four and the helper mutation in place) cleared the stray-CR
failure — proving that substitution load-bearing on its own — and simultaneously reintroduced the
original FIND/REPLACE failure, proving the find/replace substitutions are independently
load-bearing too, not just riding along.

**The sixth copy stays out, spun off rather than left as unfinished work on this item — see item
46.** `patchCorrectnessValidator.ts`'s own copy needs `normalizeEol` exported before it could
share it, a real module-boundary decision distinct from the drift risk this item was actually
about; all six copies still agree character for character regardless of whether that decision is
ever made.

**Where the code lives:** `normalizeEol` and the five substituted call sites are all in
`toolExecutor.ts`. The bare-CR tests pinning this are `toolExecutor.bareCrMatch.test.ts`,
`toolExecutor.multiEdit.bareCr.test.ts`, and `toolExecutor.writeFile.bareCr.test.ts`.

## 23. `resolveEnvelopeId`'s prefix match is silent-arbitrary, and it runs before the session lookup this pass makes deterministic

**What it is:** `resolveEnvelopeId` (`diskRunEnvelope.ts`) resolves an id/prefix in three
phases: exact filename match, then filename-prefix match, then a sessionId content-scan
fallback. The prefix phase — the second of the three, marked `// Filename prefix match` in the
function body — iterates `envelopeFiles`, built from a raw, unsorted `fs.readdir()` — the first
`key.startsWith(idOrPrefix)` wins. With two envelopes sharing a typed prefix, which one resolves
is whichever order the filesystem happens to enumerate, not a deliberate newest/oldest/error
choice — the same silent-arbitrary-match defect class the session-side lookup (`loadSessionById`,
item added this pass) exists to close.

**Why it's higher-priority than it looks.** `cli/index.ts`'s `--continue`/`--resume` routing —
the block marked `// --continue / --resume: envelope-first routing.` — resolves the envelope
FIRST, and on a hit drives the entire resume: `pendingEnvelopeResume` supplies the staged files,
todos, failure history, and pre-generated plan that `_runPromptImpl` actually resumes from
(`index.resume.test.ts`'s Fix A/Fix B coverage). The session-side lookup added this pass still
runs unconditionally on every `--resume <id>` — confirmed by reading `runTui`'s `if (opts.resume)`
block (session lookup) and its separate `if (envResumeId)` block (envelope lookup), both in
`index.tsx`: two independent `if` blocks, neither gated on the other — and its result
independently drives what conversation is displayed (`App.tsx`'s `resumedTranscript`) and the
startup banner, so it is not dead code reached only in a branch real users never hit. But for the
one thing `--resume <id>` exists to guarantee — *which run's state actually gets resumed* — an
ambiguous prefix is decided by the envelope path's arbitrary first match whenever a matching
envelope exists, which is the common case for exactly the scenario `--resume` is for: an
interrupted, not-yet-cleanly-completed run. A deterministic session-side rule sitting downstream
of an arbitrary envelope-side one only fixes what the user sees, not which work is actually
continued. Restated in one line: `loadSessionById`'s prefix rule is deterministic (`56406d90`,
newest-match-wins) and `resolveEnvelopeId`'s is not — precisely why the envelope side is the
arbitrary half left standing, and the consequential one, since it is the envelope resume that
decides which staged work actually continues, not the session lookup.

**What would close it:** give `resolveEnvelopeId`'s prefix phase the same "sort candidates, take
newest" treatment this pass gives `loadSessionById`. Not immediate: envelope filenames are
`<sessionId>.envelope.json`, no ISO prefix to sort by, so a chronological ordering would need an
mtime stat or a timestamp field read from each candidate — a real cost the session-side fix
avoided by having `listAllSessionFilenames` already sort lexicographically. Not attempted here —
the envelope layer's own resolution is explicitly out of scope for this pass.

**Where the code lives:** `resolveEnvelopeId`, `diskRunEnvelope.ts` — specifically its
filename-prefix phase (`// Filename prefix match`). Routing precedence is `cli/index.ts`'s
envelope-first routing block (`// --continue / --resume: envelope-first routing.`).

## 24. Closed — `saveSession`'s failure at exit is no longer silent, on either path

**What it was:** the clean-exit tail wrapped `saveSession` and `pruneOldSessions` in one
`try/catch` with an empty catch body — a save failure was swallowed entirely, with no marker and
no message. The signal handler's equivalent, `saveSessionSync`, had the identical bare catch.
The pre-existing comment on the clean-exit path called this "non-critical" — true of the
process's own exposure, not of the user who just lost a conversation with no indication why.

**Closed on the clean-exit path by `1917e294`: marker plus a user-facing message.**
`[zone-session-save-failed]` fires on a caught error, carrying a `phase` field distinguishing
build-time from write-time failure — added because `buildDiskSession` calls `process.cwd()`,
which throws `ENOENT` if the working directory is removed while the process is still running, a
real throw source found by reading the function rather than assumed unreachable. Without `phase`,
a build-time failure (nothing ever written) and a write-time failure (a write attempted and
failed) would report under the identical "could not save" wording — false for the first case,
where nothing was attempted at all.

**Closed on the signal path by `a466c5af`: marker only, deliberately no message.** SIGHUP means
the terminal is already disappearing by the time the handler runs; SIGTERM is typically sent by
an orchestrator with no guarantee a human is watching; non-TTY SIGINT fires specifically outside
the interactive-terminal case (`useInput`'s `\x03` handles that one, on the clean-exit path
instead). None of the three make a printed message reliably seeable. The clean-exit path is
different on this exact point — the user there provably is watching, since they just typed
`/exit` or pressed Ctrl-C themselves. The marker is the whole fix on the signal path; the same
`phase` split applies there too, since `buildSession`'s equivalent throw was already inside the
existing catch, just not phase-distinguishable before this pass.

**The marker payload carries `signal`, explicit rather than absent, so both paths stay
queryable together and separable.** `null` on the clean-exit path, the firing signal's name
(e.g. `"SIGTERM"`) on the fatal-signal path — a deliberate field in every record, not a key that
only sometimes exists.

**Still open, not attempted by either commit: `pruneOldSessions` still doesn't run on the signal
path.** A session saved during a fatal signal is never pruned against the 30-session cap on that
path — pre-existing, and by the signal handler's own design (no async I/O between the write and
the exit, to avoid the signal-exit force-kill race), not an oversight of either save-failure
commit. The session store was already measured, in an earlier pass, at 36 files — above the cap.

**Where the code lives:** `[zone-session-save-failed]`'s shared emission logic is
`_reportSaveFailure`, in `index.tsx`; called from the clean-exit tail's split `try`/`catch` (the
build phase, then the write phase) and from `registerFatalSignalHandlers`'s own equivalent split,
in the same file. The signal path passes its own injected log function explicitly; `phase` and
`signal` are required parameters on every call, not optional ones.

## 25. The resume catch-block has the same shape `2b61a51c` fixed for the miss case

**What it is:** `_resolveResumeRequest`'s call site wraps the lookup in a `try/catch`; the catch
prints `"Resume failed: <message>"` when the lookup itself throws — a fault, not a miss. This
sits textually before the separate envelope-resume block, and the two are independent `if`
blocks, neither gated on the other — confirmed by reading the current code directly, the same
structural shape item 23 already establishes for the session-lookup/envelope-lookup pair.

**The same defect class `2b61a51c` closed, deliberately left outside its scope.** `2b61a51c`
reconciled `_resolveResumeRequest`'s *miss* message against the envelope outcome, via
`_composeResumeMessage`, specifically because a miss is an expected, representable outcome. A
thrown lookup is a fault state, explicitly excluded from that pass's hit/miss framing at the
time (recorded there as a possible generalization, not built). The user-visible risk is the same
shape: if the lookup faults but the envelope resume succeeds independently, the user reads
"Resume failed" while the run actually continues, with nothing correcting it afterward.

**What would close it:** route the catch path through `_composeResumeMessage` too — treating a
caught error the way a miss is treated, reworded rather than left standing once the envelope
outcome is known — or a sibling function that handles the fault-plus-envelope-success
combination on its own terms, since a thrown error and a clean miss may warrant different
wording even under the same reconciliation principle. Not attempted here — found and recorded
during a documentation-only pass.

**The both-fault combination, verified by reading, not left open:** the two catches are fully
independent — a simultaneous throw from both prints two accurate, separate messages (`Resume
failed: ...`, then `resume: ...`) with no crash, and `_composeResumeMessage` correctly returns
`null` rather than fabricating a third, since the null `sessionMissMessage` this path produces
gives it nothing to reconcile. `localSessionId` and the startup banner both fall through cleanly
to a fresh, not-resumed state that matches what actually happened — verified, not assumed.

**Where the code lives:** the catch block sits in the same `if (opts.resume)` block as
`_resolveResumeRequest`'s own call, in `runTui`, `index.tsx` — immediately preceding the
`if (envResumeId)` envelope-resume block that `_composeResumeMessage`'s own reconciliation
already accounts for.

## 26. Closed — both Step 9 test files now name what the other covers

**What it was:** `handleToolResult.test.ts` and `parity.test.ts` both asserted on Step 9
(`handleToolResult`'s `filesModified` population from `result.filesStaged`) with no
cross-reference between them — a change to one could silently leave the other asserting the
pre-change contract, exactly what happened during the shape-B pass.

**The overlap, established concretely, not assumed (`90d39f5a`):** `handleToolResult.test.ts`'s
`describe("filesModified", ...)` holds nine tests. `parity.test.ts` has exactly two
Step-9-relevant describes, and both are near-duplicates of two of the nine — same tool, same
fixture literal, same assertion shape, differing only in output string and title wording.
`multi_edit` (all three variants), both negative cases (`filesStaged` absent; `success:false` but
`filesStaged` present), and the `toolCallLog`-threading case exist in `handleToolResult.test.ts`
alone.

**Merging was considered and rejected, on a read reason rather than an assumed one.**
`parity.test.ts`'s own header states a distinct purpose — locking in behavioral parity against a
specific old inline code path in `agentLoop.ts`, not general functional coverage. Two of its
tests happening to duplicate Step 9 assertions elsewhere doesn't make the file itself redundant;
merging would blur that stated purpose for its other nine describes.

**What landed:** a pointer in each file naming the other and what it covers, so a reader landing
on either one knows which file to change for what, rather than "see also" with no substance.

**Where the code lives:** `src/llm/toolEventHandler/handleToolResult.test.ts`'s
`describe("filesModified", ...)` and `src/llm/toolEventHandler/parity.test.ts`'s two Step-9
describes, both testing `handleToolResult.ts`.

## 27. `success` cannot identify which files `multi_edit` touched — not merely worse, structurally incapable

**What it is:** found by mutation testing during the shape-B pass, not by design review.
Mutating `handleToolResult`'s Step 9 to gate on `result.success` instead of reading
`result.filesStaged` broke `multi_edit`'s own pre-existing, untouched success test — not just the
new tests written for this pass. `multi_edit`'s tool-call arguments carry `files` (plural); there
is no singular `filePath` field anywhere in its args shape for a `success`-gated Step 9 to read.

**Why this matters:** this is not "shape B is a better fit for `multi_edit` than a `success`
gate" — it is that a `success`-gated Step 9 has no coherent value to add to `filesModified` for
`multi_edit` at all, regardless of how carefully it's written. The tool is structurally
incompatible with that design, not merely better served by another. Recorded as the independent,
mutation-discovered confirmation that `filesStaged` (or some other per-file signal) was the only
workable design for Step 9 once `multi_edit` is in scope — and as a caution against reaching for
"just check `success`" as a simpler alternative anywhere a tool's own arguments don't name a
single file.

**Where the code lives:** `multi_edit`'s argument shape (`files: string[]`, no `filePath`) is in
its handler in `toolExecutor.ts`; the mutation that found this is recorded in the commit history
for `3fa62c4a`, not preserved as code anywhere.

## 28. `write_file`'s rollback message is false in the unlink-survivor case

**What it is:** `write_file`'s post-write syntax/semantic-smell rollback unconditionally tells
the agent "The file has been reverted" — literally untrue on the one path item 14's fix added
detection for: a new-file write whose `unlinkSync` call itself throws, leaving the broken file on
disk. `filesStaged` now correctly reports this case as a persisting change, but the message text
sitting right next to that correct signal still claims the opposite.

**Why it wasn't fixed in `3fa62c4a`:** changing message wording risks rippling into tests that
assert the exact output string, and auditing every such assertion was not that pass's scope.
Recorded separately rather than folded in, so the honesty gap doesn't get lost once
`filesStaged`'s own correctness makes it easy to assume the message is right too.

**What would close it:** a conditional message — branching on whatever detection `filesStaged`'s
own logic already computed for this return, rather than a fresh check — plus an audit of which
tests assert the current fixed string, so the wording change doesn't silently break them.

**Where the code lives:** the rollback return messages are in `write_file`'s shared
syntax/semantic-smell rollback block in `toolExecutor.ts`, the same block item 14's `filesStaged`
detection now lives in.

## 29. Closed — R2 now reaches its claimed branch; `makeEntry` no longer writes

**What it was:** R2 wrote its fixture content to disk *before* calling `makeEntry`, whose own
internal write silently clobbered it — disk ended up matching `baseHash` by construction, so
`reconcileEnvelopeStaging` took the hash-match restore branch and returned before the
`flushedSet` guard was ever reached. The test passed for the "nothing changed" reason, not the
"suppressed" reason its name and setup claimed.

**What the audit established, measured not assumed (`855bdbca`):** every one of the block's 8
tests was mutation-audited — 8 mutations, one per branch/guard of `reconcileEnvelopeStaging` —
with predictions for which tests would fail written down before anything ran. They matched
exactly. **Only R2 failed to reach its claimed branch; the other seven genuinely exercise what
they name.**

**The proof is `G2O`**, not R2 turning green — R2 was already green before this pass; that was
the problem. `G2O` forces the second `flushedSet` guard site open. Pre-fix it killed only the
repo-relative sibling test; R2 survived it, because R2's real execution never reaches that guard
at all. Post-fix, `G2O` kills both — that single new kill is the evidence the reorder worked, not
R2's own passing status, which never changed.

**What landed:** two changes, not one. R2's divergent write moved after `makeEntry`, matching
the sibling test's already-correct pattern. Separately, `makeEntry` was stripped of its own
internal write entirely — the write moved to callers. This went beyond what this entry originally
proposed (a one-line reorder); tracing all 5 call sites showed only one (the base-hash-match
test) needed a new explicit write to keep working, since the other four already wrote their own
real state after calling the helper or never called it at all.

**Why the helper change mattered more than the reorder alone:** under the old design, a caller
that got the write order wrong (as R2 did) failed *silently* — the test still passed, for the
wrong reason, and nothing distinguished that from correctness short of mutating the exact guard
it claimed to test. Under the new design, a caller that forgets to write at all fails *loudly*:
`baseExisted` is set from the parameter, independent of any write, so a missing write immediately
produces a mismatch against `existsNow` and an assertion failure — not a silent pass. The reorder
alone would have fixed R2; it would not have stopped the same trap from recurring in whatever
test eventually closes item 33, below.

**Where the code lives:** the fixed test and the no-longer-writing `makeEntry` helper are both in
`diskRunEnvelope.test.ts`, inside `describe("reconcileEnvelopeStaging", ...)`.

## 30. Closed — the doc now names what's actually stamped

`bc393ead` reworded `flushedPaths`'s doc comment (`diskRunEnvelope.ts`) to name
`result.filesModified` and what it means, rather than `persistStagingOnError`. Closing this
re-traced the claim through `filesStaged` fresh rather than trusting this entry's own summary —
confirmed still true after `3fa62c4a`, unchanged since. Two nuances found along the way were
deliberately left out of the field doc: `revert_patch` removes a path from `filesModified` on
revert, and `Task` subagent results merge into the same set — both consistent with "persisted
mutation," and re-deriving `filesModified`'s own contract isn't this field's doc's job.

## 31. Closed — `absPath` gained the role, `path` didn't just lose one

`bc393ead` moved "reconciliation key" to `absPath`'s doc comment and left `path`'s accurately
narrow — display only (`diskRunEnvelope.ts`, `StagedEntryEnvelope`). The count that settled which
field actually deserved the claim: every reconciliation decision in `reconcileEnvelopeStaging`
reads `absPath`; `path` appears exactly three times, all inside `dropNotes` message strings. The
two roles — "re-seeds the staging map directly" and "reconciliation key" — coexist on `absPath`;
nothing was removed, only relocated to the field that actually has it.

## 32. A `version` bump would silently drop every existing envelope — partially closed

**What it was:** `RunEnvelope.version` is a literal `1` type, checked at four independent sites —
`loadRunEnvelope`, `listResumableEnvelopes`, `pruneOldEnvelopes`, and `resolveEnvelopeId` — each
guarding with a bare `if (env.version !== 1) return null` or `continue`, none of them logging or
surfacing anything on a mismatch.

**Fixed by `d1ce3dc4`, landed and never recorded here until now.** A shared
`isSupportedEnvelopeVersion(version, site, identifier)` helper, wired into all four sites without
changing their control flow, logs `[zone-envelope-version-mismatch]` unconditionally (`log`, not
`debugLog`) with the actual version, expected version, an identifying key or file, and which of
the four sites fired. Five tests, twenty-three assertions, three mutations run and reverted — the
version-mismatch half of this item's own "what would close it" is done, tested, and confirmed
load-bearing.

**Still open: the affected-envelope-count half was not delivered.** This item's own text asked
for a log line "naming the version mismatch and the affected envelope count." The marker fires
once per mismatched envelope encountered, at whichever site encounters it — there is no aggregate
count anywhere, in the payload or as a separate summary. A reader who wants "how many envelopes
did this affect" has to count `[zone-envelope-version-mismatch]` records themselves after the
fact; nothing in the fix computes or surfaces that number as its own signal.

**What would close the rest:** a summary line — emitted once, after a given operation's own
per-envelope calls have all run — naming how many mismatches were seen in that pass. Not
attempted; `d1ce3dc4`'s own message only ever claims the marker.

**Where the code lives:** `isSupportedEnvelopeVersion` and its four call sites are all in
`diskRunEnvelope.ts`; the tests are in `diskRunEnvelope.test.ts`.

## 33. Closed — both zero-coverage branches now have a discriminating test

**What it was:** two branches of `reconcileEnvelopeStaging` had no test exercising them at all —
existence-changed-and-suppressed, and the read-failure catch — proven by two of the write-ordering
audit's eight mutations (`G1`, `RF`) killing nothing, before and after `855bdbca`'s own fix.

**What landed (`aa088f2f`):** one test each. **Closure here means `G1` and `RF` now kill exactly
one test each — not that the new tests are green.** Green was never in question; a test that
reaches nothing still reports green, exactly as R2 (item 29) did. The only evidence that closes a
zero-coverage finding is the specific mutation that found it flipping from killing nothing to
killing something.

**How the read-failure case was reached:** a directory at the entry's `absPath`, not a missing
file — verified by a live probe, not assumed: `existsSync` reports `true` for a directory,
`readFileSync` on that same path throws `EISDIR`. A genuinely-absent file doesn't work for this
branch — it's intercepted upstream by the existence-changed branch (the same one this item was
about) and never reaches the catch at all, exactly as the existing "base file was deleted" test
already demonstrates for the drop-note case. The directory shape was the only one that reaches
the catch itself.

**The existence-changed-and-suppressed case took two attempts, and the rejected one is worth
recording.** The first candidate mirrored the existing "deleted" test's shape (`baseExisted:
true`, file genuinely absent) with a `flushedSet` entry added. Traced against the existence-check
mutation (forcing detection off): that shape falls through into a *real* `ENOENT` on the
subsequent read, landing in the read-failure catch and failing for an unrelated reason — a
confound, killing two mutations instead of the one it meant to isolate. The shape that shipped
instead mirrors the existing "created" test (`baseExisted: false`, file now present): under the
same mutation, it falls through to the unconditional new-file-restore branch instead, which
doesn't touch `dropNotes` either way — isolating cleanly to the one mutation (`G1`) it exists to
prove.

**Where the code lives:** both guards are in `reconcileEnvelopeStaging`, `diskRunEnvelope.ts`; the
two new tests are in `describe("reconcileEnvelopeStaging", ...)`, `diskRunEnvelope.test.ts`.

## 34. Closed — both comments deleted, not rewritten, and why that's the right call

**What it was:** both `flushedSet`-suppression tests' inline comments described `makeEntry` as
writing to disk "internally," and one additionally called R2 unfixed — both false since
`855bdbca`, which stripped the write and fixed R2 in the same commit.

**Why deletion, not correction (`90d39f5a`):** `makeEntry` performs zero disk I/O since
`855bdbca` — traced precisely, not assumed: moving either test's own write to before the
`makeEntry` call now produces an identical result, because there is nothing left inside
`makeEntry` to clobber it or be clobbered by. The write-ordering concern both comments described
doesn't have a corrected version to write; it has no successor at all. The helper's own doc
comment already states the current, caller-writes contract once, correctly, at the one shared
site every caller reads from — rewriting the two per-test comments would have duplicated that
contract inaccurately rather than added anything a reader doesn't already get from the helper
itself.

**The sweep, established rather than assumed:** `rg` across the whole ten-test block for every
term either stale comment used found exactly the two known blocks plus that one accurate doc
comment — no third site.

**Where the code lives:** `src/api/diskRunEnvelope.test.ts`, inside
`describe("reconcileEnvelopeStaging", ...)`, on the two `flushedSet`-suppression tests and the
`makeEntry` helper they call.

## 35. Closed — named the test instead of dropping the direction

`bc393ead` changed `makeEntry`'s doc comment (`diskRunEnvelope.test.ts`) from "see the R2 fix
above" to "see the R2 test below." Naming beat dropping the directional word: a parenthetical
pointing nowhere is less useful than a wrong-but-present one, and "the R2 fix" was a historical
idea with no single findable spot in the file, while "the R2 test" is a concrete, greppable
`it(...)` block. That's the one thing in this closure worth more than a line.

## 36. The status snapshot isn't mechanically checked against the ledger's own headings

**What it is:** nothing compares the snapshot's bucket lists against the `Closed —` prefixes on
the headings above it. The section's own caveat says it goes stale the moment any item closes;
two updates in, that's still true and still unenforced — a closing pass that forgets the
snapshot leaves the file silently self-contradicting, and a reader picking a next task from it
would pick one that's actually done. This pass's own Change 2 verification (grep every heading,
compare by hand against the snapshot's claim) is exactly the manual version of the check being
proposed here.

**A sharper distinction, from `d1ce3dc4` and `af3125f0` both landing without their closures ever
being recorded:** the check this item proposes — comparing the snapshot's bucket lists against
the `Closed —` headings — verifies the ledger's own **internal consistency**, not its **currency
against the code**. This incident is why the distinction matters, not just a restatement of it:
item 32's heading and the snapshot agreed with each other the whole time — both said open — and
both were wrong; the fix had shipped commits earlier. The proposed check would have passed,
cleanly, on a ledger that was already stale. This is the first recorded instance found where the
internal-consistency check specifically would not have helped — searched for prior instances of
this exact shape in the ledger's own text and found none stated precisely enough to count with
confidence, so none is claimed here.

**Whether a currency check — comparing the ledger against the code itself, not just against
itself — is even mechanizable: checked, not assumed, and the honest answer is partial.** One
candidate exists: grep commit messages for "item N" and diff against whether item N's current
heading says "Closed —" — this pass's own establish did exactly that, by hand, and it is what
found both `d1ce3dc4` and `af3125f0`. But the method has a real, structural blind spot: a commit
that closes an item without naming it in the message is invisible to it, by construction — there
is no way to mechanically infer "this diff closes ledger item N" from a diff that never says so.
The check would catch every future instance of this exact mistake (a commit that says "closes
item N" while the ledger is never told); it cannot catch the mistake of forgetting to say so in
the commit at all.

**What would close it:** a check that reads every `## N. ...` heading, classifies each by whether
it starts with "Closed —", and compares that set against the snapshot's own "Closed" bucket —
failing loudly on any mismatch.

**No natural home exists for this today, which changes whether it's cheap.** Checked: `scripts/`
holds only sweep/probe tooling; `package.json`'s scripts are build/test/sweep, nothing
docs-related; no test in the repo reads `docs/*.md` programmatically; `eslint.config.mjs` is
scoped to `**/*.ts` with no markdown rule; no markdownlint config; neither CI workflow
references `docs/` or `.md` at all. This isn't a small addition to existing infrastructure — it's
a new script or test file plus a new `package.json` entry, from nothing.

## 37. Two dead fixture files ship in the tarball

**What it is:** `tsc` compiles all of `src/**` per `tsconfig.json`'s `include`, with no exception
for test fixtures that don't happen to be named `*.test.ts` — so `src/test/fixtures/
toolExecutorMock.ts` and `src/cli/tui/__fixtures__/staticHarness.tsx` compile into
`dist/test/fixtures/toolExecutorMock.{js,d.ts,js.map}` and
`dist/cli/tui/__fixtures__/staticHarness.{js,d.ts,js.map}` — six files. `package.json`'s
`files: ["dist", "README.md", "LICENSE"]` allowlist has no exception for either path, and neither
filename matches `*.test.*`, so both ship in the published tarball.

**Why it's deferred:** the reachability audit that added the `files` allowlist traced every
import from `dist/cli/index.js` and confirmed nothing in that graph reaches either file — dead
weight, not a crash risk, unlike `undici` found in the same audit. Six files, a few KB, noted and
explicitly left unfixed in that pass's own scope.

**What would close it:** a `dist/.npmignore` (a subdirectory-level `.npmignore` still applies even
though the root one is overridden once `files` is set — confirmed from npm's own docs during the
same pass) or narrowing the `files` entries to exclude these two paths specifically.

**Where the code lives:** source at `src/test/fixtures/toolExecutorMock.ts` and
`src/cli/tui/__fixtures__/staticHarness.tsx`; the `files` field is in `package.json`.

## 38. Whether shipping 416 sourcemaps is deliberate is undecided, not wrong

**What it is:** the published tarball carries 416 `.js.map` files — one per compiled `dist/`
module, from `tsconfig.json`'s `sourceMap: true` (present before the publish-prep pass; that
commit added `declaration` alongside it, unchanged). Confirmed two ways — `find dist -name
"*.map"` and `npm pack --dry-run`'s own file list — both agree at 416. They account for roughly
39% of `dist/`'s own unpacked size (2.2 of 5.6 MB, measured directly) — a real, large share.

**Whether this is deliberate: no stated position exists anywhere in this repo.** A grep for
"sourcemap"/"source map" across every `*.md` file — `CLAUDE.md`, `README.md`, this file — returns
zero hits. The publish-prep pass's own plan listed "sourcemap exclusion" under its out-of-scope
section, but deferring a decision is not the same claim as the decision having been made either
way; nothing commits to shipping them (e.g., for readable stack traces from user bug reports) or
calls it unintended bloat.

**What would close it:** an explicit decision, recorded somewhere durable, either way — kept
deliberately with a stated reason, or excluded via a `files`/`.npmignore` pattern on `*.map`.
`sourceMap: true` doesn't need to change regardless of which way the shipping decision goes —
generating them for local dev and publishing them to npm are independent knobs.

**Where the code lives:** `tsconfig.json`'s `sourceMap` field; `package.json`'s `files` allowlist,
which has no `*.map` exclusion today.

## 39. Only two of the audited devDependencies are actually unused — correcting the other two

**What it is:** the publish-prep pass's reachability audit found zero `dist/` imports for
`dompurify`, `marked`, `@vitejs/plugin-react`, and `typescript`, in service of a narrower question
— which devDependencies are reachable from the published bin entry, the same shape of bug `undici`
turned out to be. Re-checked against the current tree with the scope widened past `dist/` to all
of `src/` and the root tooling configs, for the broader question of which are actually unused:

- **`dompurify` and `marked` are genuinely unused** — zero references anywhere in `src/`,
  `dist/`, or any root config. Both were vendored prebuilt browser bundles under the now-deleted
  `dist/ui/` (a stale build artifact from an old, no-longer-present copy step) and were never
  imported by anything else in the repo.
- **`@vitejs/plugin-react` and `typescript` are not unused — they're real, active
  devDependencies, correctly scoped.** `@vitejs/plugin-react` is imported directly in
  `vitest.config.ts` (`plugins: [react()]`), needed for the `.tsx` component test suite.
  `typescript` is invoked directly by `package.json`'s own `build`/`postbuild`/`typecheck`/
  `check-types` scripts via its `tsc` binary — never via an ESM `import`, which is why the
  import-based reachability check reported zero, but "no import found" isn't the same claim as
  "unused" for a devDependency whose job is being run as a build tool rather than imported as a
  library. Neither was ever a hygiene concern; their absence from `dist/`'s reachability graph is
  by design.

**What would close it:** remove `dompurify` and `marked` from `devDependencies` — nothing in the
current tree references either, by name or by import, anywhere. Leave `@vitejs/plugin-react` and
`typescript` alone.

**Where the code lives:** `package.json`'s `devDependencies`; confirmed absent from `src/`,
`dist/`, and every root config file (`vitest.config.ts`, `tsconfig.json`).

## 40. Closed — `zone-vsextension` still type-checks after the `exports.types` repoint

The publish-prep pass repointed all 16 `exports[*].types` fields from `./src/*.ts` to
`./dist/*.d.ts`. `zone-vsextension`, a sibling project depending on `"zone": "file:../zone"` and
importing 13 of the 16 subpaths in its own `src/extension.ts`, was the one real, currently-working
consumer that change could have broken — its `moduleResolution: "Bundler"` previously followed
`types` straight to raw source. Checked directly, not assumed: `npx tsc --noEmit` inside
`zone-vsextension` after the repoint exits 0 with zero output. The new `./dist/*.d.ts` targets
resolve cleanly through the same `file:` symlink (`node_modules/zone -> ../../zone`), now that
`declaration: true` actually produces them.

**Where the code lives:** `zone-vsextension`'s imports are in its own `src/extension.ts`; the
repointed fields are in this repo's `package.json` `exports` map.

## 41. Closed — apply_patch matches bare-CR content now; the reachability estimate undersold it

**What it was:** `apply_patch`'s search target normalized CRLF only while the FIND normalized
both CRLF and bare CR, so a bare-CR file's FIND was always normalized past what it was being
searched against — the match was guaranteed to fail on text copied verbatim out of the file.

**The recommended fix reversed direction mid-investigation, and the reversal came from measuring
a precedent, not from reconsidering.** The first establish pass recommended FIND-only
normalization — stop normalizing bare CR out of the FIND, leave the search target and the
eventual write untouched — specifically to avoid changing what gets written to disk. A follow-up
establish measured what the *existing, working* CRLF path already does: a model-authored, pure-LF
REPLACE spliced into a CRLF file comes out fully re-encoded to CRLF on write, model content
included. There is no precedent for leaving anything mixed. Once that was measured rather than
assumed, both FIND-only variants (leave REPLACE's own normalization as-is, or make it CRLF-only
to "match") were probed and found to produce **byte-identical mixed output** regardless —
changing what gets written wasn't a risk to avoid, it was the same thing the architecture was
already doing for CRLF, extended to a third ending.

**The reachability estimate this item opened with was too narrow, corrected by probing before any
code was written.** Framed as classic-Mac-only and effectively extinct. The probes found: no FIND
the model could write escapes the defect — a FIND with `\r` pre-converted to `\n` fails
identically to the verbatim copy, so there is no workaround at all; any file with a stray bare CR
*anywhere in the patched region*, not only pure classic-Mac files, is affected; and `multi_edit`
carried the identical asymmetry independently, failing more quietly than `apply_patch` —
`success: true`, zero replacements, a "not found" note rather than an explicit rejection.

**What landed (`da3db4be`):** the search target normalizes bare CR now, matching the FIND; the
output re-encode gained a `"cr"` branch (both the append and strip arms of trailing-newline
handling); `multi_edit` gained the same two changes, inseparably — see item 42's closure for why.
`write_file`'s own `"cr"` re-encode arm landed separately (`7665ee95`), since it has no match step
and no coupling to the other two.

**Where the code lives:** `apply_patch`'s search-target normalization and output re-encode, and
`multi_edit`'s content normalization and re-encode, are all in `toolExecutor.ts`.

## 42. Closed — the coupling was the blocker, not a detail; multi_edit's own asymmetry was worse than framed

**What it was:** `detectLineEnding` couldn't see a bare CR at all — such content classified as
`"none"`, and `analyzeLineEnding` fell that through to `dominant: "lf"`. `dominant` is read
directly as the write-back decision in `apply_patch`, `write_file`, and `multi_edit`, so this
item's own text framed itself as a secondary coupling note, deliberately not a standalone defect
— "the real, unambiguous defect is item 41's match failure."

**That framing didn't survive contact with the fix.** Item 41's own recommended direction (see
its closure) requires re-encoding output to the file's dominant ending, model content included —
impossible to do correctly for a bare-CR-dominant file without this item's own widening landing
first. The two were never separable: this item's classification blind spot was the direct blocker
on item 41's only correct fix, not an independent, lower-priority coupling.

**`multi_edit`'s own asymmetry was worse than this item's original text stated.** The original
text said `write_file` and `multi_edit` "don't route through that same match step" as
`apply_patch` — true for `write_file`, false for `multi_edit`, which carries the identical
FIND/REPLACE-vs-content normalization mismatch as item 41's own defect, independently. Established
by probe, before any fix code was written: `multi_edit`'s current CR "preservation" on a
non-spanning find is accidental — nothing in its pipeline ever looks at a bare CR outside the
matched region, not deliberate design — so applying only the content-normalization half of the
fix converts that accidental silence into active destruction on the exact path that works
correctly today. The fix could not ship as a match-only change; the re-encode arm had to land in
the same commit.

**What landed (`da3db4be`, `7665ee95`):** `detectLineEnding`/`analyzeLineEnding` widened to a
`"cr"` ending, chosen by highest raw count among CRLF/LF/CR occurrences (ties broken
crlf > lf > cr, preserving the existing crlf-over-lf tie behavior). `write_file`'s `"cr"` re-encode
arm landed as its own commit, since it alone has no match step and no coupling to the other two.

**Where the code lives:** `detectLineEnding` and `analyzeLineEnding` are both in `toolExecutor.ts`;
`dominant` is read at its three write-back sites in `apply_patch`'s, `write_file`'s, and
`multi_edit`'s own handlers, same file.

## 43. `detectLineEnding`'s return value has no behavioral consumer — a function that looks load-bearing and isn't

**What it is:** found by mutation testing during the `da3db4be` pass, not by design review.
Forcing `detectLineEnding` to return `"lf"` for bare-CR content — a direct, deliberate corruption
of its own classification — broke nothing in the full battery of tests written for that pass.
`analyzeLineEnding`'s `dominant` field, the only value any of `apply_patch`, `write_file`, or
`multi_edit` actually reads to decide what to write, is computed directly from raw
`crlfCount`/`lfOnlyCount`/`crOnlyCount` — it never reads `detectLineEnding`'s return at all.
`detected` (what the mutation actually changes) has exactly one consumer anywhere: `originalEol`,
which feeds only item 21's surviving telemetry site, itself `debugLog`-gated.

**Recorded as a structural fact worth knowing, not a defect.** Nothing is wrong — `dominant`'s own
independent computation is correct, tested, and mutation-proven (see items 41/42's closures). But
a function whose output shapes a return type, gets destructured into a named field, and reads as
if it feeds a decision — doesn't, for the one caller that matters. A future change to
`detectLineEnding` alone, made on the assumption that `dominant` derives from it, would silently
not do what its author expected.

**What would close it, if anything — genuinely unknown, not a covered decision:** either
`dominant` should read `detected` instead of recomputing the same counts a second time, or the
duplication is deliberate (perhaps to keep the two computations independently auditable, or
because `detected`'s four-way partition — `crlf`/`lf`/`cr`/`mixed`/`none` — and `dominant`'s
three-way one don't map cleanly onto each other for the `"mixed"` case, where `detected` needs a
value `dominant` doesn't have an equivalent of). This pass didn't establish which; recorded as
open rather than guessed at.

**The only reason this is testable at all today** is the telemetry-observing test added during
the same pass specifically to close this gap — before it existed, no test anywhere could have
distinguished `detectLineEnding` returning the right value from returning a wrong one for bare
CR, in either direction.

**Where the code lives:** `detectLineEnding` and `analyzeLineEnding` are both in `toolExecutor.ts`;
the telemetry-observing test is in `toolExecutor.bareCrMatch.test.ts`.

## 44. Closed — `hasTrailingNewline` carried the same bare-CR blind spot, independently, and no consumer trace could have found it

**What it was:** `hasTrailingNewline`'s regex (`/\r?\n$/`) couldn't recognize a lone trailing `\r`
as a newline — the identical shape of gap items 41/42 closed, in a third, independent site. It
feeds `fileEndedWithNewline` and the append/strip arms of `apply_patch`'s trailing-newline
handling, both already in scope for the `da3db4be` pass.

**Two separate, careful traces of `dominant`'s consumers — the third establish pass's own
question, and this document's own item 42 before it — both missed it, and the reason is
structural, not carelessness.** `hasTrailingNewline` doesn't read `dominant`, `detected`, or
either classifier function at all; it answers an entirely separate question (does this content
already end in a newline) that the CR-aware re-encode arms merely depend on being answered
correctly. A consumer trace finds everything that reads a given value — it cannot find a sibling
defect in a function that reads nothing the value comes from.

**Found only by running a test, not by reading — the fifth closing-section pattern's own lesson,
recurring on a smaller scale.** The first bare-CR match test failed with a missing trailing `\r`;
tracing the failure back led to `hasTrailingNewline` directly, not through any `dominant`-shaped
path.

**What landed (`da3db4be`):** widened to `/[\r\n]$/` — a single-character-class match, simpler
than the original three-way alternation and provably equivalent for the LF/CRLF cases it already
handled correctly, additionally correct for the CR case it didn't. Folded into the same commit as
the match fix, as a direct mechanical necessity: the CR-aware trailing-newline arms this pass was
already adding would have been dead code for exactly the bare-CR files they exist to handle,
without this fix landing alongside them.

**Where the code lives:** `hasTrailingNewline` is in `toolExecutor.ts`, module-private, with its
two call sites in `apply_patch`'s handler, same file.

## 45. An unrelated double-escaped pattern sits near item 22's genuine copy — unverified, not asserted as a defect

**What it is:** inside `layer1LexicalIntegrity`'s `localizedValidationMode` branch — a sibling
function to `layer2LanguageHeuristics`, which holds item 22's genuine copy, in the same file —
computing `scanTarget`'s line window uses
`input.updatedContent.replace(/\\r\\n/g, "\\n").split("\\n")`: a regex matching the literal
four-character sequence `\`,`r`,`\`,`n` as text, and a split on the literal two-character string
`\n`, neither of which matches a real carriage-return or newline byte. Found by proximity while
establishing item 22's recount — this is not a copy of item 22's transformation, and was not
sought out by design review of this function.

**Deliberately not asserted as a defect — established, not investigated.** Whether this is wrong
depends on what `input.updatedContent` actually holds at this specific call site: if it is ever
itself an escaped-text representation rather than real source content, the pattern could be
correct for its own input. That trace was not run. Recorded rather than fixed or dismissed,
matching this document's own standard for findings surfaced in passing.

**What would close it:** trace `input.updatedContent`'s actual shape at this call site — real
file content, in which case this pattern never matches anything and the line-window logic
silently degrades to operating on the whole string, or something already escaped, in which case
it may be correct as written.

**Where the code lives:** inside `layer1LexicalIntegrity`'s `localizedValidationMode` branch, in
`patchCorrectnessValidator.ts`, `src/engine/`.

## 46. Whether to export `normalizeEol` for `patchCorrectnessValidator.ts`'s sixth copy is undecided

**What it is:** spun off from item 22's closure. Five of the six EOL-normalization copies now
point at `normalizeEol` directly (`4df53b05`); the sixth, in `patchCorrectnessValidator.ts`
(`src/engine/`, a different module), still can't — `normalizeEol` is module-private to
`toolExecutor.ts`. Unifying it needs exporting the helper first.

**Why this is a separate decision, not unfinished work on item 22 itself:** item 22's own risk —
copies drifting apart from each other, the way item 18's smart-quote normalization did — is
closed for all six; they still agree character for character, confirmed before the five
substitutions landed. The sixth copy's own purpose differs from the other five's (defensive
heuristic normalization on already-proposed content, not match-or-write correctness), which is
itself a real argument for leaving it independent rather than forcing every EOL-shaped transform
in the repo through one shared helper.

**What would close it:** decide either way — export `normalizeEol` (a real, if small,
module-boundary change: a public API surface where there was none) and point the sixth copy at
it, or record explicitly that the two purposes are different enough to justify five copies
sharing an implementation and a sixth standing alone.

**Where the code lives:** `normalizeEol` is in `toolExecutor.ts`, not exported. The sixth copy is
in `src/engine/patchCorrectnessValidator.ts`; see item 22 for the full establish behind this
finding.

## Status snapshot — a partition, not a priority ordering

A snapshot, current as of this commit — it goes stale the moment any item closes or is
reclassified; the numbered entries above are the source of truth, and this section only saves a
reader the trouble of reading all 46 to find out which ones still need something. No index of
this kind existed before this pass — the intro's own "not a changelog, not a roadmap, not a
priority ordering" cautions against ranking by importance, which this section doesn't do: it
groups by mechanical status only, items listed by number within each group, not by what to do
first.

**Closed** (19): 6, 7, 8, 14, 20, 21, 22, 24, 26, 29, 30, 31, 33, 34, 35, 40, 41, 42, 44

**Actionable now** — a fix is specified in the entry itself; nothing new needs to be learned
first (15): 2 (after 16), 10, 12, 13, 15 (after 2), 16, 17, 18, 23, 25, 28, 32, 36, 37, 39

**Blocked on data** — closing requires an observation that doesn't exist yet (2): 1, 4

**Neither — a structural fact recorded, with no fix proposed** (10): 3, 5, 9, 11, 19, 27, 38, 43,
45, 46

Items 1, 2, 12, 16, 18, and 32 are partially closed or corrected; the classification above covers
only the portion still open, not the whole entry.

---

## A pattern this document is built to avoid

Four stale line-number references were found across one session. **At least one was stale from
the moment it was created, not just later** — the sharper version of the lesson: a commit
message cited two sibling catch sites by line number, and that *same commit's own diff*
inserted code above both sites in the file. The numbers it recorded were already wrong by the
time the commit existed as a permanent record; a reference into an actively-edited file can be
wrong on arrival, not only wrong eventually. The other references drifted stale after being
written, as later, separate commits shifted the files around them:

- The commit message described above, whose citation was invalidated by its own diff.
- A gitignored audit notes file recording the same two now-stale line numbers.
- A test file's own header comment citing a line range for the code path it exercises, drifted
  stale by later edits to the same file.
- A code comment (near a chain-saturation feature flag) citing a specific line for the defect
  it was describing — drifted stale the same way, found and corrected in the same commit that
  fixed the defect it described, replaced with a description of the enclosing construct rather
  than a new number.

The common cause: every one of these was written by someone who had just looked at, or just
moved, the code — and none of them accounted for the file around them being edited often
enough that a line number into it has a short half-life, sometimes shorter than the commit
recording it. Every reference in this document — and the convention this document asks future
entries to follow — points at code by shape: an enclosing function, a branch condition, a
marker tag, a symbol name. None of it goes stale when the file around it does; it fails loudly
instead, per the note above, if the shape itself is ever renamed away — including in this
document's own item 23, originally written with line numbers despite this section, found on a
later pass and converted to shape references the same way this section asks of everything else.

## A second pattern, a few commits apart: self-reference defeats a mutation test

A test verifying a constant's own value must not import that constant. Two opposite-conclusion
cases of this occurred in this codebase within a few commits of each other, and are recorded
together so the difference reads as a distinction, not an inconsistency.

**Case one — importing the shared value was wrong.** `f7cd3c2e`'s exit-hint tests originally
computed their own expected prefix by slicing the same length constant `_buildExitResumeHint`
reads internally. Mutating that constant moved both sides of the comparison together — the
mutation-testing pass caught its own target test still passing under the mutation it was meant
to catch. The fix: hardcode the literal expected value in the test instead of deriving it from
the constant under test.

**Case two — importing the shared value was right.** The pass immediately before it, `2b61a51c`,
pinned the coupling between `_resolveResumeRequest`'s miss-message wording and
`_composeResumeMessage`'s pattern match against it, by having the test import the same suffix
constant both functions already share. There, the test's claim was not "is this constant's value
correct" but "do these two independently-callable functions still agree with each other" — and
sharing the constant is exactly what makes a wording change in one correctly break the test
pinning the other, rather than each drifting in its own test file's separately-typed copy.

**The discriminator:** whether the test's claim is about a value or about an agreement. A test
proving a constant equals some expectation must hold that expectation independently, or the
constant can drift without the test noticing. A test proving two pieces of code still agree with
each other should share the value they're both supposed to agree on, or the test can't tell
"they agree" from "they both changed the same way and still match by coincidence."

## A third pattern: mutations that replace a real value can cascade for the wrong reason

A mutation that swaps a real caught value for a synthetic stand-in can fail a *different* test
than the one it targets, for reasons unrelated to the property under test — the stand-in
clobbers state a different test depends on, and the resulting cascade reads as broader coverage
than the mutation actually proved.

`a466c5af`'s mutation 4 hit this directly. The property under test was "does the handler report
a failure on a successful save" — proving it required forcing the reporting function to fire
when it shouldn't. The first attempt did this by replacing the real caught error with a
synthetic placeholder and calling the reporting function unconditionally. That also meant the
*failure* path's own test — which asserts the real error's code reaches the marker — received
the placeholder instead of the real error, and failed too. Not because the failure-path guard
was broken; because the mutation's own construction had, as a side effect, discarded the value
that test depends on.

**The fix: add a call beside the real path, don't replace what it already does.** The
unconditional report was moved to fire only after a successful write, immediately beside the
existing, untouched failure-path reporting — leaving the real caught error exactly where the
other test expects to find it. The mutation then isolated cleanly to the one test it was meant
to break.

**Why this matters beyond tidiness:** a cascade that looks like coverage is worse than no
cascade, because it reads as the mutation proving more than it did. Two failing tests from one
mutation reasonably suggests both are testing the mutated property; here, one of the two was
failing for a reason the mutation's *implementation* introduced, not the property it described.
Prefer adding a call beside the real path over replacing what the real path already does,
whenever a mutation needs to force an alternate outcome.

## A fourth pattern, beside the third: a default on an injected seam is a silent fallback

An injectable dependency with a default value is a silent fallback: a call site that omits it
compiles, runs, and behaves correctly in production — the default typically points at the same
real implementation the injection exists to stand in for — while being invisible to whichever
test harness relies on the injected path specifically.

`a466c5af`'s `_reportSaveFailure` had exactly this shape at one point: its logging parameter
defaulted to the module-level `log`, added purely to spare two clean-exit call sites one
argument each. On the signal path, a call site that forgot to pass its own injected log function
would have silently used the real one instead — indistinguishable from correct in production
(both eventually reach the same sink), but invisible to `fatalSignalHandlers.test.ts`'s injected
version, whose whole purpose is capturing what the handler emits without touching the real sink.
Making the parameter required turned that possible silent break into a compile error instead.

**The mutation that proved the seam was real, not assumed:** swap the handler's own injected
logger for the module-level one at its one call site. The marker test failed, and the marker
itself leaked into real stdout during the test run — visible, concrete evidence the harness was
observing the injected path specifically, not passing by some other mechanism.

**The connection to house rule #1** (unknown input reaching a plausible default silently): a
default parameter on a test seam is that same rule applied to dependency injection. The "unknown
input" is a forgotten argument; the "plausible default" is a same-shaped function that happens
to work in production while defeating the one thing the seam was built for.

## A fifth pattern, following the fourth: tracing is not running

Establish work that traces every consumer by reading is not the same claim as "the full suite
will pass." The shape-B pass traced apply_patch's 27 returns and write_file's 10, cross-checked
against `multi_edit`'s own precedent, and produced a design validated three separate ways before
a line of production code was written. It still missed six mock sites across three test files and
an entire second test file for the function it was changing (item 26) — none of it visible to
reading, all of it visible to one full-suite run.

**Why tracing alone couldn't have found it:** every one of the missed sites was a mock returning
a hand-built result object under the *old* contract — `{success: true, output: "..."}` with no
`filesStaged` — sitting in a test file the establish pass had no reason to open, because nothing
about Step 9's own source pointed at them. Reading traces what the code being changed does and
what calls it; it does not enumerate every place something else assumed the old behavior and
encoded that assumption into a fixture.

**The rule this confirms, not a new one:** the full-suite step in this session's own process is
not a formality to run once local tests pass — it is the step that catches exactly this class of
miss. A change that looks locally scoped, fully traced, and mutation-tested against every named
consumer can still break code nobody read, because nobody had a reason to. Treat "full suite green"
as load-bearing evidence, not confirmation of what tracing already established.

This has recurred enough since to count precisely: four more confirmed instances in this document
alone. The sharpest is `hasTrailingNewline` (item 44) — two separate, deliberate traces of
`dominant`'s consumers preceded it and both missed it, because the defect lived in a function that
read nothing either trace was tracing. `detectLineEnding` (item 43), from the same pass, is
quieter: a mutation that broke nothing revealed its return value has no behavioral consumer at
all, despite reading as load-bearing. R2 (item 29) is the same shape from further back — a test
that passed for a reason unrelated to what it claimed to exercise, found only by mutating the
guard it named. The claim this supports is sharper than "the full-suite step is not a formality":
in this codebase, the findings that have actually changed a decision have come disproportionately
from running the code, and reading's load-bearing role has been to know what to run — which
mutation, which test, which probe — not to substitute for running it.

## A sixth pattern, following the fifth: a mutation that reroutes cannot prove suppression

A guard's whole effect is suppressing an otherwise-observable signal — so a passing test that
depends on that guard and a passing test that never reached it can look identical from the
outside: both produce the same empty output. A mutation that only changes *which branch
executes* — flipping a comparison, forcing a conditional's other arm — without touching the
guard's own condition is blind to any input that already satisfies the guard: the correct
behavior and the mutated behavior both suppress, coincidentally, for different reasons, and the
test meant to catch the mutation can't tell them apart.

The write-ordering audit (item 29) found this directly, on two separate mutations. Flipping
`reconcileEnvelopeStaging`'s hash comparison, and forcing its existence-changed check
unconditionally, both left the block's two `flushedSet`-suppression tests passing — not because
either mutation failed to change behavior, but because both tests' fixtures happen to hold a path
that the (unmutated) `flushedSet` guard would suppress regardless of which branch routed them
there. Only a mutation to the guard condition itself discriminated: forcing
`!flushedSet.has(entry.absPath)` open killed exactly the tests whose passing genuinely depends on
the guard running, and left every other test untouched.

**The consequence for those two tests specifically, left as-is:** neither asserts on `restored`,
only on `dropNotes` — so neither can distinguish "suppressed by the guard" from "restored by
accident, which also happens to leave `dropNotes` empty." This gap is pre-existing and shared by
both, not introduced by `855bdbca`'s fix to the first of the two; closing it means asserting
`restored.has(...)` is false alongside the `dropNotes` check in both.

**The rule:** proving a test reaches a suppression guard requires mutating the guard's own
condition, not the branch that leads to it. Any mutation that only changes routing is confounded
by every input that would satisfy the guard by coincidence — which is exactly the set of inputs
a suppression test is built around, making this exactly the case a routing-only mutation is
least equipped to check.

**Verified, not just proposed:** `aa088f2f` added the `restored` assertion this section describes
to both suppression tests, then re-ran the hash-compare mutation. It had killed neither test
before; with the assertion in place, it kills both — the exact discrimination this section
predicted, confirmed by running it rather than left as an untested recommendation.

## A seventh pattern, following the sixth: a mutation-testing revert can destroy the very change it's supposed to be testing around

Every pattern above is about designing a test or a mutation correctly. This one is about running
them: `git checkout -- <path>` restores a file to its last *committed* state, not to whatever
state it was in a moment ago. A mutation-testing cycle that reverts by checkout is safe only
because the file being mutated has no other uncommitted change sitting in it — true for every
prior mutation pass in this session, where the file being mutated had nothing else pending. The
first time that stops being true — a pass that both edits a file and mutates that same file to
test around the edit — a checkout-based revert wipes the edit along with the mutation, silently,
with nothing surfacing a warning that anything but the mutation was undone.

**This is exactly what happened during `5f5f66fe`.** The pass added `export` to
`parsePatchBlocks`, then began mutation-testing `agentLoop.ts` to validate the surrounding test
conversion. The first revert (`git checkout -- agentLoop.ts`) restored the file to `HEAD` —
discarding the still-uncommitted `export` along with the mutation being undone. Nothing had been
staged, so there was no intermediate state for `checkout` to fall back to. Caught by a follow-up
grep for the export before the next mutation, not by any tool surfacing a warning.

**What closed it in the moment:** re-apply the edit, then `git add` it — once staged,
`git checkout -- <path>` restores the *index*, not `HEAD`, so a mutation revert undoes only the
mutation. Every subsequent revert in that same pass verified the export survived, by grep, before
proceeding.

**A second incident, `c839399b`, on a different file, by an author who had just read this exact
pattern.** The pass deleted one EOL telemetry site and reduced a second (ledger item 21) in
`toolExecutor.ts`, then began mutation-testing the new test asserting on the reduced payload. The
first revert (`git checkout -- toolExecutor.ts`) ran before the real edit was staged — restoring
`HEAD`, wiping the deletion and the reduction along with the mutation, silently, the same failure
mode as `5f5f66fe`. Caught the same way: a follow-up grep for `findHadCrOnly` (the deleted site's
own local variable) before the next step, not by any tool surfacing a warning. The edit was
re-applied, staged, and both remaining mutations reverted cleanly against the index. Having just
read the pattern describing this exact mistake did not prevent it — only the habit of checking a
revert's result did.

**The rule, sharpened after the second incident:** staging before the first mutation is the
prevention, and it worked, every time it was actually in place. But it isn't what caught either
incident — both times, the first mutation of the pass ran before staging, and the loss was caught
only by checking what the revert actually restored, not by remembering to stage first. Staging
early makes the check unnecessary; checking after every revert catches the failure even when
staging was forgotten, which is exactly the state both incidents started from. Do both: stage a
real, in-progress edit before the first mutation touches the same file, whenever a pass both edits
and mutation-tests one file in the same commit — and after every `git checkout --` revert during a
mutation-testing cycle, verify by reading (a grep for a known-deleted or known-changed identifier
is enough) that what came back is what was expected, not just that the mutation is gone.

## An eighth pattern, beside the sixth: a mutation can be correct and still coincide with one test's answer

The sixth pattern is about a routing mutation invisible to inputs a downstream guard would
suppress regardless of the route taken. This is a different mechanism: a value-substitution
mutation — replacing a computed result with a fixed constant — invisible to exactly the one test
built around it, because that test's own correct answer already equals the constant. No guard, no
routing; the discriminator is coincidence between the mutated value and the input's real answer,
not between two code paths converging on the same output.

`da3db4be`'s mutation testing (ledger items 41/42) found this directly. Forcing
`analyzeLineEnding`'s `dominant` to always `"lf"` was meant to prove the stray-CR test — a
mostly-LF file with one bare CR, expected to flatten to LF — depended on the real dominance
computation. It didn't: that file's real answer is already `"lf"` (four real LF newlines outweigh
one stray CR), so the mutation and the unmutated code agree for that exact input, and the test the
mutation targeted stayed green. The mutation was not inert, though — it broke six other tests in
the same battery, every one whose correct `dominant` is `"crlf"` or `"cr"`, cleanly proving the
same line the named target failed to.

**The rule:** a value-substitution mutation's named target is only a prediction, not a guarantee
— check whether the target's own correct answer happens to equal the substituted constant before
trusting a green result from it alone. A battery built with variety (here, tests whose correct
answers span all three of `"crlf"`/`"lf"`/`"cr"`) still proves the mutation even when one specific
test can't, but that has to be confirmed by running the whole battery, not assumed from which
test the mutation was written to target.

A related discovery, from a different pass (`4df53b05`, unifying ledger item 22's own inline EOL
copies): the same coincidence-blindness applies to *comparing two mutation-testing runs*, not
just to one test's own named target. The check used there — did the failure-set size grow after
the substitution, proving the new code now routes through the shared helper — was itself a
shortcut with the identical shape of blind spot. Breaking the shared helper before the
substitution failed exactly one test; breaking it after failed exactly one test again — same
count. The substitution was real anyway: the *member* changed, trading one failure for a
mechanistically different one (the search target and the still-broken FIND coincided again,
clearing one failure, while the target's own now-shared normalization broke for the first time).
A set-size comparison could not see this; only reading which test failed, and why, could.

**The sharpened rule:** compare failure-set *membership*, not cardinality. Two mutation-testing
runs of equal size can differ completely in which tests they killed, and that difference — not
the count — is where the real information about whether a change altered behavior actually lives.

## A ninth pattern, beside the seventh: a ledger entry that prescribes a check does not cause the check to happen

The seventh pattern's own second incident already names this shape once: "having just read the
pattern describing this exact mistake did not prevent it — only the habit of checking a revert's
result did." This is the same lesson, in a different domain — not git reverts during mutation
testing, but establish passes during investigation.

Item 22 prescribed its own mitigation in plain language: "recorded so a future normalization
change to one copy prompts a check of the others." `da3db4be` was exactly that change — it
touched two of item 22's own named copies. Three establish passes and two implementation commits
followed across the same investigation, all tracing `dominant`'s consumers exhaustively, and item
22 itself was read and cited more than once in that work. None of those passes searched outside
`toolExecutor.ts` for other copies of the transformation item 22 is about. The check item 22
asked for ran for the first time only in a dedicated pass afterward, and found a copy — in
`patchCorrectnessValidator.ts` — that no prior pass in this investigation knew existed.

**The lesson is not "the establish passes were careless."** Each of them did real, verified work
inside its own stated scope; the `dominant`-consumer trace was exhaustive *for `dominant`*. The
lesson is narrower and less comfortable: an entry can be read, cited, and still not fire, because
nothing connects "I am changing this line" to "check what this ledger already says about lines
like it." Reading the prescription is not the same event as executing it, and no pass in this
document's own history noticed the gap between the two until this one.

**Not a numbered item, on purpose.** Item 36 is the closest-looking sibling — both are about the
ledger prescribing something nothing enforces — but item 36 is a document-mechanics problem with
a script-shaped fix: compare the snapshot's bucket lists against the headings, mechanically,
every time. This has no script-shaped fix. Nothing can mechanically verify "did the establish
pass search outside the file it was editing" — that is a question about what a reader did with an
open-ended prescription, not a comparison between two closed sets. It belongs with the patterns
that record lessons about this document's own process, not with the numbered items that record
closable facts about the codebase.
