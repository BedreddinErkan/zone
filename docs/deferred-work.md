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
telemetry passes that touched this area. The ordering constraint this paragraph used to warn
about — line-anchoring the walk in `toolExecutor.ts` without also line-anchoring the
identically-segmenting `parsePatchBlocks` in `agentLoop.ts`, leaving `hashPatchBlocks`'s
failure-dedup key disagreeing with what the applier actually did — has not stopped being true; it
has stopped being possible to violate. Item 16's unification means both call sites now delegate
to the same `segmentPatchBlocks` function: a single implementation cannot desync from itself. The
structural alternative — sidestepping the parsing question entirely — is recorded separately as
item 17. Item 16, now closed, and item 15 record two sharper, related consequences of this same
defect. Item 20 records the prerequisite that now exists for attempting the parser change safely:
`a7f4ff03`'s characterization tests, which pin exactly the values the shared implementation needs
to preserve and didn't exist when this constraint was first written.

**Where the code lives:** the block-splitting walk and the comment describing this defect now
live in `src/utils/patchBlocks.ts` (the shared module item 16's unification extracted them into),
not `toolExecutor.ts`. The new marker's emission sites stay in `toolExecutor.ts`, just after the
call to `segmentPatchBlocks(patch)` and inside the FIND-not-found rejection branch, in
`apply_patch`'s handler.

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

## 10. Closed — rotation replaced the read-trim-rewrite; the original premise was correct, and a later pass's refutation of it was not

**What it was:** when `~/.zone/markers.jsonl` crossed its size cap, the sink trimmed it back
down by reading the whole file, dropping the oldest lines, and rewriting it — read-trim-rewrite,
not an atomic replace. The trim function's own header comment already stated the consequence: a
concurrent process's append landing between the read and the rewrite was lost. Deferred as
low-risk, since the file sat at roughly 39% of its cap.

**A later pass in this same session reported that the trim function did not exist at all — that
report was wrong, and the correction matters more than the fix itself.** A task brief claimed
`trimSink` "does not exist... no cap check, no read-modify-write, no such function," that the
sink lived at `<repo>/.zone/markers.jsonl` rather than `~/.zone/`, and that the file was
~4.4 MB growing ~44 KB/run. None of that held up against the actual source: `trimSink` existed,
called from `appendMarkerRecord`; `MARKER_SINK_MAX_BYTES` was referenced at three source sites
and three test sites; the file was 820,429 bytes, unchanged since 2026-08-01. This item's original
text, above, was accurate throughout. A ledger entry surviving a false refutation is only useful
if the refutation is recorded too — which is why this paragraph exists rather than a silent edit.

**The same false path claim recurred a second time, in the very next brief, framed as an
already-established fact.** Swept the whole ledger for anything that might rest on it (`rg` for
`~/.zone` mentions and record-count/zero-record language) — nothing does. The passages that cite
measured counts from the sink (item 18's smart-quote/normalization counts, item 21's "no records
after 2026-08-01") were both measured at `~/.zone/markers.jsonl`, the only path this file has
ever lived at, independently reconfirmed this session by direct, repeated measurement. The
wrong-path claim affected two task briefs, not anything written into this document.

**What landed (`f7fd16d6`):** the read-trim-rewrite is gone. `trimSink` now renames the active
file to `.1` — no read-modify-write window, so nothing left to be non-atomic about. Keeps
exactly one rotated generation (nothing reads this file programmatically, checked); the 2 MB cap
is unchanged (no growth since 2026-08-01 gave a reason to move it). A concurrent
appender is safe under rotation because `fs.appendFileSync` opens by path fresh on every call —
confirmed empirically, not assumed — so nothing strands on the old inode after a rename.

**Two failure paths were added that the original read-trim-rewrite never had to consider,
because it had no equivalent syscalls to fail:** a non-`ENOENT` `statSync` failure and a
`renameSync` failure each warn once per process via a raw `process.stderr.write` — never via
`log()`, which would recurse back through the sink's own write path (see item 54). Neither
failure can lose the record itself: `appendMarkerRecord`'s own append already lands on disk
before either syscall runs.

**Where the code lives:** `trimSink`, `appendMarkerRecord`, `MARKER_SINK_MAX_BYTES`, and the two
failure-path warnings are all in `src/utils/markerSink.ts`. Tests in `markerSink.test.ts`.

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

## 13. Closed — `noUnusedLocals` and `noUnusedParameters` are both enabled; 61 real findings resolved, 7 recorded as their own follow-ups

**What it was:** `deriveVerdict.ts` carried an unused `didApplyPatch` import that survived every
`tsc --noEmit` run because `tsconfig.json` omitted `noUnusedLocals`, and survived every commit
because ESLint is configured but not wired into any npm script. This entry's own original text
framed the choice as flag-vs-lint; that framing was half right, corrected here rather than
repeated: `eslint.config.mjs` exists and defines real rules (`@typescript-eslint/naming-convention`,
`curly`, `eqeqeq`, `no-throw-literal`, `semi`), but neither `eslint` nor `typescript-eslint` (the
parser and plugin it imports) is present in `node_modules`, and `package.json` names neither as a
dependency. The config cannot load — a sharper gap than "not wired into npm scripts," which
understates it as a wiring problem rather than a missing-dependency one.

**The count, checked rather than assumed:** `npx tsc --noEmit --noUnusedLocals
--noUnusedParameters` found 61 findings across 25 files at the point this pass started — the 56
this entry's own original text already recorded for `noUnusedLocals` alone, plus 5 strictly new
from adding `noUnusedParameters`, diffed byte-for-byte to confirm nothing was lost by adding the
second flag.

**What landed, in two commits:**
- `3c0ab85a` fixed two of the 61 as real, established-safe regressions before the mechanical
  sweep: `validatedStatus` (`runLlmPatchFlow.ts`) — wired correctly at introduction, silently
  dropped 80 minutes later by a same-object-literal wording-only pass, restored with zero
  observable effect today since `type:"validated"` has no consumer in either `sink.ts` or
  `eventToActions.ts`; and `finalRunReport` on the `atomic_patch_failed` return
  (`runLlmPatchFlow.ts`) — computed via `generateFinalRunReport` and discarded, matching 10
  sibling return sites in the same function that already populate the same optional field.
- `75bbe7ca` enabled both flags and resolved the remaining 59: 47 genuinely dead (deleted), 3
  cosmetic positional/for-of parameters (`_`-prefixed), and 9 lines across 7 stories that read as
  real defects rather than tidiness — left computed, marked `void x;` (not `_`-prefix, which
  TypeScript does not exempt for a plain `const`/`let` local — confirmed by measurement before
  applying it) plus a one-line comment naming the open question, so a later pass can pick each up
  without re-deriving it. One of the 7 is recorded below as its own entry (item 51); the other 6
  are recorded together as item 52.

**The flag's value, demonstrated rather than assumed:** deleting the dead findings surfaced a
cascade the compiler's own single pass never shows in one run — in `patchCorrectnessValidator.ts`,
`normalizedBefore`/`normalizedAfter` were the only callers of `normalizeForSanityCompare`, which
was the only caller of `normalizeWhitespace` and `stripCommentsForComparison`. All four were
verified dead independently, not assumed transitively, before deletion — a four-symbol chain the
compiler only ever reports one link of per pass.

**Flag-is-live proof:** a throwaway unused local introduced in `src/cli/colors.ts` was rejected by
`tsc --noEmit` naming it directly (`src/cli/colors.ts(25,9): error TS6133:
'zoneItem13FlagLiveProof' is declared but its value is never read.`), then reverted and
re-confirmed clean.

**Build and typecheck share this config:** `npm run build` runs `tsc -p tsconfig.json`; `npm run
typecheck` runs `tsc --noEmit`, which picks up the same `tsconfig.json` implicitly from the
working directory — one config file, two invocations, both enforcing the new flags identically.

**What this closure doesn't cover:** this entry's original text named three risks — "the next dead
import, dead export, or unreachable branch." `noUnusedLocals`/`noUnusedParameters` only ever
catches the first. An unused *export* is invisible to this flag by design (TypeScript can't know
whether an external consumer imports it), and neither flag does reachability analysis on branches.
That remaining gap is recorded separately as item 53.

**Where the code lives:** `tsconfig.json`'s compiler options (`noUnusedLocals`/
`noUnusedParameters` both `true`); `eslint.config.mjs` (configured, still not runnable — its own
dependencies aren't installed).

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

## 16. Closed — the two index-walkers are one implementation now; they were already character-for-character identical, not "near-identical," before that

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

**What would close the real half — the two index-walkers sharing one implementation — is now
simpler than it was.** Before item 18's fix, sharing the walk's full logic, normalization
included, would have changed every existing `hashPatchBlocks` dedup key for a smart-quote-bearing
patch — a deliberate behavior change, not a pure extraction. That constraint is gone:
`parsePatchBlocks` now applies the same `normalizeSmartQuotes`, in the same position, via the
same shared module, so `hashPatchBlocks`'s dedup key already reflects normalized smart-quote
text. Sharing the segmentation loop *and* the smart-quote call it contains is behavior-preserving
on both sides now — the "post-pass only" restriction this paragraph used to state no longer
applies.

Item 18's other two normalization classes (line endings, the read_file prefix) live in the
match-time loop `toolExecutor.ts` runs after segmentation — `parsePatchBlocks` has no equivalent
of that loop and never will, since it only ever feeds `hashPatchBlocks`, not file matching.
Unifying segmentation was never going to touch those two classes, and still doesn't — that part
of the original framing was correct and is unchanged. What has changed: unifying segmentation now
resolves **none** of item 18's remaining scope, not "at most one" of three. The one class
segmentation-sharing could ever have addressed, smart quotes, is already resolved — by converging
`parsePatchBlocks` onto a shared function, not by unifying segmentation itself. Item 16 and item
18's remaining two classes are now fully decoupled: neither's fix depends on, or is blocked by,
the other.

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

**A prerequisite for the real half had already landed before this closure, with one count to
correct.** The walk in `toolExecutor.ts` was no longer inline — it was `segmentApplyPatchBlocks`,
an exported, directly callable function, mirroring `parsePatchBlocks`'s own suite (`a7f4ff03`,
`5f5f66fe` — the commits behind the suite being mirrored, checked via `git show --stat`, not this
file's own origin) case for case. This entry previously said ten characterization tests;
`toolExecutor.patchBlocksCharacterization.test.ts` holds eleven `it()` blocks at HEAD (`grep -c
'^\s*it('` — twelve before the repair below deleted one), not ten — a miscount caught verifying
this closure, not introduced by it. Both sides of the eventual shared implementation were pinned
before extraction even started; before this prerequisite pass, only `parsePatchBlocks` was.

**The divergence this entry and item 18 used to describe is now closed — and the paragraph that
used to sit here got what that means backward.** Two comparison tests run
`segmentApplyPatchBlocks` and `parsePatchBlocks` on the same curly-quote input and assert
equality — the walk's parsed block and the parser's parsed block match, field for field, because
both now normalize smart quotes through the same shared function. A third does the same for
CRLF, also asserting equality, which was never in dispute. **No test anywhere asserts a
divergence, and no test currently guards against a unification silently dropping the
`normalizeSmartQuotes` call from the shared function.** This paragraph previously claimed the
opposite — that such a collapse "now fails a test instead of shipping quietly." It would not: a
test that compares the two walkers against each other is structurally blind to a defect both
sides would share after unification, since neither side would have anything independent left to
disagree with. That absence is the finding this paragraph should have recorded the first time. A
guard that would actually catch a silent collapse has to compare against something that doesn't
move when the shared function changes — an external reference, not a sibling implementation.
That's the difference between a test that survives extraction and one that goes hollow. The
repair that followed built exactly this kind of guard for the one real gap it found — this was
true when written, and is now confirmed, not merely argued; see below.

**The extracted function's return shape is `{blocks, sqFindTotal, sqReplaceTotal}`, not a bare
block array — and the two counts have to stay separate, not just present.** They feed five read
expressions across three downstream consumers, not four call sites: a gate check
(`sqFindTotal + sqReplaceTotal > 0`), a mutation of a caller-supplied accumulator
(`input.selfValidationCounts.smartQuoteFixes`), the `[zone-self-validation]` marker — which
reports `findOccurrences`/`replaceOccurrences` independently — and the
`[zone-apply-patch-normalization-parity]` marker, which only ever needs the boolean sum.
`[zone-self-validation]` is the one a shared function returning a single pre-summed total would
silently break; the parity marker would keep passing, masking the regression.

**It stayed in `toolExecutor.ts`, not `fileDiff.ts`, deliberately — not an oversight of the
candidate-home paragraph above.** `fileDiff.ts` is still verified cycle-free and is the likely
home if unification is ever attempted, but relocating now would itself be unification-prep; the
prerequisite pass scoped that out on purpose, leaving the actual move for whenever unification is
attempted for real. When unification was attempted for real (`39366c54`), it used neither
location named above: the shared function landed in a new module, `src/utils/patchBlocks.ts`,
beside `smartQuotes.ts` — not `fileDiff.ts`. See "Where the code lives" below.

**The loose end is closed (`9f6539e4`).** `agentLoop.patchBlocksCharacterization.test.ts`'s
smart-quote test comment claimed the walk normalizes quotes "at match time" — it's parse-time,
inside `segmentApplyPatchBlocks`'s own segmentation loop, not a separate later match-time step the
way `normalizeEol`/`stripReadFilePrefix` are. Fixed in its own commit rather than bundled into a
documentation-only pass, matching `90d39f5a`'s precedent for comment-only corrections. The
citation alongside it, pointing at `normalizeSmartQuotes`'s own definition in `toolExecutor.ts`,
was checked separately and found accurate at the time — the extraction added
`segmentApplyPatchBlocks` as a new function elsewhere; it did not move `normalizeSmartQuotes`.
**That citation is stale now, timed precisely rather than just flagged.** `9f6539e4`, the commit
that checked and confirmed it, is a direct ancestor of `cd02808c` — confirmed with
`git merge-base --is-ancestor`, not assumed from commit order alone. `cd02808c` is item 18's own
convergence fix, and it is the commit that created the shared smart-quotes module and moved
`normalizeSmartQuotes` into it — roughly an hour after `9f6539e4`, on the same day. The citation
was correct when checked and has not been revisited since. It should now point at
`normalizeSmartQuotes`'s real home, the shared smart-quotes utility module both
`segmentApplyPatchBlocks` and `parsePatchBlocks` import — not `toolExecutor.ts`.

**What a unification pass would actually need, established this pass, not assumed from the
extraction alone.** The two loop bodies are byte-for-byte identical apart from the count capture
and accumulation — every other difference (the entry-coercion form, the block-array type name,
declaration order, the doc comment) is incidental or a documentation-transfer obligation, not a
behavioral one. Only `toolExecutor.ts`'s own call site needs the counts; `hashPatchBlocks`
consumes blocks alone. A wrapper preserving both existing public signatures — the shared core
returns `{blocks, sqFindTotal, sqReplaceTotal}`, `parsePatchBlocks` returns just `.blocks` — would
leave every caller and all three characterization/telemetry test files passing unedited.

**This list is superseded by the actual repair, not merely fulfilled.** See the closure paragraph
below ("What the repair deleted, and where its coverage actually lives") for what happened to
each of the five tests this list named, verified against the file rather than restated here as a
plan.

The doc comment on `segmentApplyPatchBlocks` (now `segmentPatchBlocks`) carried across to its new
home, `src/utils/patchBlocks.ts`, including item 2's known-defect paragraph — confirmed present
at HEAD.

**Two downstream entries this touched, now actioned rather than left as a note.** Item 55's
header-comment problem and item 2's ordering-constraint paragraph were both flagged here, while
this entry was still open, as dependent edits due once unification landed. It has — see item 55
and item 2 directly for the updated text; this entry no longer carries that substance itself, to
avoid two copies drifting apart.

**Closed (`39366c54`, `90b3fc11`).** The extraction landed first: `src/utils/patchBlocks.ts`, a
new leaf module beside `smartQuotes.ts`, holds `segmentPatchBlocks` — the shared segmentation
core, byte-for-byte the same loop body both former walkers ran, differing only in count
bookkeeping. `toolExecutor.ts`'s `segmentApplyPatchBlocks` became `export { segmentPatchBlocks as
segmentApplyPatchBlocks } from "../utils/patchBlocks.js"`; `agentLoop.ts`'s `parsePatchBlocks`
became a one-line wrapper, `return segmentPatchBlocks(patch).blocks;`. Both public signatures are
unchanged, no caller outside the two files changed, no test was edited in that commit. The repair
followed, in `toolExecutor.patchBlocksCharacterization.test.ts`: five tests carrying a
now-tautological walker-vs-walker comparison were repaired individually, not uniformly — three
(*"item 2's known misparse…"*, *"the divergence from parsePatchBlocks the ledger recorded is
closed…"*, *"double smart quotes converge to the same hash…"*) had just the comparison line(s)
deleted, each pointing to existing absolute coverage of the same fixture; one (*"CRLF is NOT a
divergence axis"*) was deleted whole; one (*"single smart quotes converge too…"*) had its
comparison line replaced with two new absolute-value assertions, closing a real,
previously-uncovered gap rather than just removing a vacuous line.

**Two implementation findings worth keeping, both found live while extracting, neither
foreseeable from reading the two walkers side by side beforehand.** A re-export does not bind the
name into the re-exporting file's own local scope: `toolExecutor.ts`'s internal `apply_patch`
call site needed its own separate `import { segmentPatchBlocks } from
"../utils/patchBlocks.js"` (confirmed present at HEAD) alongside the re-export, or it fails `tsc`
with `TS2304`, undefined name. And both files' `normalizeSmartQuotes` imports went fully dead once
their inline loops moved into the shared module, and had to be removed under `noUnusedLocals`
(item 13) — confirmed absent from both files at HEAD.

**The repair's real finding corrects the framing this entry itself set up for the single-quote
test, and has to be stated exactly.** The repair's own plan expected that reverting the
single-quote test's two new absolute assertions back to its old tautological walker-comparison
line, then re-running the drop-normalization mutation, would make the test pass again —
confirming the repair, not something else in the same commit, was what closed the gap. It did
not: the test still failed the mutation, at its pre-existing hash assertion
(`hashPatchBlocks({patch: curly})` against the straight-quote equivalent) — an assertion that was
already present before the repair touched this test, was never tautological, and was already
independently sufficient to catch a dropped normalization on its own. The repair did not close a
detection hole; nothing was silently passing before it landed. What the repair actually did was
pin what *correct output* looks like for single curly quotes specifically — something the hash
comparison confirmed convergence on but never stated outright. This entry should not be read as
having closed a hole; it pinned exact expected output where before only convergence was pinned.

**The mechanism this entry predicted is now measured, not argued.** Dropping
`normalizeSmartQuotes` from the shared core makes the walker-to-walker comparison lines go green
under the mutation — confirmed live, both when those lines still existed (the extraction commit's
own mutation testing) and by the fact that nothing depending on that comparison shape remains to
go blind now that they're deleted. The lines that were never blind — the hash comparisons, and
(post-repair) the single-quote test's new absolute values — caught the same mutation at every
point checked, before and after the repair. Comparison-against-a-sibling is structurally blind
after unification; comparison-against-an-external-reference isn't. This is this entry's own prior
claim about where real guards live after unification, now confirmed empirically rather than
argued.

**What the repair deleted, and where its coverage actually lives.** The tautological comparison
line was deleted from *"item 2's known misparse: an embedded matched FIND/REPLACE pair (e.g. a
doc example) truncates the real block's replace and fabricates a second block — pinned
deliberately, not desired behavior"* and both tautological lines from *"the divergence from
parsePatchBlocks the ledger recorded is closed: both normalize smart quotes now"* — both in
`toolExecutor.patchBlocksCharacterization.test.ts` — each pointing, in the deletion comment, at
the sibling file's own absolute-value test asserting the identical fixture's output, since once
both sides delegate to one function a walker-vs-parser comparison pins nothing `tsc` doesn't
already guarantee. The whole test *"CRLF is NOT a divergence axis"* was deleted; the property it
checked — that CRLF sequences pass through both parsers' segmentation unaltered — is covered
independently by *"CRLF line endings inside find/replace content survive unparsed — only the
marker-adjacent leading/trailing newline is stripped, internal `\r\n` is untouched"* in the same
file, and by the identically-titled CRLF test in `agentLoop.patchBlocksCharacterization.test.ts`
on the `parsePatchBlocks` side — each asserting the same `\r\n`-bearing fixture's output as its
own primary assertion, not incidentally to a larger fixture. Both citations were re-read and
confirmed at HEAD before the deletion, not assumed from their titles.

**Where the code lives:** the shared segmentation core, `segmentPatchBlocks`, is in
`src/utils/patchBlocks.ts`, beside `smartQuotes.ts`. `toolExecutor.ts` re-exports it as
`segmentApplyPatchBlocks` and separately imports it under its own name for its internal
`apply_patch` call site; `agentLoop.ts`'s `parsePatchBlocks` wraps it, returning `.blocks` alone.
Characterization tests: `toolExecutor.patchBlocksCharacterization.test.ts` and
`agentLoop.patchBlocksCharacterization.test.ts`. `hashPatchBlocks` stays in `agentLoop.ts`;
`parseBlocks`, `DiffView`'s separate third parser, stays in `DiffView.tsx`, unaffected.

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

## 18. The applier's normalization was never mirrored into the dedup hash — partially closed, smart quotes resolved

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

**Smart quotes are now closed (`cd02808c`).** `parsePatchBlocks` applies `normalizeSmartQuotes`
in the same position `segmentApplyPatchBlocks` always has — after the leading/trailing-newline
trim, on both `find` and `replace` — so `hashPatchBlocks`'s dedup key now reflects normalized
text for this class. Direction was converge-up: the walk's own normalization was preserved, not
removed, to close the gap. The function and its `SMART_QUOTE_MAP` moved to
`src/utils/smartQuotes.ts`, imported by both `toolExecutor.ts` and `agentLoop.ts`. The
bounded-staleness framing below (the resume interaction) already covers this formula change too:
a pre-fix persisted `patchHash` fails at most one comparison per file path and self-clears on the
next fresh-vs-fresh comparison.

**Still open — two of the three classes, not all three.** What would close the rest: normalizing
line endings and the read_file prefix in `hashPatchBlocks` — importing `stripReadFilePrefix` and
the walk's own EOL-replace chain from `toolExecutor.ts` (`agentLoop.ts` already imports from that
file; no cycle). This still **changes every existing dedup key** for any patch that ever
contained a CRLF or a pasted `read_file` prefix — a deliberate behavior change, not a silent
rider on item 16's extraction. `a7f4ff03`'s characterization tests pin the current, unnormalized
value for the remaining class by name and would need a deliberate edit: **T6** (line endings) —
it was written, in the pass that added it, as a neutral parsing property ("CRLF line endings
inside find/replace content survive unparsed"). It is not neutral: it pins class 2 of this same
defect as correct behavior, under a comment that never named it as such. **T7** (smart quotes)
needed the same kind of edit and got it, as part of the fix that closed that class — see above.

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

**Where the code lives:** `normalizeSmartQuotes` is in `src/utils/smartQuotes.ts`, imported by
both `toolExecutor.ts` (`segmentApplyPatchBlocks`) and `agentLoop.ts` (`parsePatchBlocks`). The
walk's own EOL-replace chain and `stripReadFilePrefix` are still in `toolExecutor.ts`, inside
`apply_patch`'s handler — the two classes that remain open. `parsePatchBlocks` and
`hashPatchBlocks` are in `agentLoop.ts`. The wrong "normalized" comment is in `antiThrash.ts`,
directly above its own `patchHash` equality check; `detectRepeatedFailure`'s matching check is in
`agentLoop.ts`. `[zone-apply-patch-normalization-parity]`'s pre-pass and emission sit in
`apply_patch`'s handler, `toolExecutor.ts`, right after the existing smart-quote telemetry — see
item 55 for what closing this item's smart-quotes class didn't change about that marker's own
test file's header comment. The characterization tests pinning current values are split across
two files now: `agentLoop.patchBlocksCharacterization.test.ts` (`parsePatchBlocks`) and
`toolExecutor.patchBlocksCharacterization.test.ts` (`segmentApplyPatchBlocks`, plus the direct
comparison tests between the two).

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
shared module (item 16's own work) remained open and untouched at the time; item 16 has since
done it. This closure took the export path only, deliberately not preempting item 16.

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

## 25. Closed — the resume catch-block message no longer claims total failure

**What it was:** `_resolveResumeRequest`'s call site wraps the lookup in a `try/catch`; the catch
printed `"Resume failed: <message>"` when the lookup itself threw — a fault, not a miss. This
sits textually before the separate envelope-resume block, and the two are independent `if`
blocks, neither gated on the other. `2b61a51c` had already reconciled the *miss* message against
the envelope outcome via `_composeResumeMessage`, specifically because a miss is expected and
representable; a thrown lookup was a fault state explicitly left outside that pass's scope. The
risk: if the lookup faulted but the envelope resume succeeded independently, the user read
"Resume failed" while the run actually continued, with nothing correcting it afterward.

**The ordering constraint is what shaped the fix, not a stylistic choice.** The catch around
`_resolveResumeRequest`'s own call, inside the `if (opts.resume)` block, runs *before* the
separate `if (envResumeId)` envelope-resume block that follows it — at the moment the message is
written, whether the run will continue is not yet known. That rules out both "your run
continues" (unknown) and "the resume failed" (untrue whenever the envelope succeeds next). The
one claim true in every combination: the prior session did not load. `487341f5` reworded the
message to say exactly that — "Could not load the prior session: `<message>`" — and nothing else.

**A composer was considered and rejected, not skipped for effort.** Routing the catch through
`_composeResumeMessage` (`2b61a51c`'s own suggested generalization) doesn't work: its rewrite is
driven by `RESUME_MISS_SUFFIX`, a pattern matching `"; starting fresh."` — a claim that's false
the moment an envelope resume is in play, which is exactly the case this fix needed to handle. And
`_composeResumeMessage` never sees the fault message in the first place: the catch has no
`sessionMissMessage` to hand it, since the lookup threw before producing one. A sibling composer
was the shape left available — rejected as unwarranted, not overlooked, since a single reworded
string already reads true in both combinations.

**Why a one-string fix is proportionate:** `resumedSession`'s downstream effects were traced in
full, not assumed to be one field. Four, across two files — `localSessionId`'s own fallback chain
(superseded by the envelope whenever both resolve), the startup banner's `isResumed` flag, and,
via the `resumedSession` prop passed to `<App>`, `resumedTranscript` and `resumedStartedAt` (both
destructured from it in `App.tsx`) feeding the initial transcript array and session-start
timestamp. All four are display-only. Staged work, todos, and the plan all arrive through
`pendingEnvelopeResume`, entirely independent of this catch — nothing structural is at stake, only
what the user sees on the way in.

**No test landed, and that's recorded as a real coverage gap, not an omission.** `runTui` — the
function this catch lives inside — has zero direct call sites in any test file in this codebase.
The file's four other testable helpers (`_resolveResumeRequest`, `_composeResumeMessage`,
`_buildExitResumeHint`, `_reportSaveFailure`) were extracted specifically so each is callable
without standing up `runTui`'s own Ink render and signal-handler setup; this catch never received
that treatment. **What would close it:** extract the catch's body — construct the message, decide
whether to write it — into a fifth testable function the same way, at the cost of touching the
call site once more.

**Reachability, checked rather than assumed uniform:** a corrupt session file does *not* reach
this catch in steady state — both `loadSessionById` and `loadLastSession`'s listing pass go
through `loadSessionOrSignal`, which swallows every non-ENOENT fault and returns it as a miss
(already reconciled by `2b61a51c`). What actually reaches the catch is narrower: an EACCES (or
similar) on the sessions directory's `readdir`, or a TOCTOU race specific to `loadLastSession`'s
own final re-read (`return loadSession(cwd, list[0])`), which bypasses the swallowing wrapper.
Real, but not the everyday corrupt-file case; `[zone-session-load-failed]` — the marker that would
fire on the swallowed path — has zero records in the sink.

**The both-fault combination, verified separately and unaffected by this fix:** a simultaneous
throw from both the session lookup and the envelope lookup prints two accurate, independent
messages with no crash, and `_composeResumeMessage` correctly returns `null` — the null
`sessionMissMessage` this path produces gives it nothing to reconcile. `localSessionId` and the
startup banner both fall through cleanly to a fresh, not-resumed state that matches what actually
happened.

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

## 28. Closed — `write_file`'s rollback message is false in the unlink-survivor case

**What it was:** `write_file`'s post-write syntax/semantic-smell rollback unconditionally told
the agent "The file has been reverted" — literally untrue on the one path item 14's fix added
detection for: a new-file write whose `unlinkSync` call itself throws, leaving the broken file on
disk. `filesStaged` correctly reported that case as a persisting change; the message sitting next
to it claimed the opposite.

**The existing-file path had a second gap, but not a second live falsehood.** A pre-implementation
establish found the existing-file restore checked `stagedWrite`'s return only enough to choose a
disk-write fallback, never to confirm that fallback succeeded. Nothing wrapped it in a swallowing
catch the way the new-file path's `unlinkSync` had one, so a failed fallback could only throw
uncaught — skipping the message and `filesStaged` together, not returning a false claim next to a
correct one. The real gap was the missing guard, not a second instance of this item's defect
already sitting there. Closing it meant adding that guard, which made a genuine third state
(`restore_failed`) reachable for the first time.

**`apply_patch` carried the same unguarded-restore shape at three independent rollback sites** —
`syntax_broken_post_write`, `semantic_smell_post_write`, and `inline_ts_syntax_error` (rendered
through `buildApplyRolledBackMessage`, not an inline string) — each restoring separately, not four
returns sharing one site. Fixed in the same commit; splitting it would have created exactly the
divergence item 22 documents.

**What shipped (`a94caeb1`):** the message now derives from a three-state outcome — reverted,
new-file-survived, or restore-failed — instead of asserting one. `filesStaged` now reports the
file on the restore-failed path for both tools, a behavior change, not just a wording one. All
three consumers were checked first: `didApplyPatch` and `countsTowardChainSaturation` both gate on
`success === true`, so a failed return never reaches the `filesStaged` read for either tool;
`filesModified` (and from there `git add`) gains a path that genuinely holds unreverted content —
the intent, not a side effect to guard against.

**Coverage was zero before this commit** — confirmed by grep across the suite, not assumed. No
test asserted any of these messages, and no test exercised a rollback path in either tool.

**`"escape"` is structurally unreachable on every restore call** — each passes the same `filePath`
and `repoPath` already validated on the way in, so the 3-arg `stagedWrite` overload every restore
site uses is statically `boolean`-only. The branch isn't in the restore logic; nothing further was
needed to keep it defensive.

**Where the code lives:** `attemptRestore`/`describeRestoreOutcome` in `toolExecutor.ts`, shared
by `write_file`'s rollback block and all three `apply_patch` rollback sites;
`buildApplyRolledBackMessage`'s `restoreFailed` parameter in `applyRollbackFeedback.ts`. Tests in
`toolExecutor.rollbackMessage.test.ts` (new) and `applyRollbackFeedback.test.ts`.

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

## 32. Closed — a per-sweep mismatch-count summary now exists; three of four sites carry it, resolveEnvelopeId's is partial by construction

**What it was:** `RunEnvelope.version` is a literal `1` type, checked at four independent sites —
`loadRunEnvelope`, `listResumableEnvelopes`, `pruneOldEnvelopes`, and `resolveEnvelopeId` — each
guarding with a bare `if (env.version !== 1) return null` or `continue`, none of them logging or
surfacing anything on a mismatch.

**Fixed by `d1ce3dc4` (marker) and `63c06395` (count).** A shared
`isSupportedEnvelopeVersion(version, site, identifier)` helper, wired into all four sites without
changing their control flow, logs `[zone-envelope-version-mismatch]` unconditionally (`log`, not
`debugLog`) with the actual version, expected version, an identifying key or file, and which of
the four sites fired. Five tests, twenty-three assertions, three mutations run and reverted — the
version-mismatch half of this item's own "what would close it" was done, tested, and confirmed
load-bearing first. A second helper, `logEnvelopeVersionMismatchSummary(site, mismatchCount,
totalExamined)`, logs `[zone-envelope-version-mismatch-summary]` once per sweep — **only when
`mismatchCount > 0`**, symmetric with the per-record marker, which already only fires on a
mismatch; a summary on every clean sweep would be noise on every ordinary startup/prune cycle.

**The count was not already derivable in practice.** Per-record markers carry `site` and
`identifier`, so a careful reader could group and tally them by hand after the fact — but that
breaks the moment two sweeps run in the same process (TUI startup's `listResumableEnvelopes`
alongside a throttled `pruneOldEnvelopes`), where an ungrouped count conflates two different
totals unless the reader already knows to split by `site`. The pass that closed this reached that
conclusion independently before finding it: this item's own prior text had already said the same
thing in different words ("nothing... computes or surfaces that number as its own signal") —
convergent, not merely inherited.

**Three of four sites carry the summary; `loadRunEnvelope` deliberately does not.**
`listResumableEnvelopes` and `pruneOldEnvelopes` both sweep every directory entry unconditionally,
so each one's `totalExamined` is a complete count for that operation. `loadRunEnvelope` loads
exactly one envelope with no loop — there is nothing to aggregate, so it was left untouched. This
is an asymmetry by design, not a gap the fix missed.

**`resolveEnvelopeId`'s count is partial by construction.** Its fallback loop — the third of
three lookup phases, after two filename-only phases that never call the version check at all —
stops at its first content match. Its summary reports what that lookup actually examined before
stopping, not a directory-wide census. None of the three instrumented sites answers "how many
mismatches exist in the directory" in isolation — each is scoped to its own operation, the same
way the per-record marker always was.

**`isSupportedEnvelopeVersion`'s signature is unchanged.** An accumulator parameter was
considered and rejected: `loadRunEnvelope` would have had to pass a no-op value it has no use
for, or the helper would have grown an internal "is a caller tracking this" branch — coupling a
cross-cutting aggregate concern into what stays a single-purpose check-and-log helper. Each
walker's own local counter, incremented in the branch that already existed next to `continue`,
was enough.

**`resolveEnvelopeId`'s early `return` became `found = ...; break`,** so the summary call has
exactly one exit point to sit before. The search's own behavior — same order, same first-match
stop, same corrupt-file skipping — is unchanged; the file's 66 pre-existing tests stayed green
throughout, alongside 6 new ones and 3 further mutations run and reverted.

**Where the code lives:** `isSupportedEnvelopeVersion` and `logEnvelopeVersionMismatchSummary`,
and all their call sites, are in `diskRunEnvelope.ts`; the tests are in
`diskRunEnvelope.test.ts`.

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

## 36. The status snapshot isn't mechanically checked against the ledger's own headings — partially closed

**What it was:** nothing compared the snapshot's bucket lists against the `Closed —` prefixes on
the headings above it, and no natural home existed for such a check — `scripts/` held only sweep
tooling, no test read `docs/*.md`, no CI workflow touched markdown.

**The consistency half is closed.** `scripts/deferredWorkSnapshot.test.ts` (`964296ac`) parses
every `## N.` heading and the snapshot's own bucket lines, asserting four things: the Closed-set
comparison this item originally proposed, plus three coverage assertions it didn't — declared
count vs. actual list length per bucket, no item in two buckets, and none in zero. **Coverage is
the dimension with the demonstrated catch, not the one this item named.** Run against the tree at
`9f45989c` — the commit where item 36 itself had a heading but appeared in no bucket — the
Closed-set comparison passes cleanly, and only the coverage assertion fires: "Item(s) 36 have a
heading but appear in no snapshot bucket." The check this item originally proposed would have
missed the one real failure that ever occurred; it was never the dimension that broke.

**The currency half closes as a decision, not a fix.** A second establish pass built and ran a
currency check — matching commit messages against item numbers, comparing against heading status
— and it is not worth shipping. At HEAD it produces 5 flags and 0 true positives: every flag is a
legitimate reference (a context citation, an explicit "not fixed here" disclaimer, or a
deliberate partial closure whose heading correctly doesn't say "Closed —"). Its structural blind
spot is real — a commit that closes an item without naming it is invisible to it by construction,
which is exactly how items 7 and 32 went unrecorded for a session's worth of passes — but the
opposite failure (constant false alarms on a ledger that's currently correct) is just as real and
not tunable away. It would also need `fetch-depth: 0` added to CI's checkout (shallow by default
today) to see history at all, and no test in this suite shells out to git — a boundary this would
be the first to cross. Recording the technique instead: item references across this repo's
history take at least 14 distinct phrasings (`item N`, `Item N`, `ledger item N`, `items N-N`,
`items N, N, N`, `items N/N`, and others); a naive `/item (\d+)/i` misses every plural form. A
future hand sweep should use `/items?\s+(\d+(?:\s*[-\/,+&]\s*\d+)*)/gi` and expect to read every
hit rather than trust the count.

**Where the code lives:** the check is `scripts/deferredWorkSnapshot.test.ts`; the currency
technique is recorded here only, not implemented anywhere.

## 37. Closed — dead fixture files no longer ship in the tarball, and the original count was short by one fixture

**What it was:** `tsc` compiles all of `src/**` per `tsconfig.json`'s `include`, with no
exception for test fixtures that don't happen to be named `*.test.ts` — so fixture modules
compiled into `dist/` and shipped in the published tarball with nothing in `dist/cli/index.js`'s
import graph ever reaching them. `package.json`'s `files: ["dist", "README.md", "LICENSE"]`
allowlist had no exception for any of them.

**The count was short by one fixture, not wrong in two directions.** This entry originally named
two fixtures and six compiled artifacts (`toolExecutorMock`, `staticHarness`, three files each).
The real figure, from `npm pack --dry-run` against a fresh build: **nine artifacts across three
fixtures** — a third, `scriptedLlm.ts`, had gone unnoticed by every prior pass, including the one
that added the `files` allowlist in the first place. Verified by a line-diff of the pack listing
before and after the fix: exactly nine lines removed, nothing else changed, 1251 files → 1242.

**Deleting the sources was never on the table.** `toolExecutorMock.ts` has 47 real test-file
importers, `scriptedLlm.ts` has 3, `staticHarness.tsx` has 1 — all real dependencies of the test
suite. `src/test/**` is deliberately inside `tsconfig`'s `include` so fixtures type-check; the fix
had to be packaging-only, not a source or tsconfig change.

**Two candidate mechanisms, one measured to actually work.** A `dist/.npmignore` was ruled out
two ways: npm's own docs (the version actually installed) state a root `.npmignore` doesn't
override an already-set `files` field, and structurally, `tsc` regenerates `dist/` on every build
and copies no non-source files into it, so nothing would persist a hand-placed `.npmignore`
across a rebuild. This wasn't just reasoned through — it was placed and packed, and the file count
didn't move. Negated glob entries directly inside `package.json`'s `files` array were the
mechanism that worked, confirmed the same way: tested via `npm pack --dry-run` before being kept,
not shipped on documented precedence alone.

**A rename was considered and rejected.** 51 import sites total across the three fixtures for a
change scoped as packaging-only, not a test-suite refactor — and the directory-based exclusion
pattern already gets the same "covers every future fixture" property a naming convention would,
without touching a single import.

**Verified beyond the file count.** The packed tarball was installed into an isolated npm prefix;
`zone --version` and `zone --help` both exited 0 with correct output — no
`ERR_MODULE_NOT_FOUND`, the exact failure shape an over-broad exclusion pattern would produce, and
the same check that caught the real `undici` regression before this package's first publish.

**`zone-ai-agent@2.0.0` already shipped with all nine artifacts** — this fix takes effect on the
next publish, not retroactively.

**Where the code lives:** `package.json`'s `files` array. Fixture sources at
`src/test/fixtures/toolExecutorMock.ts`, `src/test/fixtures/scriptedLlm.ts`, and
`src/cli/tui/__fixtures__/staticHarness.tsx` — all three unchanged, still compiling and
type-checking exactly as before.

## 38. Whether shipping 416 sourcemaps is deliberate — the flag is now live; the shipping decision itself is still open

**What it is:** the published tarball carries 416 `.js.map` files — one per compiled `dist/`
module, from `tsconfig.json`'s `sourceMap: true` (present before the publish-prep pass; that
commit added `declaration` alongside it, unchanged). Confirmed two ways — `find dist -name
"*.map"` and `npm pack --dry-run`'s own file list — both agree at 416. They account for roughly
39% of `dist/`'s own unpacked size (2.2 of 5.6 MB, measured directly) — a real, large share.

**What `a35e4e90` changed:** the maps went from generated-but-never-read to genuinely useful on
one of Zone's two top-level error paths. `--enable-source-maps` is now set via the bin shebang —
the only mechanism that worked. `process.setSourceMapsEnabled(true)` was tried first and measured
to fail under Zone's actual ESM module system (it worked in an isolated CommonJS test, which is
why it looked viable before being tested against the real, built entry point). No measurable
startup cost: 612.9ms vs. 611.5ms mean over 20 runs each: an initial 10-run sample had shown a
~53ms gap that didn't hold up under a larger sample.

**The benefit is partial, and that's the part worth being precise about.** `sourcesContent` is
absent from every map, and `src/` isn't in the tarball — so there's no original source text
available anywhere in an installed copy, embedded or on disk. What the flag buys is exactly the
`mappings` field's own contents: a correct `src/**.ts` file and line number, with no code to read
at that location. Enough to file an accurate bug report or look the line up on GitHub; not enough
to inspect the crashing code from the installed package itself. And it only reaches the user on
one of two paths: the TUI (the default, no-args invocation) prints the raw `Error` object on an
uncaught exception, and that's what gets remapped. The headless/`--print`/task-only flow's
`formatErrorMessage` returns only `error.message` — no stack, ever — so the flag changes nothing
there.

**The shipping decision itself is still open, now with the real numbers instead of an unmeasured
guess.** The tradeoff is: **~39% of package size, for file+line accuracy on one of two error
paths, with no source text.** Three ways to close it, not two:
- Keep shipping them as-is (today's state) — the tradeoff above, accepted explicitly.
- Add `--inlineSources` (a `tsconfig.json` compiler option) to embed the actual source text into
  every map, making them fully self-contained and useful on both remapping *and* reading the
  crashing code — at a further, unmeasured size cost on top of the current 39%.
- Exclude them from the tarball via a `files` negation (the mechanism `1a5c5b16` already proved
  works for this exact package), which would make `a35e4e90`'s shebang change pointless — nothing
  left to remap.

`sourceMap: true` itself doesn't need to change under any of the three — local dev keeps full
maps regardless of what the package ships.

**Where the code lives:** `tsconfig.json`'s `sourceMap`/`inlineSources` fields; `package.json`'s
`files` allowlist (no `*.map` exclusion today); the bin shebang in `src/cli/index.ts`, which is
what actually activates the maps that already ship.

## 39. Closed — dompurify and marked removed; only two of the three audited suspects were real

**What it was:** the publish-prep pass's reachability audit found zero `dist/` imports for
`dompurify`, `marked`, `@vitejs/plugin-react`, and `typescript`. Re-checked with the scope widened
past `dist/` to all of `src/` and the root tooling configs: `dompurify`/`marked` were genuinely
unused; `@vitejs/plugin-react`/`typescript` were not. "No import" isn't "unused" for tooling
meant to be *run* rather than imported as a library — `@vitejs/plugin-react` is imported directly
in `vitest.config.ts` (`plugins: [react()]`, needed for the `.tsx` component suite);
`typescript` is invoked as the `tsc` binary by the `build`/`postbuild`/`typecheck`/`check-types`
scripts, never via an ESM `import`. Both stayed; the entry's own original framing (four suspects,
all flagged by the same import-reachability check) was broader than the real finding.

**Where the vendored bundles actually lived, corrected from this entry's original text:**
`src/ui/vendor/marked.min.js` and `src/ui/vendor/dompurify.min.js` — added by `bac83ec6`
("vendor marked+dompurify + self-host IBM Plex fonts"), replacing CDN `<script>` tags with
self-hosted copies. `7df75721` ("delete old browser web UI + remove build coupling"), five days
later, deleted the entire `src/ui/` tree — SPA, fonts, vendor bundles, prototype HTML, and four
test files — along with `scripts/sync-zone-ui.cjs` and the build's `copy-ui` step. The
`devDependencies` entries were never removed in that same commit; that is the actual orphaning
event, not the much later publish-prep audit that merely noticed them. (A `dist/ui/` copy likely
also existed locally, produced by the now-deleted sync script — plausible but unverifiable via
git, since `dist/` has never been tracked.)

**A search-method note worth keeping:** a broad `\bmarked\b` grep across `src/` was noisy — the
common English word "marked" appears throughout comments and test names, unrelated to the npm
package. An import-shaped pattern (`` from ["']marked["'] ``) cut through it cleanly. Cheap to
repeat correctly next time, ambiguous otherwise.

**What shipped (`d8ccecfb`):** both removed from `devDependencies`. `npm install` removed three
packages, not two — `@types/trusted-types` cascaded out as a transitive type-only dependency of
`dompurify`'s Trusted Types API typings, with no other consumer. Verified: full suite green,
`tsc --noEmit` clean, `npm run build` clean, and `npm pack --dry-run` unchanged at 1242 files
before and after — `devDependencies` never ship in the `files`-allowlisted tarball, measured
rather than assumed.

**Where the code lives:** `package.json`'s `devDependencies`. `src/ui/` no longer exists.

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

## 47. Closed — `multi_edit`'s partial-batch escape was a real defect, but neither of its first two framings was

**First framing:** unreverted disk writes needing a rollback. Falsified before this pass closed —
nothing lands on disk from `multi_edit` itself; every successful write goes only into the
in-memory staging map, and the handler has no direct-disk-write fallback the way
`write_file`/`apply_patch` do.

**Second framing (this ledger's own prior correction):** `ctx.filesModified` contamination —
`handleToolResult`'s Step 9 unions a failed call's honest, partial `filesStaged` into
`ctx.filesModified`, and that name could reach a `git add` whose target was never flushed.
**Also falsified, verified independently this pass, not just deferred to:** `finalizeStaging`
flushes regardless of any tool-call's or the run's own `success` — see item 50. Every run
termination path reaches a flush of the entire staging map, gated on verification, not on
success. A file `multi_edit` staged before a since-rejected entry was always going to reach disk
eventually; `git add` was never going to find a missing or stale pathspec from this specific
mechanism.

**What was actually true: batch atomicity, not data loss.** Because the staged files *do*
eventually flush, the old mid-batch escape left a `multi_edit` call that reported `success:false`
having genuinely, durably applied every file before the rejected one — the model was told the
call failed, with a message naming only the offending path, and had no way to know from that
message alone that other files had already changed.

**What shipped (`a8b299f9`):** every entry in `args.files` is validated against the repo boundary
(`checkPathBoundary`) before the first write, so a batch either fully proceeds or touches nothing
at all. The rejection message names the specific offending path — it does not additionally state
that nothing was applied; `success:false` plus an empty `filesStaged` imply it structurally, but
the string itself doesn't say so. `01f243de` closed that gap: all three copies of the message —
the reachable pre-flight check and the two now-unreachable in-loop checks — were reworded
identically to state it explicitly, rather than leaving the two dead ones on stale wording and
repeating the near-identical-site divergence items 18 and 22 document. Both pre-existing in-loop
checks (the one added when
`checkPathBoundary` was first built, and the one inside `stagedWrite` itself) stay as defense in
depth. With pre-flight validating the identical `abs`/`repoPath` before the loop starts, both are
now unreachable through `multi_edit`'s public behavior — no test can exercise them, and none
tries to.

**Where the code lives:** the pre-flight loop and both in-loop checks in `multi_edit`'s handler,
`toolExecutor.ts`. Tests in `toolExecutor.pathBoundary.test.ts` and
`agentLoop.multiEditSaturation.test.ts`.

## 50. `finalizeStaging` flushes regardless of any tool-call's or the run's own `success` — deliberate (Phase F), not evaluated for a narrower gate

**What it is:** `finalizeStaging` (`src/llm/verification/staging.ts`) takes no `success`
parameter. Its flush decision is gated entirely on its own verification run and `verifyMode`
(default `"warn"`, which flushes even a regressed verification — the code's own comment names it
Phase F and states the rationale: keep patches on disk, surface errors as warnings, rather than
discard). Both callers — `persistStagingOnError` (`agentLoop.ts`, 8 call sites across early-exit
termination reasons) and `verifyAndFinalize` (the natural-completion/max-iterations path) — gate
only on staging ownership, not on any tool-call's or the run's own success. Every run-termination
path reaches one or the other.

**This is the fact item 47's corrected understanding rests on:** whatever is staged when a run
ends gets flushed, regardless of what individual tool calls along the way returned. For
`multi_edit`, before this session's fix, that meant a "failed" batch call had still durably
applied everything staged before the rejection point. For `apply_patch`/`write_file` — single-file
tools — the same fact is narrower and mostly already by design: a `restore_failed` state (item 28)
is *meant* to flush its broken content, and a `reverted` state's staged entry already matches
disk, so flushing it is a no-op.

**Not asserted as wrong.** Gating the flush on success would conflict with item 28's own
deliberate `restore_failed` behavior, and reaches into the durable envelope's staged-content
reconciliation on resume (`RunEnvelope.staging`) in ways not traced here. A narrower fix likely
needs the staging map to carry per-entry provenance — which call staged which file, and whether
that call itself succeeded — rather than one global gate; that's a design question, not a
drop-in change, which is why no fix is proposed here.

**Where the code lives:** `finalizeStaging`, `persistStagingOnError` (`agentLoop.ts`),
`verifyAndFinalize` (`verification/composer.ts`). The `verifyMode` parameter's own JSDoc comment
on `finalizeStaging`'s signature names the "Phase F" rationale directly.

## 48. Closed — the shared boundary check gained symlink-awareness; a check-ordering bug had let any no-staging-map write bypass it

**What it is:** this item's task brief described the defect as the boundary check accepting
sibling repositories, via a bare `abs.startsWith(repoPath)` with no separator. That's not what
was broken. `stagedWrite`'s containment comparison already read
`!resolved.startsWith(repoAbs + path.sep)` — separator-safe — at the commit immediately before
this fix (`34531353`); confirmed by reading that revision directly, not assumed. The
sibling-directory case (`/home/bedo/zone` vs `/home/bedo/zone-dogfood`) was already rejected
correctly before this pass. Recording the real defects instead of the one the brief named.

**What was actually broken:** two things, both real. First, the comparison — separator-safe as
it was — never followed symlinks: `path.resolve` is purely lexical, so a symlink inside the repo
pointing outside it passed the check, then the write proceeded through the link to wherever it
actually pointed. Second, `stagedWrite` tested `if (!staging) return false` *before* the repoPath
check, not after — so any call with no staging map (the direct-write fallback path both
`write_file`'s existing-file branch and `apply_patch` use) skipped the boundary check entirely,
regardless of whether the target was inside the repo.

**What shipped (`6802d0c7`):** a shared `checkPathBoundary`, called by every handler right after
it resolves a path. Symlink-safe: walks up from the target using `lstatSync` (not `existsSync`,
which follows symlinks and would treat a dangling one as absent) to the nearest existing
ancestor, then realpaths *that* — correct for both an existing target (realpaths the target
itself) and a new one (realpaths the nearest existing parent, since `realpathSync` throws
`ENOENT` on a path that doesn't exist yet). `repoPath` is realpathed on every call too, not
assumed canonical — `--repo` resolves via `path.resolve` (purely lexical) where bare
`process.cwd()` is kernel-canonicalized, so a symlinked `--repo` value needs the same treatment
or every legitimate write through it would incorrectly reject. `stagedWrite` now runs the
boundary check before the staging-map-presence check, closing the ordering bug.

**Where the code lives:** `checkPathBoundary`/`nearestExistingAncestor` in `toolExecutor.ts`,
called from `stagedWrite` and directly from `read_file`/`list_files`/`apply_patch`/`write_file`/
`multi_edit`'s handlers. Tests in `toolExecutor.pathBoundary.test.ts`.

## 49. Closed — `write_file`'s new-file branch had no boundary check at all

**What it is:** this item's task brief named the defect `write_file`'s "`overwrite: true` path."
There is no `overwrite` argument anywhere in `write_file` — the only similarly-named identifiers
(`allowWriteFileOverwritePaths`, `overwriteOverrideAllowed`) gate the unrelated shrink guard. The
brief's own "confirmed by probe" result was real, though, and this is the actual mechanism: the
new-file branch (`if (!fileExists) { fs.writeFileSync(abs, contentToWrite, "utf8"); }`) never
called `stagedWrite` — not a bypass of a weak check, the check never ran, for any new-file write,
regardless of whether a staging map was present. This was the more serious of the two defects
closed this pass: total absence, not a comparison weakness, and it was invisible to a
traversal-only analysis, because that reads the check's *implementation* and this specific path
had no call to read.

**What shipped (`6802d0c7`):** one `checkPathBoundary` call, placed immediately after `write_file`
resolves its target path — before the scope guard, the edit-approval callback, and the
shrink-guard's own pre-read (which independently leaked existence and size of an outside-repo
path even when the write itself would later be rejected) — so it covers both the new-file and
existing-file branches uniformly, and runs before `fs.mkdirSync`'s unconditional
directory-creation side effect rather than after it.

**Where the code lives:** `write_file`'s handler in `toolExecutor.ts`, immediately after
`path.join(repoPath, filePath)`. Tests in `toolExecutor.pathBoundary.test.ts`.

## 51. `validatePatchCorrectness`'s size/delimiter override half is computed and discarded

**What it is:** the "Minimal safe patch override" block in `validatePatchCorrectness`
(`patchCorrectnessValidator.ts`) has a comment promising two conditions — "very small" and "does
not worsen delimiter counts" — before allowing a `broken_import_line` block through on an
already-broken file. The actual gate, `if (hasBrokenImport && !touchesImport)`, only ever checks
import-region locality. `diffCountsFinal`, `noDelimiterRegression`, and `blockingCodes` are all
computed and never referenced by the conditional — each now carries a `void` statement and a
comment naming this gap, added when item 13 (above) enabled `noUnusedLocals`.

**Present from day one, not later drift — checked with `git log -S`, not assumed.** The block, its
promising comment, and the gate were all added together in the commit that introduced this
function (`1123cecaf`, "ai report flow", 2026-04-25). The test added in the same commit ("does not
block broken_import_line when patch does not touch the import region and is minimal") exercises
only the import-region-untouched condition — despite the word "minimal" in its own title, it never
varies patch size or delimiter counts, so nothing has ever pinned the missing half as either
present or deliberately absent. No comment anywhere marks the gap as intentional.

**`blockingCodes` folds into the same gap, not a separate one.** The `console.log` call two lines
below the gate hardcodes `ignoredBlockingCodes: ["broken_import_line"]` as a literal instead of
deriving it from `blockingCodes` — the same unwired value would also be the correct fix for that
hardcoding, if a second blocking code ever needs the same override.

**Why this isn't fixed here:** wiring the missing half in is a behavior change to what
`apply_patch` accepts, not a tidiness fix — a patch that is downgraded to a warning today (any
`broken_import_line` outside the import region, regardless of size) would revert to blocked
whenever it also fails a newly-enforced size or delimiter check. Whether that's the right outcome
depends on what the check would actually reject against real patch shapes, which hasn't been
measured.

**What would close it:** establish what the size/delimiter check would reject if wired in — the
threshold values aren't specified anywhere, only implied by the comment — measure that against
real patch shapes, then decide, the way item 41's establish measured the existing CRLF precedent
before committing to a direction rather than assuming one.

**Where the code lives:** the override block, its comment, and the gate are in
`validatePatchCorrectness`, `patchCorrectnessValidator.ts`, immediately after the four-layer
`runLayer` sequence.

## 52. Six more computed-and-unused values the item 13 sweep found, each needing its own establish

**What it is:** the same pass that closed item 13 classified 9 lines across 7 stories as
"deferred-signal" rather than dead code — computed values that read like a real, unwired defect
rather than leftover tidiness. One of the 7 is item 51, above. The other 6, each left `void`-marked
with a comment naming the open question rather than fixed, are recorded together here rather than
as separate entries, per the pass's own scope.

- **`runLlmPatchFlow.ts` : `runtimeVerificationToolingFailed`** — computed, never read. A
  `failed_environment_or_tooling` verification outcome is never distinguished from a code failure
  anywhere downstream of where this is computed.
- **`toolExecutor.ts` : `rawStderr`** — captured alongside `rawStdout` inside the inline syntax
  checker, but never read; only `rawStdout` feeds `parseTscErrorPreview`, so a checker that writes
  its error text to stderr instead of stdout has that text silently unused.
- **`agentLoop.ts` : `antiThrashStage1Pattern`** — written at two sites, read at none. Its three
  sibling anti-thrash trackers (`antiThrashStage1Fired`, `antiThrashStage1FiredAtIter`,
  `antiThrashFilesModifiedAtStage1`) are all read; this one isn't compared against anything.
- **`runLlmPatchFlow.ts` : `existingFilesSummary`** — an anti-hallucination prompt block ("use ONLY
  these paths, do not invent new ones") built from the ranked relevant-files list, then never
  injected into any prompt.
- **`runLlmPatchFlow.ts` : `verificationCommand`** (the fix-retry-prompt local specifically — a
  second, differently-scoped local of the same name elsewhere in the file is read and used) —
  resolved immediately before a fix-retry sub-run prompt that tells the model "a verification
  command failed" without ever naming which one.
- **`testEngineerContext.ts` : `framework`** (parameter of `detectConfigFiles`) — every sibling
  call at the same call site (`detectTestFiles`, `detectPageObjects`) branches on `framework`; this
  one checks every recognized framework's config-file pattern unconditionally. Genuinely
  undecided, not just unfixed: ambiguous whether that's deliberate (report any recognized
  test-config file as context) or a bug (should filter to the detected framework's own pattern).

**Why these are bundled as one entry, not six:** each needs its own behavior-change establish
before being touched — the same category `validatedStatus`/`atomicReport` (item 13, above) were
in before this session cleared them — and none has a fix specified yet, so none is individually
actionable today. Bundling avoids six near-identical "needs its own pass" entries that would say
nothing more than this one does per bullet.

**Where the code lives:** named per finding above; all `void`-marked with an `item 13 follow-up:`
comment at the point of computation.

## 53. Detecting a dead export or an unreachable branch needs new tooling — neither is installed

**What it is:** item 13 (above) closed dead-*local* detection by enabling `noUnusedLocals` and
`noUnusedParameters`. That entry's own original problem statement additionally named a dead
*export* and an *unreachable branch* as the same class of risk; neither is caught by those two
flags — TypeScript's unused-locals check doesn't do cross-module export-usage analysis (an
exported symbol might be imported anywhere, so a single file's compilation can't rule that out),
and neither flag does branch-reachability analysis at all.

**Two candidate tools, checked rather than assumed — neither installed:**
- **Dead exports:** `ts-prune` and `knip` are the usual purpose-built tools for this. Checked
  directly: no `node_modules/ts-prune`, no `node_modules/knip`, and neither is named in
  `package.json` or anywhere in `package-lock.json` — zero occurrences of either string.
- **Unreachable branches:** ESLint has reachability-adjacent rules, but ESLint itself is the same
  unusable dependency item 13 already describes. Confirmed live, not just by absence: running
  `npx eslint <path>` against this repo silently fetches ESLint 10.8.0 from the network (no
  prompt), then fails loading `eslint.config.mjs` with `Error [ERR_MODULE_NOT_FOUND]: Cannot find
  package 'typescript-eslint' imported from /.../eslint.config.mjs`, exit code 2 — `typescript-eslint`
  isn't in `package-lock.json` even transitively, so no ESLint rule, reachability or otherwise, can
  run today. This isn't a second gap; it's item 13's own gap blocking a second use case.

**Why this is a decision, not a fix — the same shape as item 36's currency half:** closing either
half means adding new infrastructure (installing and configuring a tool), not flipping a compiler
flag that's already part of the toolchain, the way item 13 was. Which tool, what config, and
whether its false-positive rate is tolerable are real questions a docs-only pass shouldn't answer
unilaterally. Recording the options and the current blocker is the decision, matching item 36's
own precedent: name the candidates, establish why nothing is installed, and stop there rather than
leaving the gap to be silently rediscovered.

**What would close it:** install and configure `ts-prune` or `knip` for the export half; for the
branch half, either resolve item 13's own ESLint-dependency gap first and enable a reachability
rule, or find a narrower `tsc`-native substitute (nothing broad exists today — `tsc` has
per-construct exhaustiveness flags like `noFallthroughCasesInSwitch`, not general unreachable-code
detection). Whichever is picked up first should measure real findings against this repo before
deciding to ship, the way item 36's own currency-check establish did before declining to ship it.

**Where the code lives:** nowhere yet — no tool is selected, no config is written.

## 54. `markerSink.ts`'s own write path cannot call `log` — a standing constraint, not a defect

**What it is:** `appendMarkerRecord` and everything it calls (including `trimSink`) are only
ever invoked from inside the monkey-patched `process.stdout.write`/`process.stderr.write`
installed by `applyStdoutInterception`/`applyStderrInterception` (`stdoutShield.ts`). `log()`
(`logger.ts`) is `console.log(...args)`, and `console.log` writes to `process.stdout` — the
patched one, whenever the TUI is running. Calling `log()` from anywhere inside this module's
write path recurses straight back into `appendMarkerRecord`, without bound.

**Not a defect — the module's own header comment already states this as a constraint:** "this
function and everything it calls must never write to either stream — doing so would re-enter
the patch and recurse without bound. No `log()`, `debugLog()`, `errorLog()`, `console.*`, or
`process.std*.write`, anywhere in this module or its imports." Nothing here is broken; nothing
needs fixing.

**Why it earns an entry despite having nothing to close:** this session's own task brief for
adding a rotation marker instructed emitting it "via `log`" — a specific, concrete instance of
exactly the trap the header warns about, caught only because the implementing pass traced the
call chain before writing the code, not because the instruction was obviously wrong on its face.
The safe alternative — writing the record directly via `fs.appendFileSync`, bypassing
`console.*` and both patched streams — was confirmed safe empirically, not just by reasoning: a
warning line that doesn't start with `[tag]` or a result glyph (✓/✗/⚠) passes through the
patched stderr write untouched, calling `appendMarkerRecord` zero times.

**Where the code lives:** the constraint and its rationale are in the header comment above
`appendMarkerRecord`, `src/utils/markerSink.ts`. `trimSink`'s own rotation-marker write
(`[zone-marker-sink-rotated]`) and its two failure-path warnings (see item 10) are the only
current examples of code respecting it deliberately.

## 55. `normalizationParityTelemetry`'s header comment is now only 2-of-3 accurate

**What it is:** `toolExecutor.normalizationParityTelemetry.test.ts`'s header comment states a
blanket claim: the applier's walk normalizes smart quotes, CRLF, and the read_file pasted
line-number prefix before matching, but `hashPatchBlocks` hashes the raw, unnormalized patch
text — so two patches the applier treats as identical can get different dedup keys. Item 18's
partial closure (smart quotes only) makes this accurate for exactly two of the three classes now,
not all three.

**The marker itself is unaffected — checked, not assumed.** `[zone-apply-patch-normalization-
parity]`'s payload (`blockCount`, `smartQuoteChanged`, `eolChangedBlocks`,
`prefixStrippedBlocks`) measures `segmentApplyPatchBlocks`'s own normalization rate — it never
references `parsePatchBlocks` or `hashPatchBlocks` at all, so it was never a comparison between
the two paths and doesn't go silent now. What shifts is interpretation only: a
`smartQuoteChanged: true` record used to be evidence the dedup-mismatch defect was actively
firing for that patch; now it's just evidence the patch contained curly quotes, with no active
mismatch implied. The payload carries no version field, so pre-fix and post-fix records are
indistinguishable in the sink despite meaning different things. `cd02808c` is the cutoff.

**Checked and found not to apply: items 1 and 4.** Both are "blocked on data," waiting on passive
accumulation of a *different* marker — `[zone-apply-patch-marker-imbalance]` and
`[zone-apply-patch-retry]`'s `marker_imbalance` reason field. Neither references
`[zone-apply-patch-normalization-parity]` anywhere. This marker doesn't feed either item, so no
accumulation cutoff is needed for them — recorded here so the question isn't re-asked.

**Now worse in kind, not degree — confirmed against the actual call chain, not assumed from item
16 alone.** `hashPatchBlocks` calls `parsePatchBlocks`, which now calls the same
`segmentPatchBlocks` that `toolExecutor.ts`'s `segmentApplyPatchBlocks` re-exports: for
segmentation and smart-quote normalization, "the applier's walk" and "hashPatchBlocks" — the two
things this comment's first sentence contrasts — are not two paths that happen to produce the
same output, they are one function called from both. The contrast the sentence is built on has
stopped describing the code, not just become less precise. The prescribed fix below — rescoping
"raw, unnormalized" from three classes to two — treats this as a matter of degree and would not
repair that: CRLF and the read_file prefix genuinely remain applier-only, normalized later at
match time, in a loop `parsePatchBlocks` has no equivalent of and never will — so a claim narrowed
to those two classes would still be substantively true, but the sentence's own shape, a contrast
between two implementations, would go on misdescribing the one class it no longer applies to for
a structural reason, not a narrower one.

**What would close it:** rewrite the header comment to name smart quotes as resolved and scope
the "raw, unnormalized" claim to the two remaining classes only.

**Where the code lives:** the header comment is at the top of
`toolExecutor.normalizationParityTelemetry.test.ts`. The marker's emission site is in
`apply_patch`'s handler, `toolExecutor.ts`, right after the existing smart-quote self-validation
telemetry.

## 56. Closed — all six files fixed; the client-contract finding narrows the full-replace danger from real to latent

**This entry originally understated its own scope: it named one function
(`generateExecutionPlan`) and four remaining files. Both were too narrow — recorded here, not
silently widened.** `generateExecutionPlan` is one of **twelve** `createLLMClient` call sites in
this codebase (`generateFinalRunReport.ts`, `embeddings/embedFile.ts`, `llm/plannerStep.ts`,
`llm/refinePrompt.ts`, `llm/planFeature.ts`, `llm/planPatchPreview.ts`, `llm/taskClassifier.ts`,
`llm/executionPlan.ts`, `llm/planFullPatch.ts`, `roles/runDataAnalystFlow.ts`, `llm/agentLoop.ts`,
`roles/runTestEngineerFlow.ts` — one call site each, confirmed by grep this pass), plus a
structurally separate thirteenth entry point, `createOpenAIClient` in `llm/openaiClient.ts`, a
different function used by a different call chain. A sixth affected file was also missed (below).

**What it is:** `runLlmPatchFlow.ts` calls `generateExecutionPlan` directly from two places, neither
behind any higher-level function most orchestration-level tests already mock. The agent_loop
branch's call site fires whenever no `preGeneratedPlan` is supplied and the ranked relevant-files
list comes back non-empty; it sits inside a single early-return guard clause (`if (_useAgentLoop) {
… return {…}; }`, confirmed this pass by brace-matching rather than assumed from line
proximity — the block has exactly one `return {` at its own nesting level, so when
`_useAgentLoop` is true the function always returns from inside it, and nothing after the block
runs). When `_useAgentLoop` is false, execution falls through that closed block directly into a
shared tail: ranking, embeddings, **`plannerStep`** (`llm/plannerStep.ts`, a second, independent
`createLLMClient` call, gated only on `!skipPlanner && !hasRealHostedContext &&
!explicitTargetRepoFile`), and then the plan_full_patch branch's own `generateExecutionPlan` call,
which has no files-length guard at all — it's gated only on a `pipelineCfg` value that is
structurally `null` for the entire length of that tail, so the guard is vacuously satisfied
whenever no `preGeneratedPlan` is supplied. A test file that forces this tail (`ZONE_FORCE_FLOW=
plan_full_patch`) and mocks only `executionPlan.js` — the shape this entry originally
prescribed — still leaves `plannerStep` constructing a real client on every test that reaches it.

**The suite's exposure to this class is conditional on the environment, not constant — the
central fact missing from the original entry.** A full 454-file suite run this pass (keyless, the
way CI runs it) produced 91 client-construction markers: 82 blocked before construction
(`source=none`, `ApiKeyError` thrown), 9 that construct but never issue a request (`source=env`,
confined to `factory.test.ts`'s own deliberate key-setting tests), and **zero** `source=explicit`
— and zero connection-error, 401, or retry-exhaustion strings anywhere in the run. **As CI runs
this suite today, this entire class makes zero outbound requests.** Two independent routes
actually trigger it, with different severity: an explicit `userApiKey` supplied in a test's own
input is key-independent and fires in CI regardless of the environment — this is exactly why
`readOnlySuppression.test.ts` broke CI, and why the fix below is a real one, not a
hardening-only exercise; `ANTHROPIC_API_KEY` present in the developer's own environment fires the
same class of construction, but only on that machine, never in CI.

**Fixed (`67ef8757`), one of six files:** `runLlmPatchFlow.readOnlySuppression.test.ts` had exactly
one test, of nine, lacking `preGeneratedPlan` — the one that reached the real call, racing a
15-second `testTimeout` against network variance. Fixed via a partial mock (`importOriginal`,
spreading the real module and overriding only `generateExecutionPlan`), not a full replace. That
distinction mattered here specifically: the file's other eight tests all supply `preGeneratedPlan`,
which sets the local plan variable through the *other* branch and never calls `generateExecutionPlan`
at all — but those eight tests do call the module's other runtime export, `isAnswerOnlyPlan`, on
that real, supplied plan. A full-replace mock — the shape used by the nearest same-directory sibling
test — would have left `isAnswerOnlyPlan` undefined and broken all eight. Caught by tracing the
import list and every read site of the resulting local variable before shipping, not by running the
suite and finding out. See the eleventh pattern essay for the general lesson this mistake, caught
before it shipped, is an instance of.

**Five files then still affected, by direct trace of each — not by mock-list inspection alone —
all five now fixed (below):**
- `runLlmPatchFlow.fastPath.test.ts`, `__tests__/dryRun.test.ts`, `__tests__/multiFilePatch.test.ts`
  — each forces the plan_full_patch flow via an env override, supplies `preGeneratedPlan` in none of
  its tests, and none of their task strings are vague-shaped (checked against
  `isVagueDeveloperTask`'s real token logic directly, not assumed from wording) — all three reach
  both `plannerStep` and the plan_full_patch branch's guard-less `generateExecutionPlan` call site
  unconditionally. Empirically confirmed this pass: each produces exactly two client-construction
  markers per reaching test, matching the two-constructor shape above, not one.
- `runLlmPatchFlow.test.ts` — confirmed affected, and now fully scoped rather than left open: 39 of
  its 82 running tests construct a client (73 constructions total, attributed per test name from this
  pass's own suite run), all within the `describe` block whose `beforeEach` sets `ZONE_FORCE_FLOW=
  plan_full_patch`. The file's real total is 89 (82 run, 7 skipped) — an earlier pass through this
  entry counted 65 by grepping source lines starting `it(`, which undercounts a file using
  `it.each`: two such blocks account for the missing 24, corrected here rather than left standing.
  34 of the 39 constructing tests construct twice (`plannerStep` + `generateExecutionPlan`); 5
  construct once, from tests that exit before the second call. Its other three `describe` blocks —
  `preGeneratedPlan forces agent-loop`, `isChitchat`, `vague-task short-circuit` — stay clean by
  construction (a supplied plan, a pure function, and a zero-LLM-call short-circuit respectively).
- `generateFinalRunReport.test.ts` — a sixth file, missed entirely by the original entry because it
  reaches a client through a wholly different chain: `generateAiFinalRunReport`'s own
  `createLLMClient()` call, nothing to do with `generateExecutionPlan` or `plannerStep`. It
  currently **passes** — 11 of 11 — even while a real request is attempted (one construction marker
  per suite run), which is exactly why a pass/fail-based sweep alone would never surface it; only
  the unconditional construction marker did.

**All fixed, same pattern each time (`1e24f954` — the three fastPath/dryRun/multiFilePatch files;
`4f78ebed` — `runLlmPatchFlow.test.ts`; `aeabe1a3` — `generateFinalRunReport.test.ts`):** an
`importOriginal` partial mock of `../llm/factory.js`, overriding only `createLLMClient` to throw,
spreading everything else from the real module so `ApiKeyError`/`ProviderRequestError`/
`PlanRefusalError` stay real, identity-preserved classes rather than `undefined`. Every call site
this class reaches already wraps its `createLLMClient()` call in a try/catch that degrades
gracefully, so the throw needed no assertion changes in any of the four commits.

**A timing anomaly on `fastPath.test.ts`, measured during the session that fixed this file, no
commit records it, and this is its first durable record:** a bounded re-run at a longer timeout
produced two client-construction markers, matching the two-constructor shape traced above, where
the file's default timeout had produced only one — a retry-backoff race against the timeout cutoff,
not a different code path being taken. Closing this open question is what let the "all three
fastPath-shaped files take the same two-constructor path" claim above stand without a caveat.

**The client contract, confirmed at three separate construction sites across two commits, not
assumed to generalize from one:** `4f78ebed`'s own mutation testing (a Proxy trap naming any
property read on the constructed client, rather than a bare stub) found both `generateExecutionPlan`
and `plannerStep` read `.provider` off the client — as a `getModelName(...)` argument — immediately
after construction, before either calls `createChatCompletion`. `aeabe1a3`'s own mutation testing
found the same read a third time, in `generateAiFinalRunReport`'s identical `getModelName(...)`
argument construction. Three of three checked construction sites read `.provider` before anything
else — any returning-stub mock for this client, anywhere in this codebase, needs that field at
minimum.

**The full-replace danger is real, but narrower than this entry's own fix reasoning states it —
essay eleven's lesson a third time.** `1e24f954`'s own mutation testing against `fastPath.test.ts`
specifically found that a full-replace mock (no `importOriginal` spread) passes that file's suite
cleanly rather than throwing a `TypeError` from an `instanceof` check — because that file's own code
paths never reach the one hosted-context `instanceof ApiKeyError` catch site the fix reasoning below
is built around. Preserving the real error classes stays the correct choice regardless of any one
file's own reachability — but the danger this entry cites as justification is, in the one file it
was actually tested against, latent rather than live. Item 56's own text already names two earlier
instances of this same "safe by omission, not by design" shape (`terminationReasonProbe.test.ts`'s
own full-replace mock, safe only because its tests never route through that catch site; and the
general pattern first named while fixing `readOnlySuppression.test.ts`). This is the third.

**Two files confirmed safe, by different mechanisms — recorded so the question isn't re-asked:**
- `runLlmPatchFlow.scanRepo.test.ts` — doubly safe, not by a single mechanism: it sets
  `ZONE_FORCE_FLOW=agent_loop` explicitly (the opposite of the five affected files above, so the
  plan_full_patch tail — `plannerStep` included — is never reached at all) **and** mocks the
  ranked-files helper to return an empty array, which independently starves the agent_loop call
  site's own files-length guard. Either fact alone would keep it off the reachable path; both hold,
  confirmed by direct read this pass.
- `runLlmPatchFlow.fileDiffs.reproY22.test.ts` — already mocks `../llm/executionPlan.js`,
  full-replace shape, the same shape this fix considered and rejected for the file above. Safe today
  only because this file never supplies `preGeneratedPlan` in any of its own tests, so the
  `isAnswerOnlyPlan`-undefined risk this session's fix found never gets triggered here — the same
  latent fragility, not yet a live defect, dormant on one specific fact about this file's current
  tests rather than absent by design.

**What this session's own timing measurements show, with only numbers that have a surviving
record.** Pre-fix (the real call reached, the client-construction marker present): 1597ms on a
whole-file run, 3373ms on an isolated single-test run. Post-fix (mocked, marker absent): 2006-2526ms
across five isolated runs. The post-fix range sits *inside* the pre-fix range, not below it — timing
failed to discriminate directionally between the two configurations, not merely inconclusively. What
discriminated cleanly and consistently, every time: the stdout marker printed at real client
construction, present in every run that reached one and absent in every run that didn't. An earlier
diagnostic pass in this same investigation reported a different duration spread and read it as a
network-latency signature; that figure has no surviving verbatim record in this session and is not
carried forward here. A separate, unexplained per-test cost common to this file regardless of which
code path a given test takes is recorded on its own footing as item 58 — it is not resolved by this
fix.

**`runLlmPatchFlow.test.ts`'s own before/after, on the same footing — measured during the session
that fixed this file, no commit records it, and this is its first durable record:** a keyed baseline
bounded at 300 seconds did not complete naturally (`EXIT=124`), with 38 of the file's 73 expected
markers observed before the bound was hit; the post-fix keyed run completed in 4.08 seconds, 0
markers, all 82 running tests passing.

**What closed the rest — corrected from the original prescription before it was applied.** The
original entry's own fix (mock `../llm/executionPlan.js`) would have been insufficient for all five
remaining files: it would have left `plannerStep` constructing a real client in every one of them,
since that constructor doesn't live in the module being mocked. The corrected fix, landed in all
three later commits, mocks `../llm/factory.js` instead — one choke point covering all twelve
`createLLMClient` call sites (`plannerStep` included, and any future thirteenth site added later) —
using the same `importOriginal` partial-mock pattern as the first, already-shipped fix, **not** the
full-replace shape `runLlmPatchFlow.terminationReasonProbe.test.ts` happens to use for the same
module. That distinction was load-bearing here specifically:
`factory.js` exports `createLLMClient` alongside three error classes (`ApiKeyError`,
`ProviderRequestError`, `PlanRefusalError`); `runLlmPatchFlow.ts` itself does `if (err instanceof
ApiKeyError)` in a hosted-context catch block, and `executionPlan.ts` directly constructs `new
PlanRefusalError(...)`. A full-replace mock leaves those symbols `undefined`, and `instanceof
undefined` throws `TypeError` rather than failing the test cleanly — trading one defect for a
worse one in exactly the case the fix exists to prevent. `terminationReasonProbe.test.ts`'s own
full-replace mock is safe only because none of its tests route through that specific catch block —
the same "safe by omission, not by design" shape the eleventh pattern essay already names, caught a
second time, one level up the stack, in this pass's own establish work before it reached this
entry. **Verified empirically, not just reasoned:** a throwaway probe this pass mocked
`factory.js` via the `importOriginal` partial pattern, then called the real, unmocked
`generateExecutionPlan` under conditions that make it throw a real `PlanRefusalError`, and
confirmed the caught error passed `instanceof PlanRefusalError` against a separately-imported
reference to the same (mocked-path) module — true class identity survives the spread, because
every importer in a test's module graph resolves to the same cached mock object.

A vitest setup-level network guard would close this class going forward as a side effect, for
every file, not just these five — see item 59, not item 57 (item 57 is now scoped to the OpenAI
timeout value alone and no longer concerns a test-side guard).

**Where the code lives:** the two `generateExecutionPlan` call sites and the `plannerStep` call are
all in `runLlmPatchFlow.ts` — the agent_loop branch's `generateExecutionPlan`, guarded by the
ranked-files length check; and, in the shared plan_full_patch tail reached only when that branch's
own early return doesn't fire, `plannerStep` and the second `generateExecutionPlan` call, the
latter guarded only by the always-null `pipelineCfg`. `generateAiFinalRunReport`'s own
`createLLMClient()` call is in `generateFinalRunReport.ts`, an unrelated chain. The landed fix is
each affected test file's own `../llm/factory.js` mock: `runLlmPatchFlow.readOnlySuppression.test.ts`
(`67ef8757`); `runLlmPatchFlow.fastPath.test.ts`, `__tests__/dryRun.test.ts`,
`__tests__/multiFilePatch.test.ts` (`1e24f954`); `runLlmPatchFlow.test.ts` (`4f78ebed`);
`generateFinalRunReport.test.ts` (`aeabe1a3`).

## 57. No explicit timeout on the OpenAI SDK clients — a real reliability gap, found while investigating item 56 — corrected

**This entry originally claimed neither the Anthropic nor the OpenAI client sets an explicit
timeout. The Anthropic half is false and is corrected below, not softened.** The original text
said "neither the Anthropic nor the OpenAI client construction in `factory.ts` sets an explicit
`timeout` option" and that a hung connection "currently waits up to [ten minutes] with no bound
from any of Zone's own code." Both claims were checked by grepping `factory.ts` for the string
`timeout` and finding nothing — but `factory.ts` doesn't construct an SDK client at all; it
constructs Zone's own `OpenAIAdapter`/`AnthropicAdapter` classes, wrapped in a
`RecordingLLMClient`. The real SDK constructions are one layer down.

**What's actually true for Anthropic, read directly from `anthropicAdapter.ts` this pass:** the
constructor passes `timeout: MIN_REQUEST_TIMEOUT_MS` (600,000ms / 10 min — a floor, per the
file's own comment, not the operative value), `maxRetries: 0`, and a `fetchOptions.dispatcher`
pointing at a dedicated `undici.Agent`. Every actual request additionally derives a **per-request**
timeout from its own output budget, via `deriveRequestTimeoutMs(max_tokens)` at three separate call
sites, clamped between that same 600,000ms floor and a 3,600,000ms (60 min) ceiling. The dedicated
`undici.Agent` sets `headersTimeout`/`bodyTimeout` to 3,900,000ms (65 min) — deliberately five
minutes above the 60-minute SDK ceiling, so the SDK's own `AbortController` is always the first
thing to fire, never the transport underneath it. This is a carefully reasoned piece of the
codebase, not an oversight — the opposite of what the original entry claimed.

**The mechanism that let the error survive review, worth naming so it isn't repeated:** the file
grepped (`factory.ts`) doesn't implement the behavior being asked about — the absence of a string
in the wrong file was read as evidence of absence of the behavior in the system. Compounding it:
the asserted default (the Anthropic SDK's own documented ten minutes) happened to equal the real
configured `MIN_REQUEST_TIMEOUT_MS` value exactly, so the number "matched" and read as
confirmation rather than triggering a second check. See the thirteenth pattern essay for the
general lesson.

**Surviving claim, narrowed to OpenAI only — two sites, neither with any timeout of either
kind.** `src/llm/openaiAdapter.ts` (`new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0 })`; a
fresh grep for `timeout` anywhere in that file returns nothing — no constructor option, no
per-request derivation) and `src/llm/openaiClient.ts` (`new OpenAI({ apiKey })`, same gap; its
`createOpenAIClient` is used via `runLlmPatchFlow.ts`'s hosted-inference-mode path, a separate
entry point from `createLLMClient`). Both rely on the OpenAI SDK's own ten-minute default with no
Zone-side override at either the constructor or the per-request level.

**Why this is its own entry, not folded into item 56.** Unchanged from the original reasoning:
item 56 is a test-suite defect, closable by test-side mocking with zero production code touched;
this entry describes something real independent of any test, surfaced incidentally while
investigating item 56 rather than from an independent design review — the same shape item 43
already has in this document. Complementary to item 56's own fix, not an alternative to it.

**What would close it:** pick and set an explicit timeout value on both OpenAI construction
sites. Not attempted here, unchanged from the original reasoning — a docs-only pass isn't where a
production-facing timeout value should get chosen unilaterally; the value itself needs its own
establish (a real request's worst-case legitimate duration, at whatever context size and tier
this codebase's own largest real calls can reach).

**Bucket, re-decided against the definition, not inherited from the pre-correction entry:**
"Actionable now" requires a fix specified in the entry itself with nothing new to learn first. The
original entry already deferred the one open question (the numeric timeout value) while treating
the *kind* of fix — add an explicit `timeout` option — as fully specified; narrowing the claim to
OpenAI's two sites doesn't add anything that needs to be learned first beyond what was already
deferred, and the surviving scope is smaller, not less specified. **Stays Actionable now.**

**Where the code lives:** the two unbound constructions are in `src/llm/openaiAdapter.ts` and
`src/llm/openaiClient.ts`. Anthropic's timeout configuration — constructor floor, three
per-request derivation sites, and the dispatcher — is in `src/llm/anthropicAdapter.ts`.

## 58. A roughly 2-2.5 second per-test floor in this file has no established cause

**What it is:** every test in `runLlmPatchFlow.readOnlySuppression.test.ts` takes roughly 2-2.5
seconds, including the tests that never reach `generateExecutionPlan` at all — mocked or not, before
or after item 56's fix. Measured directly, with surviving records on both sides: a test that
supplies `preGeneratedPlan` and never calls `generateExecutionPlan` measured 2442ms and 2712ms
across two separate whole-file runs; the one test that does call it measured 1597ms and 3373ms
pre-fix, 2006-2526ms post-fix. All four figures sit in the same rough band, regardless of which code
path actually fired. This is exactly what made item 56 hard to diagnose by timing alone — a genuine
outbound network call and a fully mocked run cost about the same wall-clock time in this file, for a
reason unrelated to either one.

**Retracted, not repeated:** an earlier report in this same investigation attributed this floor to
`detectFramework`'s unmocked filesystem work — a reasonable first guess, since it's one of the few
calls in this code path the file's own mock list doesn't cover. Checked directly this pass by
reading `detectFramework` and the helper it delegates to: both are synchronous
`fs.existsSync`/`path.join` checks against a fixed list of config filenames, with no plausible cost
at this scale whether the target path exists or not. The attribution does not survive that read and
is retracted here specifically so a future pass that re-derives "`detectFramework` does filesystem
work" and stops there knows this was already checked and found wanting.

**Why this is worth its own entry, not a footnote on item 56's timing section.** CI already runs
measurably slower than local — the entire reason a 15-second `testTimeout` was tight enough to fire
on ordinary variance in the first place (item 56). An unexplained ~2-2.5-second floor, present in
every test of a file regardless of what that specific test exercises, is a plausible non-trivial
share of total suite wall-clock once multiplied across however many other files carry the same
unidentified cost — a real, if unquantified, question independent of item 56, which will eventually
close while this stays open.

**What would close it:** identify the actual source — profiling this file's own
`beforeEach`/`runWith` setup, or a bisection across its dynamic import of the module under test,
would locate it. Not attempted here.

**Where the code lives:** `runLlmPatchFlow.readOnlySuppression.test.ts`'s own `beforeEach` and
`runWith` helper; `detectFramework`/its helper (`src/repo/detectFramework.ts`), checked directly and
ruled out as the cause this pass.

## 59. Whether the suite reaches a real LLM client is conditional on the developer's own environment, and CI cannot see the difference

**What it is:** this suite's LLM-reaching tests do not behave the same way twice — they behave
differently depending on whether `ANTHROPIC_API_KEY` happens to be exported in the shell that
runs them. CI never has one set, so item 56's whole defect class is invisible to CI except through
the one, narrower route that doesn't depend on it (an explicit `userApiKey` supplied directly in a
test's own input, which is what actually broke CI in `readOnlySuppression.test.ts`). A developer
running the same suite with a key exported runs a materially different suite: slower — measured
this pass at up to 30.70s for one file (`multiFilePatch.test.ts`) that completes in a fraction of a
second keyless — network-dependent, and capable of spending real money against a live provider by
accident, on tests that were never meant to leave the process.

**The real numbers, from this pass's own full 454-file run, keyless (the way CI runs it):** 91
client-construction markers total; 82 blocked before construction (`ApiKeyError` thrown); 9 that
construct without issuing a request, confined to one file's own deliberate key-setting tests; zero
that reach a request; zero connection-error, 401, or retry-exhaustion strings anywhere in the run.
Re-run with a key present and a dead local base URL (no real network traffic, just an instant local
refusal standing in for a hang), the five files item 56 names reproduce the exact failure signature
that started this investigation — `Test timed out in 15000ms` — deterministically, offline.

**Found while investigating item 56, not from an independent review** — the same circumstance
item 43 already has in this document for a different fact. It is the root cause behind both item
56's class and the original CI timeout that started this whole investigation: not that a mock was
missing in one file, but that this suite's own outcome depends on an environment variable nobody
declared as part of its contract.

**What would close it — a real, unresolved fork, not a design ready to build.** A vitest
setup-level network guard would close this and item 56's class together as a side effect. Two
things were actually checked this pass, empirically, rather than left as an unexamined sketch:
- `expect.getState().currentTestName` stays correctly populated across three nested async layers
  plus a real `setTimeout` macrotask, and updates correctly between tests — confirmed by a
  throwaway probe, not assumed from the type declaration alone. A guard's failure message can
  name the test it fired in, wherever it's installed.
- The interception point itself cannot yet be called settled. Two structurally different designs
  are both live candidates and neither has been compared against the other: intercepting
  `globalThis.fetch` (reachable — neither installed SDK version bundles its own transport, both
  resolve `fetch` dynamically, confirmed by reading the installed packages), or intercepting at
  `createLLMClient`/`createOpenAIClient` themselves, throwing directly when a construction reaches
  them unmocked under a test runner. The second option is arguably the better fit for this
  specific defect — directly attributable to the constructing function with no stack-parsing
  needed, and immune by construction to any interaction with the one test in this suite that
  already stubs `fetch` itself (`fetchUrl.test.ts`) or the one that runs a real local server over
  `node:http`/`ws`, not fetch (`controlServer.test.ts`) — but this establish pass only ever
  examined the fetch-level option and never named the alternative, let alone chose between them.
  That is a genuine fork in approach, not a missing parameter on an otherwise-settled design.

**Bucket, checked against comparable entries, not the one-line definition alone.** Items 46 and 51
are the closest existing shape: both record a real, structural finding whose own next step is
"decide between two approaches" (46) or "measure, then decide" (51), and both sit in **Neither** —
not because no fix was proposed, but because the *approach itself* is still open, which is a
different and more fundamental gap than item 57's (an approach fully specified, one parameter
value deferred). The interception-point fork above is exactly that shape. **Bucketed Neither.**
Secondary, non-blocking note for whenever this is picked up: build it after the five files in item
56 are fixed, so it starts silent rather than immediately red.

**Where the code lives:** the twelve `createLLMClient` call sites and the separate
`createOpenAIClient` are listed in item 56. `fetchUrl.test.ts` and `controlServer.test.ts` are the
two existing tests any interception-point decision needs to stay compatible with.

## 60. `generateFinalRunReport` computes a nine-field report at a dozen call sites that nothing reads

**What it is:** `generateFinalRunReport` produces a `FinalRunReport` — `title`, `statusSummary`,
`intentUnderstood`, `filesInspected`, `filesChanged`, `changesMade`, `verificationSummary`,
`safetySummary`, `nextStep` — computed at a dozen call sites inside `runLlmPatchFlow.ts`. An AI-
generated variant exists behind `generateAiFinalRunReport`, gated on `ZONE_AI_FINAL_REPORT`, a flag
set nowhere in this repository — no config, no default, no test fixture outside the module's own
tests. Established directly, not assumed: `.finalRunReport` is read in exactly three places in the
whole codebase, and all three are test assertions, not a renderer, a serializer, or a persistence
layer. The TUI's own final message is built from the agent loop's own summary text, a completely
separate mechanism; the CLI's result printer reads only `decisionMode`/`warnings`/`reason`; the
field is absent from both the on-disk run envelope and the on-disk session transcript. The module's
own 14 tests assert only on its own output shape — nothing external depends on any of them passing.

**The sharp part — not a criticism of item 13, which is already Closed and did exactly what it
said.** Item 13's own fix propagated an already-computed `finalRunReport` value into one more
return site specifically because ten sibling return sites already populated the same field. That
reasoning was sound on its own terms: consistency across return sites is a real property to want.
What makes this worth its own entry is what the consistency was achieved in service of — all eleven
sites now write a field nothing downstream ever reads. The fix was correct; the field it was
correct about is scaffolding for a consumer that was never built.

**What would close it:** a decision between wiring the module up to an actual consumer or deleting
it — not a small fix either way. Deleting is straightforward. Wiring it up is not yet a specified
fix at all: it would first need a decision about what the report is *for* — a CLI flag, a TUI
panel, a persisted artifact — before any code change could be scoped. Neither option chosen here.

**Bucket, against the document's own usage, not the one-line definition alone.** Item 58 is the
matching shape: a real, verified structural fact, a "what would close it" that names an action
without executing it, explicitly left undecided. Both sit in **Neither** — "a structural fact
recorded, with no fix proposed" — rather than Actionable now, because neither entry specifies a
single fix with nothing left to learn; item 58's own next step is unstarted profiling, and this
entry's "wire it up" option isn't a fix until something else decides its purpose first.
**Bucketed Neither.**

**Where the code lives:** `generateFinalRunReport`/`buildDeterministicFinalRunReport`/
`generateAiFinalRunReport` are all in `generateFinalRunReport.ts`. Its dozen call sites are in
`runLlmPatchFlow.ts`, each assigning into a `finalRunReport` field on a return object. The three
`.finalRunReport` reads are in `runLlmPatchFlow.test.ts` and `__tests__/multiFilePatch.test.ts`,
both test assertions.

## 61. The free-form summary arc: four commits, and what they left open

**Sequence, each step verified against its own commit:** the imposed four/five-section format that
prompted this arc lived in the agent loop's own `FINAL SUMMARY` templates, not in
`generateFinalRunReport` (item 60) — a separate, unrelated mechanism, confirmed by tracing what the
TUI actually renders. `ANSWER_SUMMARY`, a genuinely free-form contract, already existed for
answer-only plans but was selected only when a plan was formally shaped that way. The selector was
extended to cover read-only archetypes directly (`dd8fb604`). A divergence between the old
`## Tests` heading's enum and `parseVerificationTag`'s accepted values — one value the parser never
accepted — was found and fixed (`06ab8874`). Telemetry recording whether a verdict came from a tag
or a fallback was added to `deriveVerdict` (`e7b051eb`). The two remaining patch-shaped templates
were then collapsed into one free-form builder taking a token-range/char-cap pair, carrying one
condensed worked example forward from the three the old templates carried (`27c5a8eb`).

**What remains open, each in its own real shape — this entry does not reduce to one fix:**
- The FINAL ASSESSMENT block that requests the `[ZONE_VERIFICATION]` tag is still gated on
  `answerOnly` alone, unchanged through all four commits. A read-only-archetype run with no plan —
  exactly the case `dd8fb604` extended the summary selector to cover — still receives a demand for
  a verification tag with nothing to verify. A specified fix exists (extend the same gate condition
  the summary selector already uses) and was explicitly deferred each time it was noticed, not
  built. A second surface, still open.
- `deriveVerdict`'s `inferredFrom` field is `"tag"` or `"heuristic"`, a function of whether a tag
  was present, not of why one wasn't. `"heuristic"` covers two different mechanisms: a real
  inference run against the tool-call log (`trigger === "max_iterations"`), and a hardcoded default
  reached with no inference attempted at all (any other trigger). The telemetry's own `reason`
  field distinguishes the two in each recorded payload; a raw count of `inferredFrom` values alone
  would not.
- The `inferredFrom` telemetry accumulates passively, by design — nothing in this arc reads it back
  or builds a baseline from it. No real-world tag-emission rate exists yet to compare against.
- The new patch template's "lead with a single line that would work as a commit subject"
  instruction is confirmed unpinned by any test, not merely un-added: a repo-wide sweep during the
  commit that introduced it found zero references to the phrase anywhere in the test suite, and
  removing the sentence as a mutation failed nothing. A model-behavior property no unit test can
  verify — recorded as a known gap rather than closed with a test that couldn't have measured it.
- What the collapse gave up, stated plainly rather than left implicit: cross-run skimmability (every
  patch summary no longer lands in the same shape, so scanning several in sequence costs more than
  it used to), and two of the old templates' three worked examples — a happy-path structural
  demonstration and an explicit incomplete-work hand-off demonstration, both judged reasonably
  covered by the new template's own REQUIRED-bullet prose instead. The third example (a patch rolled
  back with nothing net-applied) was carried forward condensed, in free-form prose rather than its
  old bulleted shape, because nothing else in the prompt taught that specific case.

**Bucket, against the document's own usage.** Item 58 is again the closest shape: several of these
sub-facts individually resemble other buckets in isolation (the FINAL ASSESSMENT gate has a
specified fix, unbuilt — closer to Actionable now on its own; the missing baseline is closer to
Blocked on data on its own) but the entry as a whole specifies no single fix with nothing left to
learn, which is what the bucket decision is actually about. **Bucketed Neither**, each sub-fact's
real shape kept visible in its own bullet rather than flattened to match the label.

**Where the code lives:** `assembleAgentSystemPrompt`'s summary selector and `buildPatchSummary`
are in `agentLoop.ts`, immediately followed by the still-`answerOnly`-only FINAL ASSESSMENT block.
`inferredFrom` is computed and now logged in `deriveVerdict.ts`. The four commits'
own test changes are in `agentLoop.prompts.test.ts`, `agentLoop.brevity.test.ts`, and
`deriveVerdict.test.ts`.

## Status snapshot — a partition, not a priority ordering

A snapshot, current as of this commit — it goes stale the moment any item closes or is
reclassified; the numbered entries above are the source of truth, and this section only saves a
reader the trouble of reading all 61 to find out which ones still need something. No index of
this kind existed before this pass — the intro's own "not a changelog, not a roadmap, not a
priority ordering" cautions against ranking by importance, which this section doesn't do: it
groups by mechanical status only, items listed by number within each group, not by what to do
first.

**Closed** (31): 6, 7, 8, 10, 13, 14, 16, 20, 21, 22, 24, 25, 26, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 40, 41, 42, 44, 47, 48, 49, 56

**Actionable now** — a fix is specified in the entry itself; nothing new needs to be learned
first (9): 2, 12, 15 (after 2), 17, 18, 23, 36, 55, 57

**Blocked on data** — closing requires an observation that doesn't exist yet (2): 1, 4

**Neither — a structural fact recorded, with no fix proposed** (19): 3, 5, 9, 11, 19, 27, 38, 43,
45, 46, 50, 51, 52, 53, 54, 58, 59, 60, 61

Items 1, 2, 12, 18, 36, and 57 are partially closed or corrected; the classification above
covers only the portion still open, not the whole entry.

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

## A tenth pattern, beside the eighth: shared extraction makes symmetric mutations invisible to comparison assertions

From the pass that converged `parsePatchBlocks` onto the shared `normalizeSmartQuotes` (item 18):
extracting a helper into a shared module means every call site now runs the exact same code, so a
mutation to the helper itself moves every call site together, not just one. An assertion that
compares two call sites against each other is structurally blind to that class of mutation — both
sides still agree, because both sides changed identically. Only an assertion against something
outside the shared function, unreached by the mutation through either call site, catches it.

The distinction is the mutation's *shape*, not its severity. A **symmetric** mutation — a change
inside the shared function itself, reached by every caller identically — is invisible to a
call-site-vs-call-site comparison and visible only to an external-invariant check. An
**asymmetric** mutation — a change confined to one caller's own use of the shared function, so one
side stops calling it or calls it differently from the other — is the reverse: it breaks the
call-site comparison directly, since the two sides no longer agree with each other, independent
of whether an external-invariant check would also catch it.

The generalizable rule: a convergence test written after a shared extraction needs both kinds of
assertion, because neither alone covers both mutation classes. Designing which assertion a given
mutation *should* fire is part of the mutation-testing plan, not a read-off-the-result afterthought
— and a mutation firing on fewer assertions than a different mutation in the same test is not
automatically a coverage gap. It can be the correct, predicted outcome for that mutation's shape,
and the prediction is what should be checked, not skipped past.

Also worth recording: a third mutation in that same pass reordered two operations predicted,
before running, to be commutative on disjoint inputs — reordering a character-class substitution
against a boundary-only trim that never touches the same characters. It was run anyway rather than
skipped on the strength of the prediction. Predicting a null result does not excuse skipping the
run; the prediction is only trustworthy once it has been checked against something that actually
executed.

## An eleventh pattern, beside the second: a precedent's applicability lives in what makes it safe, not in what makes it similar

Reusing a nearby precedent because it shares a directory, a module, or an idiom is choosing on the
wrong axis. What makes a precedent safe to reuse is the condition that made it safe where it
already lives — and that condition can be completely invisible from the outside, present only in
what the precedent's own test cases happen never to exercise.

This showed up directly in the pass that fixed item 56. A same-directory sibling test already
mocked the same module with a full-replace shape — override the one function that mattered, supply
nothing else for the rest of the module. Reusing that shape looked like the obvious choice: same
directory, same module, same problem. It was wrong, because the sibling's safety depended on a fact
that had nothing to do with the module or the directory: none of its own tests ever supplied a
value that would route execution through the module's other export. The file being fixed did — most
of its own tests did, in fact — and a full-replace mock would have silently deleted that second
export for every one of them.

The dominant pattern elsewhere in the same codebase, used by far more call sites than the nearby
sibling, turned out to be the correct one to follow instead — not because it had more instances for
its own sake, but because more instances meant more of the tree had already been forced to confront
the condition the nearby-but-rarer sibling's own test shapes happened to avoid.

**The rule:** before reusing a precedent, name the specific condition that makes it safe where it
already sits, then check whether that condition holds at the new site. Surface similarity — same
directory, same idiom, same module — is not that condition and should not be treated as a proxy for
it. When several precedents disagree, the one satisfied by the most call sites has usually already
been tested against the case a nearer-but-rarer one never had to face.

## A twelfth pattern: one push, N commits, one signal

CI's diagnostic value comes from having one result per change small enough to read. A single `git
push` that carries many commits does not multiply that value by the commit count — GitHub Actions
triggers once per push event, against the head commit of that push, not once per commit inside it.
Every intermediate commit in a multi-commit push runs invisibly: it exists in history, but no
workflow run ever checks it out on its own.

This repo's own history has a direct example. One push earlier in this session carried 29 commits,
spanning several unrelated fixes and documentation changes, in one operation. Exactly one workflow
run exists for that push, checked out at its head commit (`0599cd7d`) — and it failed. Which of the
29 commits, if any, caused that failure is not answerable from the run itself; the signal covers
all 29 or none of them, never a subset.

This is not a workflow-configuration gap — the trigger (`on: push` to the watched branch) fires
correctly on every push, direct-to-branch or otherwise. It is a consequence of what "once per push"
means when a push is large: the granularity of the signal is the granularity of the push, not the
granularity of the commit.

**The corrective:** push at the granularity worth being able to attribute. A commit meant to stand
as its own verifiable unit of work should reach CI on its own, before the next one lands on top of
it.

## A thirteenth pattern: absence of a string is not absence of a behavior, and a matching number is not a confirmation

Checking whether a system does something by grepping a file for a keyword only tells you about
that file. It says nothing about a behavior implemented one layer away, in a module whose name
doesn't happen to match the concept being searched for. A claim about what a system does needs the
file that actually does it — found by tracing the call, not by guessing which filename sounds
right and grepping that one.

The sharper half is what makes this failure mode survive review instead of getting caught
immediately: when a number asserted from a known default happens to equal the number actually
found in the code, that agreement reads as confirmation. It should read as a reason to check
harder. Two independent facts landing on the same digit is far more often one fact being read
twice under two different names than it is two facts that were each verified on their own.

This session produced a concrete instance of both halves at once. A claim that neither of two SDK
clients set an explicit timeout was checked by grepping a file that constructs adapter classes, not
SDK clients — the real constructions live one file away. And the claim's own asserted default,
the Anthropic SDK's documented ten minutes, was numerically identical to the value the codebase had
actually configured for an unrelated reason (a floor beneath a per-request derivation, not a bare
default left untouched). The grep found nothing because it was reading the wrong file; the number
matched because one real ten-minute value was being compared against a restatement of itself, not
against something independently checked.

## A fourteenth pattern: a test that derives its own scope can silently narrow it, and forbidding a string does not remove that string from the text

A test that locates its own target text at runtime — searching for a marker, then reading whatever
follows it — inherits a failure mode a hardcoded slice never has. When the marker is gone, the
search does not raise an error; it returns nothing found, and everything built on top of that keeps
running anyway. An index-of-substring lookup that fails returns negative one; a slice built from
that value is some other, arbitrary piece of the text; a length check against that arbitrary piece
can still pass, for a reason that has nothing to do with what the test claims to verify. The test
reports green while testing nothing. The corrective has two parts, and neither is optional on its
own: assert that the marker was actually found before asserting anything about what follows it, and
pin an expected count as a literal written into the test, not derived from the same text being
checked — a shrunken match should fail loudly, not silently satisfy a looser one.

The second half is a different trap with the same underlying shape: text that forbids a string
still contains that string. A FORBIDDEN list naming a heading as the thing not to write is itself
text containing the literal characters of that heading — asserting that a whole block of text lacks
the substring fails the moment any part of it legitimately mentions the phrase, including the exact
sentence telling the model not to write it, or an entirely unrelated block elsewhere in the same
static prompt using the same words for its own, unconnected reason. The fix is not a cleverer
string match; it is scoping the assertion to only the block actually under test.

This recurred three times within one session, working through the same handful of prompt-template
test files, git-verified rather than recalled. The arity guard added to the old `## Tests` enum
test was built with the first half already stated in its own comment, before it was ever needed.
The second half then landed twice, live, each caught before the commit that introduced it shipped:
once when a new answer-contract test asserted a whole prompt lacked `"## What changed"`, failing
against that exact phrase sitting inside a sibling template's own FORBIDDEN list; again later in
the same arc, when a rewritten summary test asserted a whole prompt lacked `"## Tests"`, failing
against an unrelated, untouched brevity directive naming that same heading for a different reason
entirely. Three instances, two different files, the same failure shape each time — which is what
makes it a pattern here rather than a pair of unrelated bugs.
