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

**Still open — but not for the reason this paragraph used to give.** Line-anchoring the parser's
own segmentation does not close this — measured, not assumed. Item 2's canonical trigger (a
matched, own-line FIND/REPLACE pair embedded in REPLACE content) produces byte-identical output
under the current substring-based walk and under a line-anchored variant, checked two ways: a
strict own-line rule, and the repo's own existing anchoring tolerance (the line-anchored recount
below). The clearest evidence is in the suite itself: the characterization test named for this
exact defect — *"item 2's known misparse: an embedded matched FIND/REPLACE pair…"*, present in
both `toolExecutor.patchBlocksCharacterization.test.ts` and
`agentLoop.patchBlocksCharacterization.test.ts` — keeps passing, unchanged, under either anchored
variant. A test indifferent to a proposed fix is the fix missing its target.

**The real diagnosis: format ambiguity, not a parsing defect.** The trigger input is textually
identical to a legitimate two-block patch — nothing distinguishes an own-line matched
FIND/REPLACE pair that is a genuine second edit from one that is example text sitting inside a
REPLACE block. The protocol has no escape sequence, no fence, and no block-count declaration, and
`apply_patch`'s own tool description never requires markers to be alone on a line. No change
confined to the parser — anchored or not — can distinguish two readings that are the same text.

**Where this actually closes:** item 17's structured `blocks: [{find, replace}]` argument
sidesteps the ambiguity rather than trying to resolve it, since a JSON argument has no delimited
text for a walk to mis-split in the first place — see item 17 directly for its own scope. That is
the surviving option from this entry's old "what would close it"; line-anchoring is not.

**The item-1 reference above was imprecise, corrected here rather than silently.** Item 1
line-anchored a *recount* — `findMarkerCountLineAnchored`/`replaceMarkerCountLineAnchored` — that
feeds only the `[zone-apply-patch-marker-imbalance]` telemetry payload. The rejection decision
itself still runs on raw substring counts. No behavior anywhere in this codebase is line-anchored
today; "the counter, which item 1 already did" overstated what landed.

What line-anchoring the walk *would* still be worth doing for, on its own separate merits having
nothing to do with closing this entry, is recorded on its own as item 62.

The bucket this entry moves to next reflects that no fix is specified, not that the defect is
minor, and of everything currently in Neither this is the only entry describing a silent,
incorrect write to a user's files.

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

**What would close it:** roughly 10-20 real records. Re-derived against the sink directly:
**3 occurrences, falling in 2 distinct runs, out of 50 runs recorded**
(`[zone-apply-patch-retry]`'s `reason: "marker_imbalance"` records, already on `log()`
throughout). Deduplication does not touch this figure — the three records are three separate
iterations, and the count is identical raw or collapsed (item 73). Still **n=3: an
order-of-magnitude estimate only, not a measurement with a defensible confidence interval.** The
projection it supports — very roughly 170-330 further runs at the observed occurrence rate — is a
sense of scale, not planning input; three events don't support a rate precise enough to schedule
against, and could be off by a large multiple in either direction.

**The rate this entry used to state, 4.4%, failed in a different way from every other sink figure
corrected across this document, and which way matters to anyone re-checking them.** The others
were right for the wrong key — a raw count where a deduplicated one was meant. This one was never
a key problem: 3 over 45 is 6.7%, and 4.4% is not a rounding of it. The arithmetic was never done
as written. **Its origin is identifiable rather than unknown**, which is why it is recorded here
instead of quietly replaced: 2 over 45 is 4.44%, and 2 is the count of distinct *runs* carrying an
occurrence, against 3 occurrences in total — one run fired twice, at two different iterations. The
sentence stated an occurrence numerator and a per-run rate as though they shared a population.
Both measures are given separately above so neither can stand in for the other; they diverge
precisely because this trigger can repeat within a single run. A reader re-checking these figures
against item 73's key will find this one unexplained by it — correctly, because the key was never
involved.

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

## 12. Closed — the predicate reads structured fields for all three write tools, and a succeeding no-op no longer counts as applied

`didApplyPatch` (`src/llm/verification/logUtils.ts`) decides whether a run applied anything —
feeding the run's final reported verdict, not an internal nudge. This entry originally led with
the rehydration link (see item 6); a fuller pass found that was the smallest of the reachable
problems, and the load-bearing defects it didn't name are now fixed across three commits.

**What was wrong:** the predicate classified `apply_patch`/`write_file` entries by
string-matching `result` text for "error"/"not found"/"fail", case-insensitively with no word
boundary, and never checked `multi_edit` at all.
- **The path-name false negative.** Every write-tool success message embeds `${filePath}`. A
  patch to any of the 16 tracked files whose path contains one of those three substrings — an
  ordinary single-file edit to `src/core/parseVerificationError.ts`, for instance — reported as
  having applied nothing. (Sixteen as of `d9ca5798`, re-counted then; the figure was previously
  anchored to nothing, which is the class item 36's sweep inventories — it will drift as files are
  added, and the defect it illustrates does not depend on the exact number.)
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

**What `e21aab93` left, and how each was settled:**
- **Rehydrated entries still counted.** Rehydration hardcodes `success: true` (item 6), and the
  predicate that commit shipped read exactly that field, so a rehydrated `apply_patch`/`write_file`
  counted as applied regardless of what happened before interruption. This bullet used to propose
  reading `resumeStagingFiles` instead, on the claim that it is non-empty exactly when the prior run
  staged real work. **That claim is false in both directions and is thrown out rather than
  qualified.** `stagedWrite` on the patch path is unconditional, so a run whose only write was a
  content-identical no-op still leaves the map non-empty; and `reconcileEnvelopeStaging` restores
  only entries whose disk hash still matches the recorded base, so a run whose work was already
  flushed leaves it empty despite a real patch. The true predicate is narrower — non-empty exactly
  when the prior run staged something whose base still matches disk — and it is not the one that
  bullet needed. What settled this half instead was a rule about absence, below.
- **The no-op patch — the field half landed in `21da1225`, the predicate half did not.** A
  FIND==REPLACE `apply_patch` stages byte-identical content and returns `success: true`. Traced end
  to end rather than assumed: the block gate is `countOccurrences` on the FIND text, which a
  FIND==REPLACE block passes because the text *is* present, and no content-equality check exists
  anywhere between that gate and the success return. `write_file`'s region has none either.
  `21da1225` narrowed `filesStaged` at every success return that set it unconditionally, in both
  single-file tools and in `multi_edit`'s per-file push, so the field now names only files whose
  persisted bytes actually differ.
  **Two claims this bullet used to make are thrown out, not qualified.** It called the work "two
  success returns"; the real surface was every unconditional success return across both single-file
  handlers plus `multi_edit`'s push — the smell-baseline suppression return in each handler is a
  second success path the count missed. And it said `multi_edit` "already implements the narrow
  meaning (replacement count > 0)". A replacement count is a *match* count, not a content
  difference: `find === replace` matched, entered the `if (count > 0)` branch, and pushed the path,
  so `multi_edit` over-reported the same way the other two did and was narrowed in the same commit.
  The field's own doc comment stated a contract all three violated, and was rewritten in that commit
  to describe what the code now does.

**A latent hazard found while auditing this entry, kept here rather than carved out.** Two distinct
`ToolCallLogEntry` types exist. The one in `toolEventHandler/types.ts` declares `filesStaged`; the
one in `runCompletion/types.ts` does not — and `composer.ts` and `deriveVerdict.ts` consume the
latter, while `inferVerificationFromLog`'s own inline log parameter omits it too. The `multi_edit`
arm works today only because `handleToolResult` sets `filesStaged` at the push site and structural
typing carries an undeclared property through every one of those narrower declarations. Any future
site that *constructs* a log from the declared type instead of forwarding a real one would produce
`filesStaged: undefined`, sending every `multi_edit` down `multiEditChangedSomething`'s anomaly
branch — false, plus a `[zone-multi-edit-log-missing-staged]` record. **Inside this entry, on item
23's precedent rather than item 71's**: item 71 was carved out because it was a different *kind* of
thing from its parent's recipe, in a different layer; item 23's third-phase gap stayed inside
because it was the same defect class in the same function that the entry's own recipe already
reached for. This is the second shape — same predicate, same field, same arm. **`21cb580a` narrowed
the hazard to `multi_edit` alone, and that narrowing is the absence rule's own consequence rather
than a separate fix:** the other two tools' arm now resolves an absent field to *applied*, so a
constructed log leaves them reading exactly as they did before the field existed, while `multi_edit`
still takes the anomaly branch.

**What `21da1225` did not close, and why narrowing the field was never going to close it.** The
`apply_patch`/`write_file` arm read `e.success` and not `filesStaged`, so a succeeding no-op still
returned `true` from the predicate exactly as before. Making the field honest and making the verdict
honest are separate changes, and only the first landed there. The classify path also punished the
second one until `ef9d0608` closed item 70: every earlier branch of `inferVerificationFromLog` is
gated on the flag being true, so a false flag fell through to the not-applied check, which used to
return the broken-tests verdict — this entry's own original symptom by a new route. That branch now
returns `no_verification_attempted`.

**Closed by `21cb580a`, and the decision it turns on is about absence, not about no-ops.** The arm
now short-circuits on the success flag, then reads the staged-files field as three distinct states:
populated means changed, an empty array means unchanged, and an **absent** field means changed. The
polarity on absence is deliberately the opposite of `multiEditChangedSomething`'s own absent branch,
which marks the anomaly and reports no change. The structural reason is `agentLoop.ts`'s `REHYDRATED`
set: `apply_patch` and `write_file` are members of it and `multi_edit` is not, so `rehydrateFileAccess`
— whose entry shape declares no staged-files member at all — is a real production producer of
absent-field entries for those two tools and for no others. Choosing "unchanged" there would make a
resumed run that genuinely applied a patch report that it applied nothing, which is a wrong answer
the old code never produced; choosing "changed" leaves that population reading exactly as it did
before. See item 75 for the threading that would remove the guess entirely, and why it is not built.

**The code comment on that arm carries only the structural half, deliberately.** It names the
three-way meaning, the opposite polarity, and the rehydration-set membership that justifies it, then
points here. Anything conditional — why the alternative was rejected, what the observation window
shows, what would change the answer — lives in this entry, so a reader who wants to change the
reasoning changes it in one place rather than finding a confident argument sitting next to code that
has moved on.

**What the change actually moved, stated narrowly because this entry previously claimed more.** It
moves `emitAgentFinalAssessment`'s payload, which `runCompletion/composer.ts` emits *before* it calls
`verifyAndFinalize`: a no-op run's raw verdict stops being upgraded to `tests_skipped_no_infra` and
the validated flag it records goes false. **The sentence that used to say this was the intended
direction for the reported result is thrown out, not qualified.** For a fresh no-op-only run the
result field was already correct: the staged bytes equal the disk bytes, so `finalizeStaging`'s
all-unchanged comparison returns the no-changes-made status, `deriveResultFields`'s `no_change` case
hardcodes both the reason and the validated flag, and neither value has ever depended on this
predicate. Telemetry and the result field are separated by exactly that override — see the sixteenth
pattern.

**It does not narrow item 74's validated-flag strand, and that is worth saying rather than leaving to
inference.** Both shapes recorded there reach the flag through a model-supplied tag, and neither the
tag parser nor the two demotion validators read `patchApplied` at all; only
`applyNoInfraVerificationOverride` does. So the strand is exactly as it was, the same way item 74
already records that `ef9d0608` changed a value its flag was already false for.

**A coverage limitation the closing commit could not remove, recorded so it is not rediscovered.**
The composer path's own fixture is observable only under a mock. A real no-op run cannot reach the
assertion it makes, because `finalizeStaging` takes the no-change branch first and `deriveResultFields`
then overrides the field regardless of the verdict — so the block depends on its describe-level
`beforeEach` resolving the verification call to the applied outcome. **That dependence is stated in a
comment above the block and not in the block's name**, which means a sweep of block names for
mock-dependent fixtures will not find it. Recorded here for the same reason the thirteenth pattern
exists: one surface searched, its silence read as the system's.

- **The anomaly branch**, folded in here rather than opened as its own item because it lives in the
  same function the predicate pass would already be editing. `multiEditChangedSomething` treats an
  absent `filesStaged` as an anomaly — returns false, emits `[zone-multi-edit-log-missing-staged]`.
  **It is covered**, by `agentLoop.multiEditSaturation.test.ts`'s case G, which calls the helper
  with a `multi_edit` entry carrying `success: true` and no `filesStaged`, then asserts both halves
  — the `false` return and that the marker fired. `21cb580a` left it untouched: unifying the two
  polarities is what the absence rule exists to refuse.

**This entry claimed that branch was uncovered, and the claim is thrown out. How it got there is
the part worth keeping.** `21da1225`'s own report observed that the log utils' test file ran clean
under its `undefined`-instead-of-`[]` mutation and inferred the branch was untested. The inference
was carried into a brief and then into this document by `ea5dc75b` without being checked against
the tree. What defeats it is where the covering test sits: `multiEditChangedSomething` is defined in
`verification/logUtils.ts` but re-exported from `agentLoop.ts`, and the test imports it from the
re-export, so it lives beside the re-exporting module and not beside the defining one. A sweep of
the defining module's own test file finds nothing; a sweep by symbol finds the test immediately.
That is the thirteenth pattern's method applied to coverage rather than to call paths — see there.

**The reason this entry gave for splitting the remaining work is also gone, and a different one
replaces it.** It said the predicate change was gated on reconciling the two `ToolCallLogEntry`
declarations. It is not: `didApplyPatch`'s own parameter type, `ToolCallLogEntryLike`, already
declares `filesStaged`, and the `multi_edit` arm already reads the field through that parameter at
both live call sites. An arm consulting the same field for the other two tools therefore compiles at
both sites with no declaration touched — proven by existing construction rather than argued. The
rehydration half's stated dependency is smaller than named too: adding a parameter to
`inferVerificationFromLog` does not touch either `ToolCallLogEntry`, so what that bullet described
is a hygiene preference about not widening a surface that already depends on an undeclared property,
not a compile-order constraint.

**What forced the sequence, established against the code rather than inherited.** The tool-call log
is not persisted in the run envelope — the envelope carries messages, staging, failure history and
todos, and the log is rebuilt on resume by `rehydrateFileAccess`, whose own entry shape declares no
`filesStaged` member at all and hardcodes `success: true`. So every rehydrated single-file entry
presents the field as absent, and the arm change could not land without either an emission of the
field on that rehydration path or an explicit rule for absence. It landed with the rule, in one
commit and with no declaration touched — `didApplyPatch`'s own parameter type already declares
`filesStaged`, and both live call sites already forward real entries through it.

**The behavior change `21da1225` did make, in one sentence:** the modified-files set no longer
includes a file whose call succeeded but left the persisted bytes identical to what was read.

**No evidence exists either way, and the silence is uninformative by construction.** No marker
instruments this predicate's correctness at all — nothing records a `didApplyPatch` verdict against
what actually happened. The one adjacent marker, `[zone-multi-edit-log-missing-staged]`, has **zero**
sink records; but the tool-call census on item 73's key shows `multi_edit` was **never invoked** in
the recorded window (`search_in_files` 30, `read_file` 23, `run_command_readonly` 6, `apply_patch` 4,
`run_command` 1, all upper bounds). So the zero means the path was never taken, not that it is
sound. The absence rule this entry closes on rests on the same footing: it is a correctness argument
about which wrong answer is cheaper, with no observation behind it — item 75 records the observation
that would settle it, and that it has not occurred.

**The general lesson, past this fix:** classifying an outcome by pattern-matching
human-readable text instead of reading a structured field meant to carry that outcome is the
same shape of fragility that motivated the line-anchored marker recount (item 1) — prose is not
a data model. See item 6 for the sibling defect this connects to: rehydration's hardcoded
`success: true`, and why the read-before-patch gate it serves makes that hardcoding correct on
its own terms even though it is what forced this entry's absence rule.

**Where the code lives:** `didApplyPatch` and `multiEditChangedSomething` both live in
`src/llm/verification/logUtils.ts` (`multiEditChangedSomething` moved there from `agentLoop.ts`,
which re-exports it for existing importers). Called from `composer.ts`
(`src/llm/runCompletion/`) directly, and from `inferVerificationFromLog` in `classify.ts`
(`src/llm/verification/`). **A third export surface this section used to miss:**
`verification/index.ts` re-exports `didApplyPatch` as well — nothing imports it by that route
today, but a caller-sweep that stops at the two call sites above will under-count the surface.
`deriveVerdict.ts` imported it but never called it — that dead import is gone now too (see item
13). `multiEditChangedSomething` has a third branch this entry's description of the fix skipped
over: `filesStaged === undefined` returns false *and* emits `[zone-multi-edit-log-missing-staged]`,
so that arm is "success plus non-empty `filesStaged`, with the absent case marked rather than
guessed" — the anomaly branch the hazard above would drive every `multi_edit` into, and the one the
other two tools deliberately do not share.

**Closed, and the heading rewritten on items 32 and 56's precedent.** Both of those went from a
`— partially closed` suffix to a `Closed — ` prefix, and both dropped the suffix outright rather than
converting it, rewriting the whole heading around the resolution instead of the original defect. This
entry follows that. **The same pair settles the footnote, which the snapshot test does not check:**
each was a member of the partial-status footnote while partially closed, and each left it in the very
commit that closed it, so this entry leaves it too. Worth deriving rather than assuming, because
footnote membership and heading suffix are independent — item 16 left the footnote while still
carrying a `— corrected` suffix and not being closed, and item 61 sits in the footnote carrying no
suffix at all.

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

**What would close it — inherits item 2's dependency, not a fix of its own.** The generator's
real output already has exactly the shape line-anchoring accepts: `diffToFindReplace` emits
column-0, own-line markers, checked directly against its actual return value for the hazardous
one-block-diff case this entry describes. Anchoring the walk changes nothing about how this
specific text parses — the same measurement that shows anchoring misses item 2's trigger applies
here unmodified, since both entries share the identical own-line, matched-pair trigger shape.
This closes only when item 2 does, by whichever fix item 2 actually gets (item 17's structured
argument, currently) — there is no fix to seek here independent of item 2's own resolution.

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

## 17. `apply_patch`'s delimiter ambiguity is self-inflicted, and a structured argument would sidestep it — corrected

**What it is:** `apply_patch` packs a FIND string and a REPLACE string into one delimited blob
and parses them back apart with a walk — which is what makes item 2 possible at all. A
structured `blocks: [{find, replace}]` argument would sidestep this: a JSON array has no
delimited text for a walk to mis-split in the first place.

**This entry's precedent was wrong, and the correction changes what "additive" means here —
corrected below, not softened.** The original text cited `multi_edit` as the precedent for a
`blocks` array. Re-verified against `multi_edit`'s real schema: `{files: string[], find:
string, replace: string, wholeWord: boolean|null}` — one find/replace pair applied across N
files, the transpose of `apply_patch`'s own shape (N pairs against one file), not the same idea
at a different fidelity. No tool in this repo takes a `blocks: [{find, replace}]` array. The
real in-repo precedent for a nested structured argument is `apply_patch`'s own `scope`
parameter — already an object with its own properties, already living in the exact schema a
`blocks` argument would join.

**"Additive, no model-facing behavior change" does not survive the schema — checked directly,
not assumed.** `apply_patch` is declared `strict: true`, with every property in `required` and
optionality expressed only as a nullable union (`intent`/`scope` are `["string"/"object",
"null"]`, still required). Adding `blocks` the same way makes every `apply_patch` call carry
both `patch` and `blocks`, one of them null — a model-facing change to every call, not just the
ones hitting the defect.

**The cost framing was unstated, and measuring it reverses the assumption a reader would
otherwise bring.** Measured on a representative three-block same-file patch from this repo's own
source: the structured form's full tool-call-arguments JSON is 724 characters against the
delimited form's 752 — about 3.7% *smaller*, not larger. The delimited patch text is already a
JSON string value on the wire, so both forms pay identical escaping; the marker text's own
newlines cost more (33 JSON-encoded characters per block) than the structured form's scaffolding
(25). Cost is not an argument against structured blocks — if anything, a mild argument for.

**Only replacing the delimited form closes item 2 — the load-bearing finding for anyone
planning this work.** If `patch` stays accepted alongside a new `blocks` argument,
`segmentPatchBlocks` still runs on it, and a model that emits the delimited form with an
embedded matched pair still gets the silent wrong-content write item 2 describes. A coexisting
`blocks` argument makes the defect *avoidable*, not *absent* — it would rewrite item 2 into "a
safe alternative exists; the unsafe path is still reachable," not close it.

**`multi_edit` does not subsume `apply_patch`, for two independent reasons — recorded so "just
deprecate apply_patch" isn't proposed as the smaller path.** Match semantics differ: `multi_edit`
replaces every occurrence with no uniqueness check, while `apply_patch` requires FIND to match
exactly once and rejects ambiguity. And arity is transposed: a single-file, three-region edit
needs three separate `multi_edit` calls — the tool's own description says "call once per
region" — versus one `apply_patch` call covering all three (its own description says the
opposite: never split same-file edits across calls). Collapsing the two tools would mean
rebuilding `apply_patch` inside `multi_edit`, not removing a redundant tool.

**What would close it:** adding a structured `blocks` argument to `apply_patch`'s schema,
replacing the delimited `patch` string rather than sitting alongside it (see above —
coexistence doesn't close item 2). Not yet scoped as a design: whether to replace outright
depends on data this repo doesn't have yet — see item 63.

**Bucket, against the document's own usage, not the one-line definition alone.** Items 58 and 59
are the matching shape: a real, verified structural fact, with real options and real costs, but
a decision that depends on data this repo doesn't have yet — the bucket's own working definition
is whether a fix is specified *and ready*, nothing left to learn, and that's not this entry's
state. **Bucketed Neither.**

**Where the code lives:** `multi_edit`'s schema (not the precedent) and `apply_patch`'s own
`scope` parameter (the real one) are both in `toolDefinitions.ts`, alongside `apply_patch`'s own
schema (what would change).

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
occurrences. The zero is a *measured* zero, not a structural one — the marker
(`[zone-self-validation]`, `rule:"smart_quote_autofix"`) predates the sink's observation window by
months, and its sibling rules on the same tag carry **48 deduplicated records** (54 raw — item 73)
in that window, so the tag is live and would have recorded a hit had one occurred. That figure was
written as 42 and is corrected here by re-derivation, not by dedup alone: the sink has accumulated
since. **The denominator this paragraph originally paired with the zero — "24 apply_patch calls
that reached the walk" — is not re-derivable from the current sink and is dropped rather than
restated.** No marker in it yields 24 on any key, and the population it named was never
instrumented until the pass below created the record that counts it; the zero stands on the
sibling-rule evidence above, which does not depend on that number. Line endings
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

**The payload's three fields stopped measuring the same kind of thing once smart quotes closed,
and that changes how this record can be read — not whether it can be.** `eolChangedBlocks` and
`prefixStrippedBlocks` still indicate a live dedup gap: the applier normalized something
`hashPatchBlocks` did not, so that patch's hash diverges from what the applier matched on.
`smartQuoteChanged` no longer does — it now reports a normalization **both** sides perform, so it
marks only that the patch contained curly quotes. As a denominator the record is unaffected:
`blockCount` is what the marker-split rate divides by, and that field means exactly what it always
did. What is affected is any attempt to read the record as a *gap* count — summing all three
fields would over-count by every smart-quote record. `cd02808c` is the cutoff, and the payload
carries no version field, so pre- and post-fix records are indistinguishable in the sink despite
`smartQuoteChanged` meaning different things on either side of it.

**Observed so far: zero gaps in two calls, not four records — this entry's own open question is
resolved now, and it resolves against the entry.** The sink carries four
`[zone-apply-patch-normalization-parity]` records, but they are **two calls logged twice**: two
distinct payloads, each pair identical in every field except the timestamp. "Whether that is four
calls or two double-logged" was recorded here as not established. It is established now, and it
halves this entry's own denominator. Both calls carry `blockCount: 1` with all three fields
zero, so the measured rate for both open classes is 0 of 2. The instrumented window is not short
in time — the marker landed 2026-08-02 and the sink's newest record of any kind is dated
2026-08-05, roughly four days — but both qualifying calls fall inside a single fifteen-second
burst on the last of those days, so the window is sparse rather than brief, which is the weaker
of the two shapes. Two calls cannot distinguish "these classes are rare" from "almost nothing
exercised this path at all"; item 4's own precedent puts a usable threshold at roughly 10-20
records. Recorded so nobody reads it as evidence the remaining two classes don't fire. One thing
it does settle structurally: `blockCount: 1` on every record explains
`[zone-apply-patch-marker-split]`'s own zero, since that marker's population is exactly this
record's `blockCount > 1` slice — its zero is consistent, not a silent failure. The double-logging
itself is not this marker's defect and is not this entry's to fix — it is sink-wide; see item 73.

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
rider on item 16's extraction.

**The claim that a characterization test needs a deliberate edit to close this is false, and the
sentence is thrown out rather than qualified.** This entry named **T6** (line endings) as pinning
the unnormalized value and therefore requiring a knowing edit — by analogy with **T7** (smart
quotes), which genuinely did need one and got it when that class closed. The analogy does not
hold, because the two fixes land in different functions. T7's fix ran through the segmenter, which
is what `parsePatchBlocks` returns; T6's assertions both target `parsePatchBlocks`, and its sibling
on the applier's re-export targets `segmentApplyPatchBlocks` — **neither calls `hashPatchBlocks`
at all**. A normalization confined to `hashPatchBlocks`, which is what this entry prescribes,
leaves both tests passing untouched. Sharper, and the part that actually matters: **no test
anywhere asserts a hash value for a CRLF-bearing or prefix-bearing patch.** Every existing
`hashPatchBlocks` assertion uses a fixture with neither. So this fix would break nothing and is
guarded by nothing — the work is writing new tests, not editing old ones, which is the opposite
of the obligation this entry recorded. Both CRLF tests are intent, not characterization-by-
accident: each deliberately pins non-normalization *at segmentation time*, and each stays correct
after a hash-level fix.

**Three things the recipe does not state, each of which would produce a defect if an implementer
followed it literally.**
- **The prefix stripper applies to `find` only; EOL applies to both.** The applier's match-time
  pair is `stripReadFilePrefix(normalizeEol(block.find).text)` against
  `normalizeEol(block.replace).text`. The recipe says only "importing `stripReadFilePrefix` and
  the walk's own EOL-replace chain" and never mentions the asymmetry. Stripping both sides would
  open a **new divergence in the opposite direction** — two patches the applier treats as
  different, because they differ only in a `replace`-side prefix, would collide in the hash.
- **The normalization must stay on the parsed blocks, and item 64 is what makes that
  load-bearing.** `hashPatchBlocks` guards `patch === ""` on the raw argument before parsing, and
  returns the no-patch sentinel there. Applied to the raw patch *ahead of* that guard, a
  non-empty patch can collapse to empty and take the sentinel: measured, a lone line-number
  prefix (`"   1"` followed by a tab) strips to the empty string. That is item 64's closed
  collision defect reopening by a different route. Confined to the blocks, the guard is untouched.
- **Neither function is exported.** `normalizeEol` and `stripReadFilePrefix` are both
  module-private in `toolExecutor.ts`. The import direction is safe — `agentLoop.ts` already
  imports from that file — but the recipe's "importing … from `toolExecutor.ts`" requires an
  export change it never mentions, and that is arguably the wrong move anyway: the class that
  already closed did not export from `toolExecutor.ts`, it moved the function to a shared leaf
  module (`src/utils/smartQuotes.ts`, beside `patchBlocks.ts`). The recipe contradicts the
  precedent set by its own closed class.

**`stripReadFilePrefix`'s own properties, measured, because the recipe hands it to a second
caller and nobody has recorded them.** It is **total** — every input returns a string, nothing
throws. It is **not idempotent**: nested line-numbered content strips twice, each pass removing
one layer, so applying it to already-stripped text is not a no-op. And it **alters content that
was never a pasted prefix**: a tab-separated fixture whose every line begins with digits and a
tab is indistinguishable to it from a `read_file` dump and is stripped. The all-or-nothing rule
narrows that false-positive class but does not close it. In the applier these properties are
bounded — one call, on `find`, against text the model just pasted. A second caller inside the
dedup hash widens the blast radius to every patch that ever gets hashed, which is why they are
recorded here rather than left at the definition.

**The real cost when it fires, not previously stated.** In the coaching path
(`CoachingController`), the demotion is label-only — every consumer of `repeatPattern` treats it
as `!== null`, `.filePath`, or `.reason` threaded into telemetry; routing and escalation behave
identically regardless of which of the four reasons fired. In `antiThrash.detectFailureStall` it
is worse: Verdict 1 misses on the hash, and Verdict 2 is excluded by its own
`last.trigger !== prev.trigger` guard (a normalization-class resubmission has the *same*
trigger), so the `failure_stall` signal is **skipped outright for that comparison, not
relabelled to a weaker verdict**. Self-clearing on the next failure, once both compared records
are hash-consistent again.

**What closing it buys, and why the collision it creates is the point rather than a cost.** Swept
every `patchHash` consumer in the repo: the two equality comparisons named above, one copy into
the run envelope, one persisted field, two producers. It is **never a map or set key** — nothing
indexes by it, and no path depends on two hashes staying distinct for any reason beyond the
pairwise comparison itself. So making an EOL-only or prefix-only resubmission collide is not a
side effect to be weighed against a benefit: the collision **is** the fix, and it lands only where
the applier already treats the two patches as the same text.

**It also closes a second thing, at one site rather than two.** Exactly one comment in the repo
calls the value a "normalized patch hash" — `antiThrash.ts`'s, sitting directly above its own
equality check. `detectRepeatedFailure`'s mirror branch carries no such wording, so there is no
second copy to drift. Today the word is one-third true; after both classes close it is accurate,
on the honest reading "normalized the same way the applier normalizes," `find`-only asymmetry
included.

**Not built and cannot be built are different states, and this document's bucket names do not
distinguish them — so it is recorded here as a decision.** After the corrections above the recipe
is fully understood and the fix is small: two normalizations, on the parsed blocks, `find`-only
for the prefix, plus the tests that do not exist yet. Nothing further needs to be *learned* to
build it. What is missing is evidence: across the only two calls ever instrumented, neither class
fired. Deferred on motivation, not on knowledge. That moves this entry out of "actionable now,"
whose bar is that a fix is specified and nothing new must be learned — both true here, and still
not sufficient — and into "blocked on data," on item 63's precedent: that entry is likewise a
*whether to build* question parked on records that do not exist yet, not a *what to build* one.
Item 4, whose 10-20 threshold this entry already cites, sits in the same bucket for the same
reason. The bucket name is the closest fit the document has, not an exact one.

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
`hashPatchBlocks` are in `agentLoop.ts`. The imprecise "normalized" comment is in `antiThrash.ts`,
directly above its own `patchHash` equality check ("same trigger AND same normalized patch hash")
— **this entry used to call it flatly wrong, and that is no longer accurate: it is one-third
right.** The hash it describes now genuinely is smart-quote normalized, and is still not EOL- or
prefix-normalized, so the word "normalized" over-claims by exactly the two classes this entry has
open rather than by all three. It stays unfixed and in this entry's scope: it is a production-file
comment whose correct wording depends on which of the two remaining classes get closed, so
rewording it now would mean writing it twice. `detectRepeatedFailure`'s matching check is in
`agentLoop.ts`. `[zone-apply-patch-normalization-parity]`'s pre-pass and emission sit in
`apply_patch`'s handler, `toolExecutor.ts`, right after the existing smart-quote telemetry — item
55 (now closed) records what closing this item's smart-quotes class did and did not change about
that marker's own test-file header comment. The characterization tests pinning current values are split across
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
surviving one still is, sink-eligible under `ZONE_VERBOSE_LOGS=1`.

**The evidence this paragraph originally offered has been overtaken, and both of its sentences are
thrown out rather than annotated.** It said the sink showed zero records for all four related tags,
and explained that away as a stale sink holding nothing after 2026-08-01 while the parity marker
landed 2026-08-02 — then treated the shared zero as the proof, on the reasoning that a `log` site
reading the same as a `debugLog` one rules the logging function out. Neither sentence is true now.
The sink holds 1928 records dated after 2026-08-01 and its newest is dated 2026-08-05, so it is not
stale; and the tags do not read zero — `[zone-apply-patch-eol]`, a `debugLog` site, carries **two
deduplicated records**, and the `log`-based parity marker carries **two** as well (item 73's key).
The shared zero was never strong evidence anyway: two silent tags are equally consistent with
either explanation. **What replaces it is stronger, and confirms the same conclusion positively
rather than by absence** — a `debugLog` site and a `log` site both carry records, in the same
window, at the same count. Sink-eligibility demonstrably does not track which logging function
emitted the line, which is what this paragraph set out to establish.

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

**The defect sits in two of the three phases, not one — this entry originally described only the
first of them.** The third phase, the sessionId content scan, walks the same unsorted
`envelopeFiles` and stops at its first `env.sessionId.startsWith` hit, differing only in that item
32's summary refactor turned its early `return` into `found = …; break`. Identical
arbitrary-first-match, identical cause. Any recipe naming only the prefix phase closes half the
defect, and the half it leaves open is the one the migration guarantee routes through — the path a
user takes when they type a sessionId they remember from a toast or an older note.

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

**And the two sides are further apart than "one deterministic, one not" — for the prefix phase
they are not even ordering the same identifiers.** Since the cutover, the envelope's filename key
is its runId, so the prefix phase tests a typed prefix against **runIds** while the session lookup
tests it against **sessionIds**. One `--resume <prefix>` therefore runs two searches over two
different id spaces, and the two can select unrelated records without either one being "wrong" —
which is a sharper statement of this entry's own argument than the one above, not a separate
concern. It is specific to the prefix phase: the third phase matches `env.sessionId`, so it does
share the session side's namespace. Stated per-phase because the recipe below targets the prefix
one, and the mismatch is a property of that phase rather than of the resolver.

**What would close it:** give **both** arbitrary phases the same "sort candidates, take newest"
treatment `loadSessionById` has. The sentence that used to sit here — that envelope filenames are
`<sessionId>.envelope.json` with no ISO prefix to sort by, so ordering would need an mtime stat or
a timestamp read, a cost the session side avoided — is thrown out rather than qualified: it is
false in both halves. The key is the **runId** (`envelopeKeyFor`, `env.runId ?? env.sessionId`);
sessionId naming survives only on pre-cutover files, and a test pins exactly that. And the timestamp
already exists — `RunEnvelope` carries `createdAt` and `updatedAt` — while `listResumableEnvelopes`,
exported from the same file so no new import is needed, already ends with
`results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))`. That is the structural analogue of
`listAllSessionFilenames` this entry claimed the envelope layer lacked.

**One real constraint, and one inversion that decides the shape of the fix.** The constraint:
`listResumableEnvelopes` also drops entries failing `isResumable` and, when given a `repoPath`,
entries from other repos — filters `resolveEnvelopeId` deliberately does not apply, since it must
resolve any envelope by key. **Its comparator is reusable; the function is not.** The inversion:
the expensive part of ordering is loading every body to read `updatedAt`. The prefix phase loads
none today and the content scan already loads them until its first hit, so one load can serve both
phases — while fixing only the prefix phase *adds* a full load that the content scan then repeats.
**The complete fix is cheaper than the partial one**, which is the opposite of how this entry
framed the work.

**A cross-file obligation, recorded here so it is not discovered mid-implementation.**
`loadSessionById`'s doc comment in `diskSessions.ts` states the session side is "Deliberately NOT
mirroring its ambiguity rule: that phase walks raw, unsorted readdir output and returns the first
startsWith match, which is filesystem-order luck, not a decision." Closing this makes that sentence
false. The edit belongs in the same commit as the fix, in a file the fix does not otherwise touch.

**This entry deferred for a reason that was false, and was right to defer anyway for one it never
gave.** The cost argument above did not survive contact with the code. What does hold is evidence,
and it is the thing a later reader deciding whether the threshold is met should weigh:

- **The trigger is currently unreachable, not merely unobserved.** Ambiguity needs two envelopes
  sharing a typed prefix. Envelopes are deleted on graceful success — `runLlmPatchFlow.ts` says so
  in as many words, "deleteRunEnvelope is only ever called on graceful success" — so only
  interrupted runs accumulate, under a retention policy of `maxAgeDays 30` and `maxCount 200`. At
  the moment of writing, 2026-08-06, the envelopes directory holds **one** file. That is an
  observation at a moment, not a standing property: the policy permits far more, and a stretch of
  interrupted runs would change it.
- **Nothing instruments prefix resolution, so silence here is not evidence.** No marker fires on a
  prefix match, ambiguous or otherwise; a sink zero would be uninformative rather than a measured
  zero. The two related tags carry, as upper bounds on item 73's key, `[zone-envelope-cleanup]` at
  1 and `[zone-resume-rehydrated]` at 2 — and both rehydrate payloads carry full runIds and
  sessionIds, so there is **no recorded instance of anyone resuming by prefix at all**.
- Keys are UUIDs, so an eight-character prefix collision needs two of them agreeing across eight
  hex characters, which at any plausible population is negligible even before the count above.

**Where the code lives:** `resolveEnvelopeId`, `diskRunEnvelope.ts` — both arbitrary phases: the
filename-prefix phase (`// Filename prefix match`) and the sessionId content scan below it. The
reusable comparator is `listResumableEnvelopes`'s trailing `updatedAt` sort, same file. The comment
the fix falsifies is `loadSessionById`'s doc in `diskSessions.ts`. Routing precedence is
`cli/index.ts`'s envelope-first routing block (`// --continue / --resume: envelope-first
routing.`), whose resume threading is covered by `index.resume.test.ts`'s Fix A and Fix B blocks —
both confirmed present at HEAD, since an unchecked reference inside a corrected entry is the shape
this document keeps catching.

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
the headings above it, and no natural home existed for such a check — `scripts/` held only
sweep/probe tooling, no test read `docs/*.md`, no CI workflow touched markdown. ("Sweep/probe" is
the pre-rewrite wording, restored: the tree at `964296ac^` held four probe scripts alongside the
sweep files, so the rewrite's "only sweep tooling" was false. One of four errors that rewrite
introduced, all corrected below.)

**The consistency half is closed.** `scripts/deferredWorkSnapshot.test.ts` (`964296ac`) parses
every `## N.` heading and the snapshot's own bucket lines, asserting four things: the Closed-set
comparison this item originally proposed, plus three coverage assertions it didn't — declared
count vs. actual list length per bucket, no item in two buckets, and none in zero. **Coverage is
the dimension with the demonstrated catch, not the one this item named.** Run against the tree at
`9f45989c` — the commit where item 36 itself had a heading but appeared in no bucket — the
Closed-set comparison passes cleanly, and only the coverage assertion fires: "Item(s) 36 have a
heading but appear in no snapshot bucket." The check this item originally proposed would have
missed the one real failure that ever occurred; it was never the dimension that broke.

**That claim was re-run rather than re-read, and it reproduced exactly — worth noting because it
is the only one that did.** Replaying the test's own parsing against the `9f45989c` tree gives
Closed-set PASS, declared-count PASS, coverage FAIL with `missing=[36]`. Across the entries audited
in this session's passes, claims have come back confirmed, wrong, or not establishable; this is the
one that could be *reproduced* from the artifact it names. Recorded as a small fact about this
claim, not as a general standard the others failed. The closure itself is independently
verifiable without trusting any commit message: the file exists, `scripts/**/*.test.ts` is inside
vitest's `include`, and `tests.yml` runs `npm test`.

**The currency half closes as a decision, not a fix** — a second establish pass built and ran a
currency check, matching commit messages against item numbers and comparing against heading status,
and it is not worth shipping. The decision stands. Both of the grounds it was recorded on do not,
and they are corrected below rather than softened.

**The blind-spot ground was argued from two examples that refute it, and the sentence is thrown
out.** It read that a commit closing an item without naming it is invisible to the check by
construction, "which is exactly how items 7 and 32 went unrecorded for a session's worth of
passes." Both closure commits name their item: `af3125f0`'s body opens "Ledger item 7." and
`d1ce3dc4`'s subject is "close item 32 — loud marker on envelope version mismatch." A naive
`item N` grep finds both, so the check would have caught both — they are its strongest
justification, cited as the case against it. **The pre-rewrite text had this right and the rewrite
reversed it**, which is the part worth keeping: that text recorded the hand method as what "found
both `d1ce3dc4` and `af3125f0`," then drew the line exactly — the check "would catch every future
instance of this exact mistake (a commit that says 'closes item N' while the ledger is never told);
it cannot catch the mistake of forgetting to say so in the commit at all." The rewrite cited the
same two commits on the wrong side of that line. **The blind spot itself remains real in
principle** — nothing can infer "this diff closes item N" from a diff that never says so — **but no
instance of it is on record.** Stated as that distinction rather than dropped, because "real but
never observed" and "demonstrated" are different claims and the entry made the second one.

**The false-alarm figure was anchored to "HEAD", which moved.** It read "At HEAD it produces 5 flags
and 0 true positives," measured when `b7902984` landed and never anchored to that commit. Fifty-one
commits have named an item since. Reconstructing the rule this entry describes at `235e5954` gives
**32 distinct items flagged across 185 flag events** — and that is a *reconstruction*, not a
re-measurement: the check "is recorded here only, not implemented anywhere," so the original's exact
counting rule is not establishable and these figures cannot be compared to the 5 as like for like.
**What the drift does is strengthen the decision, not weaken it.** Five flags with no true positives
was already a poor ratio; whatever the precise modern count, the false-alarm side has grown while
the true-positive side has not. The decision survives on this ground alone, which is the shape worth
recording: an entry can be right while both of its stated reasons need replacing.

**The rewrite's other two errors were smaller and are corrected in place.** It said the check "would
also need `fetch-depth: 0` added to CI's checkout (shallow by default today)". There are two
workflows: **`tests.yml`**, which runs `npm test` and whose `actions/checkout@v4` sets no
`fetch-depth`, is the one that would need it — the conclusion holds, but only for that workflow.
`feature-agent.yml` **already sets `fetch-depth: 0`**, so a reader grepping the setting finds a hit
and concludes this entry is wrong. Naming the workflow is what prevents that. The claim beside it —
that no test in this suite shells out to git — is **confirmed**: five test files import
`child_process` and all five mock it; none invokes git, so this would indeed be the first to cross
that boundary.

**A note on how these four errors arrived, which is not an essay.** All four entered in one commit
that rewrote this entry end to end when it became partially closed; nothing was carried forward. A
wholesale rewrite is a deletion plus an addition, and the deletion goes unreviewed — the blind-spot
reversal above is precisely a correct sentence deleted and replaced with a wrong one. That is worth
one instance's worth of attention and no more: item 57's correction this session also introduced an
error, but a *new* claim in *new* text where the old text had asserted nothing, which is a different
failure. One instance does not clear this document's bar for a pattern section, so it stays here.

Recording the technique instead: item references across this repo's
history take at least 14 distinct phrasings (`item N`, `Item N`, `ledger item N`, `items N-N`,
`items N, N, N`, `items N/N`, and others); a naive `/item (\d+)/i` misses every plural form. A
future hand sweep should use `/items?\s+(\d+(?:\s*[-\/,+&]\s*\d+)*)/gi` and expect to read every
hit rather than trust the count.

**Bucket, moved out of Actionable now — and the precedent pointed at the mismatch all along.** That
bucket requires a fix specified in the entry with nothing left to learn. What remains here is the
opposite: an explicit decision *not* to build, plus a recorded technique. **Item 46 names this
entry's currency half as its own precedent for the decision-not-fix shape, and item 46 sits in
Neither**; item 38 cites the same shape and is also in Neither. Two entries modelled on this one's
remaining half were bucketed Neither while this one stayed Actionable now. **Neither.**

**What remains open, in the code's own terms rather than this entry's.** Nothing in the repository
compares ledger state against code or commit reality. The shipped test compares the ledger **only
against itself** — headings against bucket lists, both inside one file — so it cannot detect a
ledger that is internally consistent and uniformly stale, which is exactly what items 7 and 32 were.
No artifact exists for that dimension and none is proposed here.

**An inventory from the unanchored-`HEAD` sweep this correction prompted, recorded so a later pass
need not re-derive it.** Eleven `HEAD` references exist in this document. Three, in the seventh
pattern, describe git semantics rather than a moment. Five are verification statements ("confirmed
present at HEAD") — this document's idiom for "checked when written," self-limiting by construction.
One is a state claim in item 62. **Two carried figures anchored to a moving reference:** this
entry's, corrected above, and item 16's "holds eleven `it()` blocks at HEAD" — re-counted during
this sweep and still eleven, so accurate and left alone. Anchoring a figure to a commit rather than
to `HEAD` is the cheap habit that would have made this correction unnecessary.

**The latent trap recorded here is discharged (`a3cbe763`).** The check could not express an empty
bucket: its bucket pattern required at least one character after the count's colon, so a bucket
rendered with a zero count and nothing following did not match at all, vanished from the parsed set,
and surfaced as the unrelated "all four buckets present" assertion — while rendering a placeholder
word instead did match and then threw on the item parser's own digit check. The pattern's trailing
capture now accepts an empty tail, so a bare zero count parses to an empty item list through the
existing split-and-filter chain with **no new branch**, and the bucket-presence assertion names which
required bucket failed to parse instead of rendering an array diff. Fixture-driven blocks now drive
the parsing functions against constructed lines rather than the real document, which nothing in the
file had done before even though both functions were already pure. The pass that discharged it is the
one that needed it: the reclassification of item 76 empties Actionable now, and item 69's closure had
already come within one entry of being that pass.

**What the fix did not cover, recorded as a live successor rather than a closed question.** A bucket
whose tail is non-empty but unparseable — a stray note, a half-deleted list, a typo where an item
number should be — still matches the pattern, still reaches the item parser's digit check, and still
throws. That throw happens where the document is read and parsed, in the enclosing `describe` body
rather than inside any `it()`, so it is a **collection-time** exception: the file fails to load, the
raw error is what surfaces, and no test result is produced at all. That is worse than one red test,
because a suite reporting nothing for a file reads as a harness problem rather than as a document
problem, and the two get investigated differently. Moving it inside an assertion means the parse
function has to collect its errors and return them rather than throwing, which changes its signature
and every call site — the real-document block and each fixture block alike. Not attempted in that
commit and not attempted here.

**Kept inside this entry rather than carved into its own, with the counter-argument stated.** This
entry already owns the check by name below, the successor is the residue of the paragraph above it,
and a separate entry would put two halves of one subject in two places. Against that: the successor's
fix *is* specified, which is the Actionable-now bar, and a specified fix inside a Neither entry is
harder to find. It loses to this document's own practice — item 61 carries a closed bullet inside a
Neither entry, and this entry has carried a closed half and a decided half side by side since it
became partially closed. The footnote below the snapshot is the mechanism that flags exactly this.

**Where the code lives:** the check is `scripts/deferredWorkSnapshot.test.ts`, reached by vitest's
`scripts/**/*.test.ts` include and run in CI by `tests.yml`'s `npm test`; the currency technique is
recorded here only, not implemented anywhere.

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

**Partial evidence for the second horn, from `21da1225`'s own establish — the three-way partition
is load-bearing on the write path in a way a four-way one would have to replace, not merely
mirror.** Because `dominant` has no `"mixed"` value, every writer that re-encodes reads it as an
instruction to pick one style and apply it everywhere: `apply_patch`'s and `multi_edit`'s
`replace(/\n/g, …)` arms and `write_file`'s CRLF-preserving arm all rewrite *every* line ending in
the buffer to the single style `dominant` names. On a mixed-EOL file that is a real, intentional
homogenization — the file comes back uniform, and the lines whose original style was the minority
one have genuinely changed on disk. The observable consequence, measured while narrowing
`filesStaged` (item 12): a textually no-op edit to a mixed-EOL file still persists different bytes,
which is why that pass had to compare the final written value rather than any pre-re-encode
intermediate. So the duplication cannot be resolved by pointing `dominant` at `detected` without
first deciding what a `"mixed"` file should be written back as — a question the current code
answers definitively (the plurality style) and a four-way `dominant` would reopen. That narrows
this entry's own open question without closing it: the second horn now has evidence behind it, the
first would need a write-path decision this entry doesn't make.

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

## 55. Closed — the parity header was wrong, but not for the reason this entry gave

**What it was:** `toolExecutor.normalizationParityTelemetry.test.ts`'s header comment stated a
blanket claim: the applier's walk normalizes smart quotes, CRLF, and the read_file pasted
line-number prefix before matching, but `hashPatchBlocks` hashes the raw, unnormalized patch
text — so two patches the applier treats as identical can get different dedup keys. Item 18's
partial closure (smart quotes only) made this accurate for exactly two of the three classes,
not all three.

**The marker itself is unaffected — checked, not assumed.** `[zone-apply-patch-normalization-
parity]`'s payload (`blockCount`, `smartQuoteChanged`, `eolChangedBlocks`,
`prefixStrippedBlocks`) measures `segmentApplyPatchBlocks`'s own normalization rate — it never
references `parsePatchBlocks` or `hashPatchBlocks` at all, so it was never a comparison between
the two paths and doesn't go silent now. What shifted is interpretation only, and that fact now
lives in **item 18** rather than here — the field-by-field split, the sink cutoff, and what both
do to that marker's use as a denominator are its ongoing concern, not this closed entry's, and
keeping one copy is this document's own rule against two that drift apart.

**Checked and found not to apply: items 1 and 4.** Both are "blocked on data," waiting on passive
accumulation of a *different* marker — `[zone-apply-patch-marker-imbalance]` and
`[zone-apply-patch-retry]`'s `marker_imbalance` reason field. Neither references
`[zone-apply-patch-normalization-parity]` anywhere. This marker doesn't feed either item, so no
accumulation cutoff is needed for them — recorded here so the question isn't re-asked.

**This entry's own reason for urgency was false, and the paragraph making it is deleted rather
than annotated.** It argued the comment had become wrong *in kind* — that after item 16's merge
"the applier's walk" and "`hashPatchBlocks`" were "one function called from both," so the
sentence's two-sided contrast had stopped describing the code at all. Measured against the real
call chain, the merge unified **segmentation only**. The applier still performs two
normalizations `hashPatchBlocks` has no equivalent of, applied per matched block inside a loop
that runs after segmentation: `stripReadFilePrefix(normalizeEol(block.find).text)` and
`normalizeEol(block.replace).text`. Neither function is called anywhere in the parse path —
confirmed by call-site sweep, zero occurrences in either `agentLoop.ts` or the shared segmenter's
module. So the two-sided comparison survived intact for the two open classes; the comment was
wrong in **degree**, exactly as this entry's own title originally said before the "worse in kind"
paragraph was added to it.

**The comment was wrong on a second point this entry never identified, and that is what made its
recipe insufficient.** `hashPatchBlocks` does not hash "the raw, unnormalized patch text" in the
ordinary case. It has three paths: `patch === ""` returns the no-patch sentinel before the parser
is called at all; a patch that parses to zero blocks hashes the raw string; anything that parses
to one or more blocks hashes the **joined parsed block content**, which is already smart-quote
normalized because it came from the shared segmenter. Only the middle path matches the old claim,
and it is the rarest of the three. So this entry's recipe — narrow three classes to two — was
**necessary but not sufficient**, and it named the wrong residue: a sentence narrowed to CRLF and
the read_file prefix while still saying "raw, unnormalized patch text" would have shipped a
differently-scoped error in place of the original one.

**Closed (`4f9e3744`).** The header now states what the code does: segmentation and smart-quote
normalization are shared through `parsePatchBlocks`, so the dedup key reflects normalized quotes
once a patch parses into at least one block — with the zero-blocks raw-string fallback named in a
clause rather than left implied; the prefix strip and EOL normalization remain applier-only, at
match time; and two patches differing only in those two classes are identical to the applier and
still get different dedup keys. The `smartQuoteChanged` field's shifted meaning (below) is
recorded in the same comment. **Comment-only** — verified mechanically that every changed line in
the commit sits inside a docblock; no assertion, test name, or production line moved.

**A second file carried the same pre-merge framing, and this entry never scoped it.**
`agentLoop.patchBlocksCharacterization.test.ts`'s own header described the item-16 extraction as
still *future* ("so a later extraction … is provably behavior-preserving"), named a
`toolExecutor.ts` "inline walk" that no longer exists, and listed "unnormalized smart quotes"
among the defects it deliberately pins — a class item 18 closed. Fixed in the same commit, past
tense, with the smart-quote defect dropped from the pinned list and item 2's misparse kept
(genuinely still open). Recorded inside this entry rather than as its own numbered item: it is the
same defect, the same cause, and the same commit, and splitting one comment-staleness finding
across two entries because it touched two files would fragment it for no reader's benefit — the
same reasoning item 26 used for two test files sharing one Step-9 concern.

**Where the code lives:** both header comments are at the top of
`toolExecutor.normalizationParityTelemetry.test.ts` and
`agentLoop.patchBlocksCharacterization.test.ts`. The marker's emission site is in `apply_patch`'s
handler, `toolExecutor.ts`, right after the existing smart-quote self-validation telemetry;
`hashPatchBlocks`'s three paths are in `agentLoop.ts`; the two match-time normalizations are
`stripReadFilePrefix` and `normalizeEol`, both `toolExecutor.ts`. See item 18 for the two classes
that remain genuinely open, and for what this closure changed about that entry's own text.

## 56. Closed — all six files fixed; the client-contract finding narrows the full-replace danger from real to latent

**This entry originally understated its own scope: it named one function
(`generateExecutionPlan`) and four remaining files. Both were too narrow — recorded here, not
silently widened.** `generateExecutionPlan` is one of **twelve** `createLLMClient` call sites in
this codebase (`generateFinalRunReport.ts`, `embeddings/embedFile.ts`, `llm/plannerStep.ts`,
`llm/refinePrompt.ts`, `llm/planFeature.ts`, `llm/planPatchPreview.ts`, `llm/taskClassifier.ts`,
`llm/executionPlan.ts`, `llm/planFullPatch.ts`, `roles/runDataAnalystFlow.ts`, `llm/agentLoop.ts`,
`roles/runTestEngineerFlow.ts` — one call site each, confirmed by grep this pass). A sixth
affected file was also missed (below).

**A thirteenth entry point named here was thrown out rather than qualified: it does not exist.**
This paragraph used to add `createOpenAIClient` in `llm/openaiClient.ts` as "a structurally separate
thirteenth entry point, a different function used by a different call chain." A caller sweep by
symbol, by module name, and for dynamic imports finds **no production caller at all** — every
production importer of that module takes `getModelName` or `getInferenceMode`, and the only thing
naming the function outside its own definition is a stale doc comment. The same false sentence
reached item 57 in the same commit and is corrected there too; the closure this entry records —
all six files fixed — never depended on it, so the entry stays closed.

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

**The code is less certain about itself than this entry was about it, and the difference is worth
carrying.** Directly above `TRANSPORT_TIMEOUT_MS` sits an `@unverified-probe(transport:long-request)`
annotation: the derivation and the dispatcher "are unit-tested, but no live call has yet been
observed running past ten minutes and completing… whether the vendor's edge holds a silent
connection for thirty minutes is not something Zone's configuration can establish on its own." The
reasoning is careful; what it has not had is a long-request observation. Calling the design sound
and calling its far end verified are different claims, and only the first is supported.

**The mechanism that let the error survive review, worth naming so it isn't repeated:** the file
grepped (`factory.ts`) doesn't implement the behavior being asked about — the absence of a string
in the wrong file was read as evidence of absence of the behavior in the system.

**The compounding half was described here as a coincidence. It was not one, and the correction
matters because the thirteenth essay generalizes from this sentence.** The text used to say the
asserted default "happened to equal" the configured `MIN_REQUEST_TIMEOUT_MS`. Nothing happened to.
That constant's own doc comment reads "Floor: the SDK's own DEFAULT_TIMEOUT, so small requests
behave exactly as before" — the value was *chosen to be* the SDK default, so the two were never
independent and will keep agreeing for as long as that intent holds. A reader told "coincidence"
watches for luck and stops; a reader told "deliberate alignment" knows the match carries no
information at all. **And the same number appears a third time, inside this entry's own surviving
claim below**: the OpenAI SDK's default is also 600,000 (verified in the installed package, as was
Anthropic's). Anyone auditing the OpenAI half meets exactly the configuration that misled the first
pass — no `timeout` string, and a matching documented default. Flagged here rather than left for
them to walk into.

**The same entry then produced the mirror error, one pass later and in the opposite direction —
which is what makes this worth generalizing rather than just fixing.** The correction read the
*presence* of a name in a doc comment as evidence that a call path existed, exactly as the original
read the *absence* of a string as evidence that behaviour did not. Both came from one habit: a
string search standing in for a call-graph check. The thirteenth pattern essay carries the check a
reader should run instead, in both directions; it is stated there rather than here so the two
copies cannot drift apart.

**Surviving claim, narrowed again — one live site, not two.** `src/llm/openaiAdapter.ts`
(`new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 0 })`) is the only reachable OpenAI SDK
construction; a grep for `timeout` anywhere in that file returns nothing — no constructor option,
no per-request derivation — so it relies on the SDK's own ten-minute default with no Zone-side
override at either level. **The sentence that made this two sites is thrown out.** It said
`src/llm/openaiClient.ts`'s `createOpenAIClient` was reached "via `runLlmPatchFlow.ts`'s
hosted-inference-mode path, a separate entry point from `createLLMClient`." That function has **no
production caller**. What the correcting pass actually found in `runLlmPatchFlow.ts` was a doc
comment — "Passed through to runAgentLoop → createOpenAIClient" — and the comment is itself stale:
`agentLoop.ts` calls `createLLMClient({ apiKey: input.userApiKey, provider: input.provider })`, so
the key reaches the factory and never that function. Its `new OpenAI({ apiKey })` is unreachable
today.

**What that does to the recipe, stated so it is not discovered mid-implementation.** "Set an
explicit timeout on both OpenAI construction sites" targets one live file and one dead one — half
the prescribed work executes on no path. The recipe also names two obligations it does not carry:
**no test asserts anything about OpenAI timeouts** (`anthropicAdapter.timeout.test.ts` is the only
timeout test file in the repo, Anthropic-only, ten intent tests covering the floor, the crossover,
monotonicity, the SDK ceiling, the dispatcher and the per-request derivation), so the fix would need
new tests rather than edited ones; and the stale `runLlmPatchFlow.ts` comment should be corrected by
whatever pass touches this, or it will mislead a third time.

**Not established: whether `createOpenAIClient` is dead or reserved.** Nothing in the repo states an
intent either way. Three test files mock the export, which is consistent both with a function
retained for a future hosted path and with mocks outliving the caller they were written for.
Recorded as an open question rather than resolved by assumption — deleting it is a separate pass
with its own establish.

**Why this is its own entry, not folded into item 56.** Unchanged from the original reasoning:
item 56 **was** a test-suite defect, closable by test-side mocking with zero production code
touched, and has since closed on exactly that; this entry describes something real independent of
any test, surfaced incidentally while investigating it rather than from an independent design
review — the same shape item 43 already has in this document. The present tense here outlived item
56's closure and is corrected.

**What would close it:** pick and set an explicit timeout value on both OpenAI construction
sites. Not attempted here, unchanged from the original reasoning — a docs-only pass isn't where a
production-facing timeout value should get chosen unilaterally; the value itself needs its own
establish (a real request's worst-case legitimate duration, at whatever context size and tier
this codebase's own largest real calls can reach).

**Nothing here has ever been observed, and that is recorded as a decision rather than a wait.** No
marker instruments request timeouts at all, so a sink zero on this would be uninformative by
construction rather than a measured zero — the document's own thirteenth pattern. What the sink does
carry, as upper bounds on item 73's key: two `[zone-llm-retry-attempt]` records, both `class=network`
and both on the Anthropic path, neither a timeout; and a longest recorded request duration anywhere
of 227,673 ms, roughly 3.8 minutes — 38% of the bound, and again not on the OpenAI path. That
independently corroborates the code's own `@unverified-probe` note above. The argument for a bound
is clean and the gap is real; nobody has hit it. Deferred on evidence, not on knowledge.

**Bucket, re-decided twice now: Actionable now → Blocked on data.** The earlier re-decision argued
the *kind* of fix was fully specified with only the numeric value deferred, and that narrowing the
scope made it smaller rather than less specified. Two things it did not know: the narrowed scope
included a site no path reaches, and the deferred value is not a detail but the entry's own stated
prerequisite — "the value itself needs its own establish." That is something to be learned first,
which is the exact bar "Actionable now" sets. Items 18 and 23 made this same move for the same
reason: a recipe settled in kind, a trigger never observed. It stays out of Neither for the reason
this document already recorded when contrasting it with item 59 — the *approach* is settled here,
which is precisely what item 59 lacks.

**Where the code lives:** the one live unbound construction is in `src/llm/openaiAdapter.ts`; the
unreachable one, and the open question about it, are in `src/llm/openaiClient.ts`. The stale doc
comment naming that function sits on `runLlmPatchFlow`'s `userApiKey` field, and the call it
misdescribes is `agentLoop.ts`'s `createLLMClient`. Anthropic's timeout configuration — constructor
floor, three per-request derivation sites, the dispatcher, and the `@unverified-probe` annotation —
is in `src/llm/anthropicAdapter.ts`; its only tests are `anthropicAdapter.timeout.test.ts`.

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
- **Closed (`5d01d27a`) — the system-prompt surface only.** The FINAL ASSESSMENT block that
  requests the `[ZONE_VERIFICATION]` tag was gated on `answerOnly` alone, unchanged through all
  four commits above, so a read-only-archetype run with no plan — exactly the case `dd8fb604`
  extended the summary selector to cover — received a demand for a verification tag alongside an
  answer contract whose own FORBIDDEN list bars a `## Tests` section. Confirmed live in compiled
  output for both `question` and `investigation` before the fix, not traced. The fix was the
  one-identifier shape this bullet already predicted: the same `isReadOnlyArchetype` disjunct the
  summary-contract selector twelve lines above already used, added to the verification gate's own
  condition. The predicate was already in lexical scope, so nothing was threaded and no call site
  changed. **The neighbouring explanatory comment was read and deliberately left, recorded here so
  nobody re-litigates it as stale:** its three clauses are property-based — "a run that cannot run
  a patch to verify", one dated measured instance, and the `deriveVerdict` fallback-safety
  argument — and none of them names `answerOnly` as *the* condition or claims to be exhaustive, so
  all three stay true under the widened gate. **The second surface is not closed and is not this
  one** — see item 69, which replaces the bare phrase "a second surface, still open" that used to
  end this bullet and named nothing findable.
- `deriveVerdict`'s `inferredFrom` field is `"tag"` or `"heuristic"`, a function of whether a tag
  was present, not of why one wasn't. `"heuristic"` covers two different mechanisms: a real
  inference run against the tool-call log (`trigger === "max_iterations"`), and a hardcoded default
  reached with no inference attempted at all (any other trigger). **This bullet used to end by
  claiming the payload's own `reason` field distinguishes the two. That is false. The sentence is
  deleted rather than carried with a correction appended, because it was written into permanent
  record and pushed before anyone checked it, and a reader who finds it re-derives a wrong
  conclusion.** `no_verification_attempted` reaches the payload from **four** independent origins: the
  hardcoded literal on `deriveVerdict`'s non-`max_iterations` branch; `inferVerificationFromLog`'s
  own final fallthrough (reachable only when a patch did apply, tests did not run, and no infra
  error was seen); that same function's not-patch-applied branch, which `ef9d0608` changed to this
  value and which is reachable only when a patch did **not** apply; and the model emitting it as a
  tag, which `parseVerificationTag` accepts and the max-iterations wrapup prompt offers by name.
  Among `inferredFrom: "heuristic"` records the first three collide, so `reason` cannot separate
  them; `trigger` separates the first from the rest and nothing separates the middle two.
  **This bullet counted three origins and said only the final fallthrough collides among that
  function's branches — `ef9d0608` falsified both halves, and they are corrected here rather than
  left to be re-derived.** Two of its branches now return this value, deliberately: see item 70 for
  why the not-patch-applied branch is kept explicit even though it returns exactly what the
  fallthrough returns. Compounding it, the logged
  `reason` is the **post-override** value: `validatePassedClaim`, `validateUnrelatedClaim`, and
  `applyNoInfraVerificationOverride` can each rewrite it between derivation and emission, so the
  recorded value is not the raw inference output either.
- **The telemetry this arc added does not accumulate at all, and the correction is a change in
  kind, not a narrowing.** This bullet used to say the `inferredFrom` telemetry "accumulates
  passively, by design" — which implies it accumulates somewhere readable. It does not:
  `[zone-agent-verdict-inferred-from]` (`e7b051eb`, the marker this entry's own sequence names) is
  emitted via `debugLog`, gated on `ZONE_VERBOSE_LOGS`, so no ordinary run emits the line. **This
  bullet used to add that the sink never sees it, and that half is thrown out rather than annotated
  — this bullet is itself this entry's record of a false claim reaching permanent record before
  anyone checked it, so it does not get to keep one.** The sink carries records of this marker from
  a handful of runs inside a single thirteen-minute window on 2026-08-05, when the gate was open.
  The gating fact stands; "never" does not, and the consequence is recorded in item 74, where a
  neighbouring zero was being explained by the same gate. **But the question it was added to answer
  is answerable from the sink anyway,
  which is the part worth recording rather than the routing miss.** `[zone-agent-final-assessment]`
  — on `log()`, sink-visible, and predating this arc by months — already carries `inferredFrom` on
  both of its variants, alongside a `triggeredBy` discriminant literal (`"natural_completion"` /
  `"max_iterations"`) that supplies exactly the field the bullet above establishes is the one that
  separates the two heuristic mechanisms. `inferredFrom` and `triggeredBy` together, both already
  reaching the sink, answer it cleanly. So this arc added a `debugLog`-gated marker duplicating,
  less accessibly, information a `log()`-routed marker was already recording: the gap was never in
  the instrumentation, it was in not checking what was already instrumented. One real wart does
  survive in the sink-visible marker — its two variants name the same value differently
  (`verificationReason` on the natural-completion variant, `finalVerificationReason` on the
  max-iterations one), so a sink query grouping on either name silently drops half the records.
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

**Bucket, re-decided after the first bullet closed rather than inherited.** The two sub-facts that
used to pull toward other buckets are both gone: the FINAL ASSESSMENT gate is built (`5d01d27a`),
and the "missing baseline" that read as Blocked on data was a wrong premise, not a data wait — the
baseline is derivable from a sink-visible marker that already exists. What remains is three
recorded structural facts with no fix proposed between them: a telemetry-shape finding, a routing
finding, and an unpinnable model-behavior instruction. That is Neither's own definition met
directly, not on balance — a stronger fit than before, by the same reasoning item 58 supplies.
**Stays Neither.**

**Heading unchanged, deliberately, and the convention checked rather than assumed.** A
`— partially closed` suffix would be redundant here: this heading's own second clause ("and what
they left open") already carries that signal, which no other partially-closed entry's heading does.
Checked while deciding it, because it is easy to assume otherwise: the suffix is **not** tied to a
bucket. Five headings carry it and they are spread across three different buckets, so no bucket
clusters the suffix and nothing about this entry's bucket argues for or against it. **The
per-item distribution that used to sit here is deliberately gone rather than corrected a third
time.** It named which bucket each of the five was in, which made it wrong the moment any one of
them was reclassified — twice in two consecutive commits, as items 18 and then 36 moved. The claim
that carries the argument is "spread across more than one bucket," and that survives any single
reclassification; the enumeration never could. The snapshot below is where per-item placement is
tracked, and it is mechanically checked.
The footnote under the snapshot is where partial status is tracked mechanically, and this entry is
added to it.

**Where the code lives:** `assembleAgentSystemPrompt`'s summary selector, `buildPatchSummary`, and
the FINAL ASSESSMENT block that now shares the selector's own two-disjunct condition are all in
`agentLoop.ts`. `inferredFrom` is computed in `deriveVerdict.ts` and logged from there via
`debugLog`; the sink-visible `[zone-agent-final-assessment]` is emitted from
`runCompletion/composer.ts` through `loopTelemetry.ts`'s own wrapper. The four commits' own test
changes are in `agentLoop.prompts.test.ts`, `agentLoop.brevity.test.ts`, and
`deriveVerdict.test.ts`; `5d01d27a`'s are in `agentLoop.prompts.test.ts`.

## 62. Line-anchoring the segmentation walk would fix mid-line and in-string markers, not item 2 — the benefit survived measurement, the cost accounting did not

**What it is:** while investigating item 2's prescribed fix, line-anchoring the FIND/REPLACE
segmentation walk was measured directly rather than assumed. It does not close item 2 (see item
2) or item 15 (see item 15) — but it is not therefore worthless. Two shapes it demonstrably
fixes, measured against the current walk and a line-anchored variant built from the repo's own
existing anchoring rule (the counter's line-anchored recount in `toolExecutor.ts`):
- **A marker appearing mid-line inside REPLACE content** (e.g. prose mentioning the syntax): the
  current walk truncates REPLACE at that point; anchored, the full content is preserved.
- **A marker appearing inside a quoted string inside REPLACE content:** same truncation today,
  same fix under anchoring.

**The benefit is real and stronger than this entry originally stated — re-measured against the
compiled walk, not re-read.** Both shapes produce silently **corrupt** content, not merely
truncated content, and that distinction is the whole severity argument. A mid-line marker inside
a comment (`const a = 2; // see --- FIND --- docs`) yields a `replace` of `const a = 2; // see `
— the comment cut mid-sentence and every following line dropped. An in-string marker
(`const s = "--- FIND ---";`) yields `const s = "` — an unterminated string literal. Both are
written to disk as a success. "Truncates REPLACE at that point" undersold this.

**This entry equivocated between two different anchoring rules, using the permissive one to claim
the benefit and the strict one to claim the cost, while calling both "the repo's own rule". The
false sentences are deleted rather than annotated.** The repo's own rule — the line-anchored
recount this entry cites by name — is `/^[ \t]*--- FIND ---[ \t]*$/gm`: it **tolerates leading
whitespace** by construction. The entry's benefit paragraph correctly says its variant was "built
from the repo's own existing anchoring rule"; its cost paragraph then said "**Strict** anchoring
against that example's own indentation produces zero blocks." Both cannot describe one variant.
Measured under the repo's own permissive rule, an indented block yields **one clean block**; only
a strict column-zero rule, for which this repo has no precedent anywhere, yields zero.

**Two of the three cost bullets were wrong, and the third is inverted — each re-measured against
the real compiled walk:**
- **The "prompt contradiction" was backwards.** Under the permissive rule an indented example
  parses *better* than it does today: the current walk absorbs the marker line's own indentation
  into the block, yielding `find` = `"  const a = 1;\n  "` — a trailing newline-plus-spaces that
  cannot match any real file — where the anchored walk yields a clean `"  const a = 1;"`. The two
  indented prompt examples were therefore never a cost of anchoring; they were a live defect under
  the walk that already exists. That defect is now fixed — see item 71.
- **The characterization-test inversions do not occur.** All four fixtures this entry named —
  the `FF`-shaped test, the CRLF test, item 2's own embedded-pair fixture, and the one-newline-trim
  test — produce **byte-identical output** under the current walk and under the repo's-rule
  anchored variant. The CRLF case specifically was predicted to "resist a drop-in fix" with "a
  stray trailing `\r` surviving into `find`"; it does not, because JavaScript's `m`-flag `$`
  already treats a bare `\r` as a line terminator and the existing one-newline trim removes the
  `\r\n` cleanly. No test needs inverting.
- **The real cost was never on this entry's books, and has since been removed.** The one shape
  anchoring genuinely rejects that the current walk accepts is the **inline single-line form** —
  `--- FIND --- code --- REPLACE --- code` on one line — which yields zero blocks under *both*
  anchored variants, permissive and strict alike. That form was what `apply_patch`'s own tool
  description taught, on every request, via the schema. Item 71 rewrote it to block form, so this
  cost no longer exists at HEAD either.

**What this leaves, restated honestly.** After item 71, all three of this repo's block-shaped
teaching examples parse to identical, correct output under the current walk, the permissive
anchored rule, and strict column-zero alike — verified against the real emitted strings, not the
source. So anchoring's prompt-side cost is now **zero**, and its test-side cost was always zero.
The two costs that remain are genuine but proportional to the defect's own rate: the telemetry
markers below and `hashPatchBlocks`'s dedup key only shift for patches that actually contain a
mid-line or in-string marker — which is exactly the corrupt population, and the sink shows no
evidence that population is non-empty (see item 63's own accumulation problem, and item 71's
closing note). Anchoring is now a cheaper change than this entry claimed and a better-evidenced
one, and it is still **not decided** — because "cheap and correct" is not the same as "needed",
and nothing measures how often the trigger occurs.

**The remaining cost, unchanged and still real:**
- **Four telemetry markers whose recorded meaning shifts** because block boundaries move:
  `[zone-apply-patch-marker-split]` (`blockCount` and its own `isMultiBlockPatch` gate),
  `[zone-apply-patch-normalization-parity]` (`blockCount`, `eolChangedBlocks`,
  `prefixStrippedBlocks` — CRLF-normalizing at segmentation would drive `eolChangedBlocks` toward
  zero permanently), `[zone-self-validation]` (`findOccurrences`/`replaceOccurrences`,
  redistributed across different block boundaries).
- **`hashPatchBlocks`'s dedup key changes** for CRLF-bearing, `FF`-shaped, trailing-whitespace,
  indented, and inline-marker patches. Degrades gracefully across a resume, checked directly: the
  hash is persisted in `RunEnvelope.failureHistory[].records[].patchHash` and compared only for
  equality (`antiThrash.ts`) — a stale hash meeting a fresh one produces a missed repeat-failure
  detection across the resume boundary, never a false one.

**Found while investigating item 2's prescribed fix, not from an independent review** — the same
circumstance items 43 and 59 already record for other facts. Whether this robustness is worth its
cost on its own merits is a separate decision this pass doesn't make.

**Bucket, re-decided after the correction rather than inherited, and the obvious precedent only
half fits.** Item 2 looks like the match — another entry whose prescribed fix died under
measurement — but the two failed in opposite directions, and conflating them would teach the wrong
lesson. Item 2's measurement was *correct*, and it is what killed item 2's own earlier recipe:
the process working. This entry's measurement was *wrong*, and the error was equivocation between
two variants of the thing being measured. What they share is only the outcome (a recipe that did
not survive), not the mechanism. The bucket is unchanged for a plainer reason: no fix is specified
here, the decision is still open, and nothing about the correction changes that. **Stays Neither.**

**Heading corrected, not suffixed.** It used to end "at a measured cost" — the clause this entry
got wrong. Dropped rather than qualified, per this document's own convention for a false claim in
a heading.

**Where the code lives:** the walk is `segmentPatchBlocks` in `src/utils/patchBlocks.ts`; the
existing anchoring precedent is the recount in `toolExecutor.ts`'s marker-imbalance branch, whose
regex is the permissive rule this entry mis-stated; the four telemetry markers are emitted in
`toolExecutor.ts`; `hashPatchBlocks` and `RunEnvelope.failureHistory` are in `agentLoop.ts` and
`src/api/diskRunEnvelope.ts` respectively. The two prompt examples this entry used to cite as a
cost are `PROVIDER_AGNOSTIC_HARDENING` and the `apply_patch_marker_imbalance` coaching case, both
in `agentLoop.ts` — both de-indented by item 71, so neither reads as this entry once described it.

## 63. Whether to build item 17's structured argument is blocked on tool-argument parse-failure data that doesn't exist yet

**What it is:** item 17's own correction found the format-ambiguity defect (item 2) can only
close by replacing `apply_patch`'s delimited `patch` string with a structured argument, not by
adding one alongside it. That trade moves the escaping/malformation risk from a measured parser
defect (item 2's own trigger, characterized and pinned) to an unmeasured one: a structured
argument's own JSON encoding, on a path where nothing enforces the schema server-side — `strict`
is dropped entirely in the Anthropic tool-schema translation, so a malformed or truncated tool
call reaches Zone's own `JSON.parse`, not a provider-side rejection.

**The instrument this decision needs already exists and is now switched on.**
`[zone-tool-args-parse-failed]` fires whenever a tool call's arguments fail to parse, carrying
`tool` (which tool), `argsLen` (the raw argument string's length), and `parseErrorClass` (a
closed five-value label classifying the parse failure by shape — never the raw message, which
can itself embed a snippet of the input for one failure shape). Previously emitted via
`debugLog`, gated on `ZONE_VERBOSE_LOGS`, so it never reached the marker sink in ordinary use —
fixed in `03ee0b7e`, now on `log()`, reaching the sink like every other accumulating marker.

**No data has accumulated yet — recorded here so the question isn't re-asked before the marker
has had time to fire.** The fix landed this session; nothing has run against it in the wild.

**What would close it — a threshold, a review point independent of hitting it, and what a null
result means; items 1 and 4, the precedent for a data-wait entry, establish only the first of
these three, and only one of them does even that.** Checked directly before writing: item 4
states a threshold ("roughly 10-20 real records," explicitly marked as an order-of-magnitude
estimate, not a defensible rate); item 1 states none — its own "what would close it" is a
choice among three design options, not a record count. Neither states a review point
independent of the threshold, and neither states what a null or near-null result would mean.
This entry follows item 4's threshold directly rather than inventing a new number with no
better basis, and establishes the other two conventions fresh, since no existing entry has them:

- **Threshold:** roughly 10-20 `apply_patch`-specific `[zone-tool-args-parse-failed]` records —
  item 4's own magnitude, reused rather than re-derived, since there's no stronger basis in this
  repo for a different number. Enough to tell "doesn't happen" from "happens sometimes," not a
  rate precise enough to schedule against.
- **Review point, independent of the threshold:** review this entry after roughly 50 real runs
  of ordinary dogfooding — the same scale as item 4's own 45-run sample, the only run-count
  figure this repo has actually measured — whether or not the threshold above has been reached
  by then. A threshold with no checkpoint has no way to distinguish "still accumulating" from
  "won't be answered this way, at least not on this marker alone."
- **What a null or near-null result means, stated explicitly so a future pass doesn't read zero
  records as "still waiting":** if the marker has fired rarely or not at all by the review
  point, that is not a stalled entry — it is the answer. It would mean tool-argument parse
  failures are rare enough in ordinary use that the encoder-risk side of item 17's tradeoff is
  small, which is itself the input item 17's decision needs, not an absence of one.

**Where the code lives:** the marker's emission site is in `agentLoop.ts`'s tool-call parsing
loop; `classifyJsonParseError` is defined just above it. See item 17 for the decision this data
feeds.

## 64. Closed — `hashPatchBlocks` collapsed every no-patch `apply_patch` failure to the same dedup hash

**What it was:** `hashPatchBlocks` read `String(args?.patch ?? "")`, so any `apply_patch` call
missing the `patch` argument hashed the empty string — a fixed value regardless of which other
arguments were present. Live today, not hypothetical: `apply_patch`'s schema declares `patch`
required, but `strict` is dropped entirely for Anthropic (see item 63), so nothing server-side
stops a model from omitting it. `toolExecutor.ts`'s own handler falls through the same way,
reaching the real, reachable "No valid ... blocks found in patch" rejection — fixed text, so
`classifyFailure` maps every instance to the identical `apply_patch_no_valid_blocks` trigger
regardless of file or intent. Two unrelated no-patch failures on the same file were
indistinguishable from a genuine retried patch.

**Exactly two comparison sites existed, confirmed by a repo-wide sweep, not assumed from one.**
`antiThrash.ts`'s `detectFailureStall` (Verdict 1) and `agentLoop.ts`'s `detectRepeatedFailure`,
which feeds `CoachingController`'s primary coaching decision directly. Swept every
`patchHash`-to-`patchHash` comparison in the repo three independent ways (direct `===`/`!==`,
every occurrence of the field, the shared verdict string) — same two sites each time. No third
site in a worker, subagent, or extension path: subagents recurse through these same functions
rather than reimplementing them.

**Fixed (`7eb1ffaa`):** `hashPatchBlocks` now returns a sentinel (`NO_PATCH_HASH_SENTINEL`,
`"no_patch"`) for an empty/absent patch instead of hashing it — an honest "nothing to compare"
value, not a manufactured hash, scoped to `patch === ""` specifically so non-empty garbage text
(which already hashed distinctly) is unaffected. Both comparison sites exclude it explicitly.
Mutation-tested independently: removing either site's guard fails only that site's own test, not
the other's.

**A prior claim on this same investigation was wrong, corrected here rather than left
standing.** The establish that found this collision also claimed `antiThrash.detectFailureStall`'s
`trigger_repeated_3x` fallback would still catch three or more same-file no-patch failures "on
trigger alone." Re-reading the actual code found that verdict has its own precondition —
`last.trigger !== prev.trigger` — which a consecutive run of identical-trigger failures never
satisfies, at any count. The fallback only reaches a narrower, interleaved shape (the trigger
recurring with a *different* trigger between occurrences).

**The behavior outcome, once that correction is accounted for.** `detectRepeatedFailure`'s own
fallback (`same_trigger_repeated_2x`) has no such precondition — it fires at exactly two records
regardless — and `CoachingController.routeFailure` doesn't branch on which repeat reason fired;
both route to the identical `apply_patch_repeated_failure_same_file` trigger. So the primary
coaching path is unaffected in timing or content by this fix. `antiThrash`'s own reflection
nudge, for the realistic straight-run case, now produces no signal at all — a real, deliberate
change, but not a loss of coaching: the model still gets coached at the same iteration, just via
the mechanism that was always going to catch it.

**Where the code lives:** the sentinel is defined in `antiThrash.ts`, imported by `agentLoop.ts`
(the safe direction — `agentLoop.ts` already imports values, not just types, from
`antiThrash.js`). `hashPatchBlocks` and `detectRepeatedFailure` are in `agentLoop.ts`;
`detectFailureStall` is in `antiThrash.ts`. See item 18 for the dedup hash's other, unrelated
open defect — normalization-class divergence, not this collision, approaching from the opposite
direction (missed detections there, a false one here).

## 65. Fifteen tool properties are "fake-optional" (nullable + required) — the split was scoped to that set, and the strongest bounds candidate sits outside it

**What it is:** a nullable-typed property (`type: ["X","null"]`) listed in `required` still
obligates the model to emit a key on the Anthropic path (the default provider) —
`translateTools` casts `fn.parameters`, including `required`, wholesale into `input_schema`,
while `fn.strict` is never read at all. Fifteen properties across nine tools have this shape:
`run_command.cwd`, `kill_background.signal`, `read_background_output.{since_offset,max_bytes}`,
`run_command_background.{cwd,label}`, `read_file.lineRange`,
`list_files.{pattern,include_ignored}`,
`apply_patch.{intent,scope,scope.symbolKind,scope.className}`, `multi_edit.wholeWord`,
`search_in_files.fileGlob`. Confirmed by enumerating the real, compiled schema, not by reading
source in isolation.

**The schema-layer protection count this investigation started with was wrong before any fix
landed, corrected here rather than carried forward.** Two properties were originally said to be
protected — `kill_background.signal` by `enum`, `read_file.lineRange` by `minItems`/`maxItems`.
Re-enumerating for this entry found `apply_patch.scope.symbolKind` already had an enum too
(`["function","arrow","method","class","export_default","any",null]`), uncounted the first
time — three were protected before this session's own fix to this class, not two.

**The provider table — the load-bearing finding.** `strict` reaches almost no provider:
- **Anthropic (default):** dropped entirely — `translateTools` emits only
  `name`/`description`/`input_schema`.
- **OpenAI Responses (`gpt-5.x`):** explicitly overwritten to `null` in
  `responsesConvertParams`, regardless of what the tool declares.
- **OpenAI Chat Completions (non-gpt-5 OpenAI):** passed through unchanged — the only path
  where it does anything, reachable today only by `gpt-4o`/`gpt-4o-mini`.

**Handlers already carry the validation — the schema looseness produces no wrong behavior.**
Every one of the fifteen normalizes an empty/null value explicitly: an `""`/null/undefined
check resolving to a stated default (`run_command.cwd` → repoPath via `resolveRunCommandCwd`;
`list_files.pattern` → `"**/*"`), or an allowlist falling through to a safe default
(`kill_background.signal`, `apply_patch.intent`). None trusts the schema to have done the
validation. One dogfood report during this investigation — `read_file` rejecting a call with an
invalid range — is a live instance of exactly this: `lineRange` is both fake-optional and one of
the schema-protected three/four above, and the handler carries its own redundant check besides
(`!Array.isArray(lineRange) || lineRange.length !== 2`, then `start > end`) — already covered by
this entry, not a new finding.

**The measurement that decided against a per-provider schema divergence.** Carrying the
null-valued keys costs roughly 3-10 tokens per call (measured on five representative minimal
calls: `read_file` +17 chars, `list_files` +38, `run_command` +11, `multi_edit` +17,
`apply_patch` +27). Against that: `translateTools` is a single wholesale cast with no hook for a
per-provider transform — diverging the schemas means building one. The cost doesn't justify the
build.

**The `strict: false` precedent, and its own measured regression — the strongest argument
against the obvious alternative.** `search_in_files` is the one tool already declared
`strict: false` (`69920ff6`, added deliberately "to allow forward-compat" for newly-added
optional fields). The repo already recorded the cost, not just the theory:
`toolCallIdentifyingArg.ts`'s own comment states the API "never enforces its required `pattern`
field, so the model can and does omit it" — the one field on that tool that actually matters.
Dropping `strict` buys genuine optionality at the cost of losing enforcement on what's genuinely
required, empirically, not hypothetically.

**What's worth doing instead, and it's free.** `enum` and bounds constraints (`minItems`,
`minimum`/`maximum`) survive translation to every path exactly like `required` does — three of
the fifteen already had this kind of constraint before this investigation touched anything, and
item 66 makes a fourth.

**The remaining eleven, split against the real code rather than reasoned from the names — two
qualify, nine genuinely don't. Both of the two are resolved now, and neither resolution was a
schema addition.**
- **`read_background_output.max_bytes` — resolved as not worth building.** The handler clamps
  unconditionally to `Math.min(Math.max(1, input.maxBytes ?? 8192), 65536)`
  (`backgroundProcessRegistry.ts`), a fixed floor and ceiling independent of any runtime state,
  so `minimum: 1, maximum: 65536` would match it exactly. What that misses: the parameter's own
  description already carries the bound in prose — "Max bytes to return. null = 8192. Cap
  65536." — and `65536` has no named constant anywhere in `src/`, existing in production exactly
  twice, as the clamp literal and as that sentence. A schema literal would be a third
  uncoordinated copy of an unnamed bound, telling the model nothing it is not already told.
  Documentation-only, and the documentation already exists.
- **`read_background_output.since_offset` — the premise was false, and what it framed as an
  unclaimed tightening was a live defect.** This entry read the handler's comparisons against
  `proc.ringWritten` and `RING_CAP` and concluded that a floor was merely "defensible." Measured
  against the compiled registry rather than read: neither of those comparisons is a floor, and
  the branch that actually consumed a caller-supplied offset had no lower bound at all. A
  negative offset returned empty output under `success: true` and `truncated: false` while data
  existed. That is item 72, and it closed as a handler fix, not a schema addition.
- **Free-form paths/strings, no closed set (six):** `run_command.cwd` and
  `run_command_background.cwd` (same shape — any valid relative or absolute path),
  `run_command_background.label` (any human-readable string), `list_files.pattern` and
  `search_in_files.fileGlob` (glob patterns, effectively unbounded), `apply_patch.scope.className`
  (any class identifier).
- **Booleans where both values are meaningful, already as narrow as their type gets (two):**
  `list_files.include_ignored`, `multi_edit.wholeWord`.
- **`apply_patch.scope`** (the wrapping object itself, one) — not a scalar, so enum/bounds
  doesn't apply the same way; already `additionalProperties: false` with its own `required`
  list, as constrained as an object-typed parameter gets under this framing.

**The claim that closed this split — that constraining the two above "tightens the contract on
every provider at zero cost" — is thrown out rather than annotated.** Neither turned out to be
worth constraining, and the reason had nothing to do with providers: both bounds were already in
the parameter's own prose. The provider half would not have survived scrutiny either, because
reaching the model and being enforced are different things and the table above establishes only
the first. Anthropic drops `strict` entirely and Responses forces `strict: null`, so a bounds
keyword is advisory on both — but `read_background_output` declares `strict: true` and the Chat
Completions path spreads the request wholesale, so `strict` does survive there, and whether
OpenAI enforces numeric bounds under it is **not establishable from this repo**. Where a property
has no closed set — the other nine — nothing here proposes a fix either.

**The principle this entry states is about a class; the survey it ran covered one set.** "`enum`
and bounds constraints … survive translation to every path exactly like `required` does" is a
claim about schema keywords, true of any property on any tool. What was actually surveyed is the
fifteen fake-optional (nullable and listed in `required`) properties this entry is named for.
`search_in_files.context_lines` is nullable but **not** in `required: ["pattern", "fileGlob"]` —
genuinely optional, therefore never among the fifteen, therefore never considered here or
anywhere else in this document. It is a stronger bounds candidate than either of the two above on
every axis this entry uses. Its handler fixes both bounds — `Math.max(0,
Math.min(Math.floor(args.context_lines), 10))`, floor and ceiling both literal and independent of
any runtime state — and it additionally floors non-integers for a property the schema already
types as `integer`, meaning the handler does not trust the declared type, not merely the absent
bounds. It also sits on the most-invoked tool in the sink, while the two properties this entry
did name sit on a tool with no recorded invocations at all. **This census has now been corrected
twice, and the second correction is the instructive one.** It first stated raw sink records as
calls. The first correction deduplicated them and gave 72 across five tools — still too high,
because it keyed on exact record identity, which only catches duplicate pairs written in the same
millisecond and misses the ones a millisecond or two apart (item 73). Re-derived on that entry's
corrected key, the complete tool-call record is **64 calls across five tools** — `search_in_files`
30, `read_file` 23, `run_command_readonly` 6, `apply_patch` 4, `run_command` 1. The ordinal claim
survived both corrections and so did the zero: `search_in_files` is still the most-invoked by a
clear margin, `read_background_output` appears nowhere in the record, and the string "background"
appears on no line of the sink at all. Only the absolute numbers were ever wrong, and they were
wrong in the same direction both times — too high, never too low.

**It is still not worth building, and that is the actual finding.** By this entry's own
resolution of `max_bytes` above, `context_lines` dies the same death: its ceiling is already in
prose — "Lines of context before/after each match. Default 2. Max 10." — `10` has no named
constant either, and `maximum: 10` would be the third copy. Two candidates on opposite sides of
the fake-optional boundary resolve identically, for a reason that never once referenced
fake-optionality. The boundary this entry surveyed was orthogonal to the question it asked.
Nothing here proposes a fix; the scope mismatch is the answer, not a direction to chase further.

**Whether any model has ever sent an out-of-range value for any of these is not answerable, and
that is absence of instrumentation rather than absence of events.** Neither clamp emits anything:
`read()` contains no logging call at all, and the `context_lines` clamp has none either. The only
clamp-named marker anywhere in `src/` is `[zone-effort-clamped]` — CLI effort resolution, not a
tool argument — and it has zero sink records too. The three validation-named markers that do have
records are `[zone-self-validation]` (whose rule is `read_before_patch`), its run summary, and
`[zone-apply-patch-syntax-validation]`; none of the three is tool-argument validation. This
document's thirteenth pattern is the standing warning against reading that silence as a
behavioural fact.

**Where the code lives:** `translateTools` is in `convertParams.ts`; the `strict: null` forcing
is in `responsesConvertParams.ts`; the fifteen properties and their handler normalization are in
`toolDefinitions.ts`/`toolExecutor.ts`; `read_background_output`'s clamp is in
`backgroundProcessRegistry.ts`; the `strict: false` precedent and its comment are in
`toolDefinitions.ts` (`search_in_files`) and `toolCallIdentifyingArg.ts`; `context_lines`'s
schema is in `toolDefinitions.ts` and its clamp in `search_in_files`'s handler, `toolExecutor.ts`.
See item 72 for the defect the `since_offset` candidate turned out to be sitting on.

## 66. Closed — `apply_patch.intent` gained an enum

**What it was:** found while investigating item 65 — `intent` was one of the fifteen
fake-optional properties, with no enum despite both the tool's top-level description and the
parameter's own description enumerating exactly three values in prose.

**Fixed (`e53d2b98`):** `enum: ["add","modify","delete",null]` added, matching
`kill_background.signal`/`scope.symbolKind`'s existing shape (enum alongside the nullable union,
not instead of it). Handler allowlist left in place. The now-redundant trailing clause in the
top-level description was dropped (288 → 245 chars, cap `<300`) — verified before trimming that
parameter-level descriptions actually reach the model on the Anthropic path (traced
`input_schema` end to end through `translateTools`, the cache-control mapping, and the live SDK
call — nothing strips nested structure anywhere on that path).

**What makes the change safe rather than load-bearing, confirmed by mutation, not reasoned.**
Changing the handler's fallback so an unrecognized `intent` passes through instead of becoming
`"add"` was mutation-tested directly — no test failed. Tracing why: no code path checks
`intent === "add"` specifically, only `=== "delete"`/`=== "modify"`, so "becomes literally add"
and "stays whatever unrecognized string was sent" are behaviorally identical everywhere in the
handler. What's pinned is the safety property (unrecognized intent gets the strictest
treatment); the fallback's literal target value is not independently observable or pinned.

**Where the code lives:** the schema is in `toolDefinitions.ts`; the handler allowlist is in
`toolExecutor.ts`; the pinning tests are in `toolExecutor.applyPatchIntentEnum.test.ts`.

## 67. `search_in_files` carries both `fileGlob` and `glob`, and neither is enforced

**What it is:** `fileGlob` (fake-optional: nullable, in `required`) and `glob` (genuinely
optional, described as "Alias for fileGlob") both exist on the same tool. The handler reads
`args.glob ?? args.fileGlob`. Looks like an incomplete migration — `glob` added as the
preferred/newer name without `fileGlob` being retired — and `search_in_files`'s own
`strict: false` (item 65) means neither is enforced at the schema level regardless: the model
can omit `fileGlob` (already established to happen for `pattern` on this same tool) or supply
both with conflicting values, silently resolved by `??` precedence.

**What would close it:** decide whether `fileGlob` should be deprecated/removed now that `glob`
exists, or whether both are meant to stay — not decided here.

**Where the code lives:** both properties are in `toolDefinitions.ts`; the resolution is in
`toolExecutor.ts`'s `search_in_files` handler.

## 68. `apply_patch.scope`'s empty-`symbolName` rejection message renders the empty string literally

**What it is:** `scope.symbolName` is a required string with no `minLength` — a schema-valid
call can supply `""`. Probed directly against the compiled symbol locator: an empty or
whitespace-only name resolves to `{ok:false, reason:"not_found"}`, matching a real symbol name
resolves normally. Fails safe — a rejection, not a wrong write. The only defect is cosmetic: the
rejection message interpolates the empty string directly, rendering as `Scope symbol '' (kind:
any) not found in <file>.`

**What would close it:** special-case an empty/whitespace `symbolName` before the locator call,
with a message naming the actual problem ("scope.symbolName was empty") instead of rendering
nothing between quotes.

**Where the code lives:** the message is in `apply_patch`'s scope-handling branch,
`toolExecutor.ts`, in the `not_found` case.

## 69. Closed — the max-iterations wrapup gained a third arm, so a run that was never offered a write tool is no longer asked to verify tests

**What it was:** the second surface of the defect item 61's first bullet closed. When the iteration
loop exhausts, `runAgentLoopScoped` appends a final no-tool assessment message asking for a
`[ZONE_VERIFICATION: <reason>]` tag. That request was gated on a **locally recomputed** `answerOnly`
— derived from `isAnswerOnlyPlan(input.executionPlan)` at the wrapup site itself, mirroring the
system-prompt call site's own derivation — and on nothing else. It never read `archetype` or
`planApproved`. `5d01d27a` did not touch it: that commit widened the system prompt's gate only, so
a read-only-archetype run that exhausted its budget was still asked, on its closing turn, for one
of six test-outcome values.

**Why the system-prompt fix cannot reach it, and why that is structural rather than an oversight.**
The system prompt is assembled once per run, before the iteration loop opens, and is byte-stable
across the whole run because it sits inside the Anthropic cached prefix. Any archetype-keyed prompt
gate is therefore decided at run start. The wrapup message is a separate `role:"user"` message
appended after the loop ends — a different string, built at a different time, from a different
local. One gate cannot cover both.

**The fix's shape was constrained by an existing test rather than by taste, and that held.**
`terminationReasonProbe.test.ts`'s CONTRAST case — *"a normal exhausted run still gets the
verification tag instruction"* — runs with a classification whose archetype is `investigation`
**and** a `preGeneratedPlan` carrying one real step, which `runLlmPatchFlow` turns into
`planApproved: true`. A predicate written `planApproved`-aware leaves that test passing, because an
approved plan with steps nets the effective archetype to undefined; a predicate written on the bare
archetype field flips it. It is the one test in the tree that pins this exact message's content, and
the mutation dropping the plan condition killed exactly it and nothing else.

**Closed by `29230a1b`, as a third arm rather than a mirrored gate — and the structure is why.**
The message was a single `answerOnly ? A : B` conditional with the tag demand *and* the
framework-hint string welded into its else branch, so there was no room to keep the summary framing
while dropping the tag; mirroring the system prompt's own gate would have handed this population the
answer-only arm's short-answer contract, which is a different contract for a different population.
The third arm gives a read-only-archetype run a summary contract plus an explicit tag prohibition —
explicit rather than silent, because the existing answer-only arm is explicit and a bare omission
invites the model to emit a tag from habit. The `answerOnly` arm and the tag-demanding arm are both
byte-unchanged.

**The derivation is duplicated rather than shared, and the justification expires.**
`effectiveArchetype`/`isReadOnlyArchetype` are re-derived at the wrapup because
`assembleAgentSystemPrompt`'s own copies are locals inside that function and unreachable from
`runAgentLoopScoped`, and because the neighbouring `answerOnly` local already established that
precedent for exactly this situation. **That is a site-count argument, so it has an expiry: a third
consumer of this predicate is the trigger to extract a shared helper**, at which point all three
sites should move together. Recorded here rather than in the code comment because the comment
carries only the structural half — see item 12's closure for the same split.

**What actually changed, stated narrowly.** For a read-only-archetype run with no approved plan that
exhausts its budget, the verdict now comes from `inferVerificationFromLog`'s inference instead of a
model-supplied tag, landing on `no_verification_attempted` — the value `ef9d0608` made correct for
exactly this shape — and `patchValidatedByAgent` goes from a false `true` to `false`. **Neither
reaches a rendered surface:** `printResult` renders only `warnings` and `decisionMode`, and the
headless JSON envelope carries neither field, taking its `summary` from `decisionMode`/`finalState`.
The payoff is a telemetry field, not anything a user sees.

**A coverage limitation of the harness, not of the fix, recorded so the passing block is not
mistaken for coverage of the gate.** No test pins the prompt-to-verdict causal chain. The outcome
assertion `29230a1b` added passes against unmodified source — verified by running it before the fix
rather than inferred — because the probe file's own `beforeEach` returns the same tool-call response
to every completion call including the final assessment, so the assessment text stays at its
untagged default no matter what the prompt demanded. The block is named for what it actually pins,
the untagged-response path, which the tree genuinely lacked. Pinning the chain itself needs a
prompt-sensitive mock, which is a test-infrastructure change nobody has scoped.

**The coupling that made this its own entry is discharged.** Closing this surface removes the
last prompt-level demand for a tag on the max-iterations path for read-only runs — checked rather
than assumed, since the test-failure coaching also carries tag instructions, but it raises
`test_failed` only on the exact tool name `run_command`, which declares `fs.write` and is therefore
excluded from every read-only capability set. With no tag, `deriveVerdict` falls to
`inferVerificationFromLog` — and while item 70 was open, what that returned for a run with no write
tool was `tests_failed_by_patch`, so closing this surface first would have un-masked a live defect
rather than completing item 61. **`ef9d0608` closed item 70: that branch now returns
`no_verification_attempted`, correct for every population reaching it.**

**Un-masking is harmless, but the route this entry gave to that conclusion did not cover the case,
and the route is corrected rather than left standing.** It reasoned that the branch item 70 fixed
was what this surface masked. Two consumers are reached only when the tag is absent, not one. The
second is `deriveAgentVerificationSummary`'s fallthrough, whose every named arm keys on a
tag-supplied reason, so `no_verification_attempted` falls through to a pair of arms that both name a
patch or an error — and since `finalizeRun` reports failure on this trigger unconditionally, the
note this population now gets says the run encountered errors during execution, which is false for a
run that merely exhausted its budget. **It is harmless because nothing renders it, not because it is
correct** — see item 76, which owns the missing arm. **The falsifier, precisely:** any reader
appearing for that note or for the verification reason on a rendered surface. Today `printResult`
renders only `warnings` and `decisionMode`, and the headless envelope carries neither. This is the
sixteenth pattern's own shape, one commit after that essay was written — see there.

**Closed, and the heading rewritten on item 70's precedent.** The suffix-dropping pair (items 32 and
56) does not apply here — both governed entries carrying a `— partially closed` suffix, and this
entry never had one. Item 70 is the matching case: no suffix, Neither bucket, closed by taking the
`Closed — ` prefix and rewriting the whole heading around the resolution rather than the defect.
**The footnote is untouched, checked rather than assumed:** the 32/56 rule is about members leaving
on closure, and this entry was never a member of it.

**The bucket history is worth one line, because this entry passed through Actionable now without
ever resting there.** It was moved Neither → Actionable now as a consequence of `ef9d0608`, on the
coupling's discharge rather than on any change to its own analysis, and closed one commit later. The
Neither placement it left had been argued as item 59's shape — "the approach itself is still open" —
which was wrong even then: the approach was specified; what was open was whether applying it was
correct before item 70 was decided.

**Where the code lives:** the wrapup message, its local `answerOnly`, the mirrored
`effectiveArchetype`/`isReadOnlyArchetype` pair, and the three-armed instruction text are all in
`runAgentLoopScoped`'s post-loop max-iterations block, `agentLoop.ts`; the gate they mirror is in
`assembleAgentSystemPrompt`, same file. The pinning tests are in
`runLlmPatchFlow.terminationReasonProbe.test.ts` — the CONTRAST case for the tag's retention, and
two blocks added by `29230a1b`. See item 61 for the surface that did close, item 70 for the branch
this one's closure routes to, and item 76 for the note it exposed.

## 70. Closed — the broken-tests verdict for a run that had no write tool, and why the branch that replaced it cannot be tested

**What it was:** `inferVerificationFromLog` derives `patchApplied` from `didApplyPatch`, which
requires a **successful** `apply_patch`, `write_file`, or `multi_edit` entry in the tool-call log. A
read-only run is offered none of those tools by construction, so `patchApplied` was always false for
it. Every earlier branch of the function is gated on `patchApplied` being true, so control reached
the bare `if (!patchApplied)` check and returned `tests_failed_by_patch` — tests failed because of
your patch — for a run that could not have written anything.

**Fixed (`ef9d0608`):** that branch returns `no_verification_attempted`. The population is wider
than the read-only archetype this entry was written around — the branch fires on
`patchApplied === false` however that arose, so it also caught runs whose every write failed,
`multi_edit` runs that matched nothing, and empty or read-only tool logs — and the new value is
correct for all of them, which is what made a single change sufficient.

**What the deciding pass settled, and why it made the decision possible rather than merely
informing it.** Two findings, each checked against the code rather than argued. First, the verdict
was false for **every** population reaching the branch, on two independent counts: the branch fires
exactly when no write tool succeeded, so no patch was applied and none could have caused anything;
and it never consulted `testsRan`, so it asserted a test failure on runs where tests never ran.
That ruled out narrowing the guard — there was no sub-population the old value described correctly,
so the answer had to be a different value, not a smaller branch. Second, nothing branches on the
value for control flow: `runLlmPatchFlow`'s reason-to-decision mapping returns `safe_to_apply` for
this reason and for its neighbours alike, and `patchValidatedByAgent` is false for the old value and
the new one, so no gate, retry, or escalation moves. What changed is a warning line the CLI prints
and a value recorded in telemetry.

**The replacement branch is documentation, not behaviour, and that is deliberate.** It returns
exactly what the function's own final fallthrough returns, so deleting it or inverting its guard
changes no input's output — a `patchApplied === false` case that stops reaching the explicit branch
falls straight through to a fallthrough returning the identical string. **No test can pin it**, and
the guard-inversion mutation survives by construction rather than for want of coverage; that was
predicted before running and confirmed across the verdict, `deriveVerdict`, and log-utils suites.
It is kept explicit because every other terminal case in that function is spelled out by its own
named condition, and because a reader tracing this run shape should find it named rather than
reconstruct it from two failed guards and a fallthrough below them. The comment on the branch
carries that reasoning to whoever runs the next dead-code sweep, since a sweep has every mechanical
reason to remove a line no test defends. The tenth pattern already states the general form: a
mutation surviving is not automatically a coverage gap when survival is the predicted outcome for
that mutation's shape.

**The old value is not dead, which is worth stating because a closed entry invites the assumption.**
Three producers survive untouched: `parseVerificationTag` still accepts it as one of eight tag
literals, so a model-supplied tag still yields it; `validateUnrelatedClaim` still demotes to it on
its own condition; and `deriveRuntimeVerificationReason` in `runLlmPatchFlow.ts` — an unrelated
function keyed on a `code_failed` verification status — still returns it. This entry never claimed
otherwise and no finding here rested on the branch being its only producer.

**Reachable, not theoretical — the fast-paths that look like they would prevent it do not fire.**
`finalizeRun` has two read-only fast-paths that return before `deriveVerdict` runs, both hardcoding
`no_verification_attempted`. Both are keyed on **mode** (`isReadOnlyMode`, itself derived from
`mode === "chat" || mode === "investigate"`), never on archetype. `agentLoop.ts` already carries a
warning comment recording the consequence in its own words — read-only pipelines strip write tools
but never touch mode — and every `runLlmPatchFlow` call site in `dispatch.ts` passes a patch mode
literally. So a read-only-**archetype** run reaches `deriveVerdict` normally, and this branch with
it.

**Masked while it was open, by the surface item 69 describes — and that masking no longer has to
hold.** The max-iterations wrapup demands a tag, so the model usually supplied one and the
inference path was not taken; while this entry was open, that was the only thing standing between
the branch and a read-only run's recorded verdict, and closing item 69 first would have converted a
suppressed defect into a live one. `ef9d0608` removes that constraint: the branch is now correct for
every population that reaches it, so un-masking it is harmless. **Item 69 is unblocked — see there.**
Measured while the question was still open, the branch's entry condition never held once in the
sink's window: of the collapsed `[zone-agent-final-assessment]` records on item 73's key, exactly
one carried `triggeredBy: "max_iterations"` and it also carried a tag, so `inferredFrom: "heuristic"`
never co-occurred with that trigger. That is a statement about how rare the max-iterations path is,
not evidence the branch was harmless.

**One route this entry claimed item 12's fix would add is masked before it reaches the result, and
the overstated sentence is thrown out rather than qualified.** It said that fix would route *every
resumed run* and *every no-op-only run* into this branch's verdict. Resumed runs, yes — the
tool-call log is not persisted in the envelope but rebuilt by `rehydrateFileAccess`, whose entry
shape declares no `filesStaged` member, so a field-consulting arm reads every rehydrated write as
having staged nothing. **No-op-only runs, no.** A run whose staged content matches disk produces a
verification status of `no_changes_made`, which `deriveFinalizeBranch` maps to the `no_change`
outcome, and `deriveResultFields` overrides the verdict for that outcome to `no_changes_made`
before it reaches the result field. The branch's value never survives to the result for that
population.

**The asymmetry that creates is the part a later reader will trip on, so it is stated rather than
implied: the override does not reach telemetry.** `emitAgentFinalAssessment` fires in
`runCompletion/composer.ts` before `deriveResultFields` runs, and it records the raw `verdict.reason`.
So for a no-op-only run the recorded assessment and the recorded result field disagree by
construction — the marker carries what the branch returned, the result carries `no_changes_made`.
Anyone reconciling the two sources for this population is comparing a pre-override value against a
post-override one.

**With this entry decided, item 12's no-op half is unblocked — see there.** The value this branch
returns is correct for a run that wrote only no-ops and for a run that is merely resuming, which is
what the blocking question was waiting on.


**Bucket — Closed.** This entry's own stated closure condition was "a decision about what the
function should return when no write tool was ever available," and `ef9d0608` makes it. The
sibling material this entry accumulated — the validated-patch flag, the assessment records, and the
markers that would separate the paths — is not that question, as this entry said itself while open
("the records characterise the *sibling* payload-collapse problem, not the question this entry turns
on"). It moves to item 74 rather than closing with this one or holding this one open. **Precedent:
item 71's carve-out from item 62** — a finding of a different kind from its parent's subject gets
its own entry rather than being absorbed; here the parent closes and the different-kind material is
what survives, which is the same rule read from the other end.

**Where the code lives:** `inferVerificationFromLog`, `validatePassedClaim`,
`validateUnrelatedClaim`, and `applyNoInfraVerificationOverride` are all in
`verification/classify.ts`; `didApplyPatch` is in `verification/logUtils.ts`. `patchValidatedByAgent`
is computed in `runCompletion/deriveVerdict.ts`. The mode-keyed fast-paths and the `deriveVerdict`
call they precede are in `runCompletion/composer.ts`; `isReadOnlyMode` and the warning comment
naming this mode-vs-archetype split are in `agentLoop.ts`.

## 71. Closed — three teaching surfaces taught a patch shape the walk corrupts

**What it was:** three model-facing surfaces demonstrated a FIND/REPLACE shape that
`segmentPatchBlocks` cannot parse cleanly. The walk locates markers by substring search and slices
around them, so anything sharing the marker's line comes back inside the block. Two of the three
showed markers indented two spaces — `PROVIDER_AGNOSTIC_HARDENING` and the
`apply_patch_marker_imbalance` coaching example — which yields `find` = `"  const a = 1;\n  "`,
a trailing newline-and-indent that matches nothing. The third was worse and reached every request:
`apply_patch`'s own tool `description` taught the format **inline on one line**
(`Format: --- FIND --- <content> --- REPLACE --- <content>.`), which yields `find` =
`" const a = 1; "` — stray leading *and* trailing space. Measured against the compiled walk, not
traced.

**Found while measuring item 62's cost claims, not from an independent review** — the same
circumstance items 43, 57, and 59 already record, and the reason this is its own entry rather than
a bullet inside item 62: it is not item 62's recipe. Item 62 is a proposal to change the *walk*;
this was a defect in what the *prompts* teach, live under the walk that already exists, and it
landed as its own commit. Item 62's own carve-out from item 2 set exactly this precedent.

**Fixed (`278b52ef`):** both coaching examples de-indented to column zero; `PROVIDER_AGNOSTIC_HARDENING`
additionally gained a blank line after each of its two labels, so the label-to-block separation its
indentation used to provide survives the de-indent; the tool description rewritten to block form at
**zero character delta** (245 → 245).

**The character figure settles nothing about cost, and is recorded as a size fact only.** That
string lives in the cached tool-definition prefix and was deliberately compressed once before on
token grounds. No tokenizer exists anywhere in this repo — not in `package.json`, not in
`node_modules` — so the **token delta is not established**. Swapping spaces for newlines does not
tokenize neutrally, and an equal character count is not evidence of an equal token count.

**Three reachability facts a future prompt sweep will need, none of them obvious from reading the
switch:**
- **`PROVIDER_AGNOSTIC_HARDENING` is reached by a disjunction, not by either half alone:**
  `!options?.model || HARDENING_TARGETS.has(options.model)`. An absent model includes it; a
  hardening-target model includes it; any other model excludes it entirely. Two separate accounts
  written during this work each named one half and were each half right.
- **A second precondition sits underneath the model axis and is easy to miss entirely.** One
  trigger's hardening-bearing variant lives inside a `generatedPathDetected` branch, so it is
  unreachable no matter which model value is supplied unless that flag is set too. A sweep varying
  only the model axis would have collected the wrong string for that trigger and reported clean.
- **"A line containing one marker literal" is not a usable discriminator for block shape.** It
  false-positives on prose: an already-correct coaching message contains the sentence "…include
  them in `--- REPLACE ---`:", which carries exactly one marker and is not a delimiter line. The
  working rule is that the **trimmed line must be entirely the marker** — found by running the
  sweep, not by designing it.

**What guards it, and why a sweep rather than three assertions.** A per-site check would have
pinned these three and nothing else. The test collects every string `buildCoachingPrompt` can emit
across all **19** `SelfCorrectTrigger` values (the union has 19 members, not 18) crossed with three
model values and both `generatedPathDetected` states, plus both of `apply_patch`'s schema
description fields, dedupes by exact text, and fails on any block-shaped marker line that does not
start at column zero. Its positive control counts **marker lines found**, not sources examined —
asserting "20 sources examined" against a 20-element loop is close to vacuous, while a collection
that silently gathers the wrong strings and finds no markers at all is the real failure mode. A
separate test guards the blank-line-after-label property, since removing a blank line moves no
marker and the column-zero sweep is correctly blind to it. Mutation-tested: re-indenting either
site fails the sweep naming that site; injecting an indented marker into a trigger that carries no
marker literal at all (`read_file_nonexistent`) also fails it, which is what distinguishes a sweep
from three spot-checks; removing a blank line fails the legibility test while leaving the sweep
green.

**What this does not establish, stated so the commit is not read as more than it is.** The taught
shape is measured to parse badly. There is **no evidence any model actually emitted it** — the
apply_patch-specific markers that would record such an event carry zero relevant records (item 63
covers why that instrumentation window is only days old). This fix rests on the first fact alone.
It also means any accumulation under those markers now spans two teaching regimes and must be dated
from this commit, separately from the earlier commit that first routed them to the sink.

**Where the code lives:** the two coaching examples are in `buildCoachingPrompt`'s switch and in
`PROVIDER_AGNOSTIC_HARDENING`, both `agentLoop.ts`; the tool description and its `patch` parameter
description are in `toolDefinitions.ts`; the sweep and the legibility test are in
`agentLoop.prompts.test.ts`. See item 62 for the anchoring proposal this was found while measuring.

## 72. Closed — a negative `since_offset` returned empty output with `truncated: false`, indistinguishable from "caught up"

**What it was:** `read()`'s offset chain had four branches — a null offset clamped to the
retained window; an offset older than that window clamped the same way and marked
`truncated = true`; an offset at or past `proc.ringWritten` returning empty early; and everything
else falling through to `from = input.sinceOffset` unchanged. That last branch had no lower bound.
A realistic negative value never reaches the second branch, whose condition is
`input.sinceOffset < proc.ringWritten - RING_CAP` — with `RING_CAP` at 256 KB that fires only
below roughly `-262134` for a short-lived process — and never satisfies the third, so it lands on
the unguarded one.

**"Indistinguishable from caught up" is measured, not asserted.** Against the real pre-fix module
driving a real ten-byte process, `since_offset: -5` returned
`{"success": true, "output": "", "newOffset": 10, "eof": true, "exitCode": 0, "truncated": false}`
— and the genuine caught-up call, `since_offset: 10` fed back from the previous read's
`new_offset`, returned the same six fields in the same order with every value identical, as did
`since_offset: 999999`. Nothing in the result separates "your offset was nonsense and ten bytes
were dropped" from "you are up to date." The control at `since_offset: 0` returned
`{"success": true, "output": "ABCDEFGHIJ", "newOffset": 10, "eof": true, "exitCode": 0,
"truncated": false}`, so the bytes were there to be returned throughout.

**Mechanism, traced with real numbers rather than assumed.** `from = -5` gives
`length = proc.ringWritten - from = 15`; `readRingTail` then computes
`startWritten = 10 - 15 = -5` and `startOffset = -5 % 262144 = -5`, because JS's `%` preserves the
dividend's sign instead of wrapping. `Buffer.subarray` reads a negative start as an offset from
the end (`262144 - 5 = 262139`), which exceeds the end index `10`, and slice semantics return
length 0 rather than throwing. Silent at every layer.

**Found while measuring item 65's two `read_background_output` candidates**, and its own entry
rather than a bullet inside item 65 on the precedent item 66 already set with the same parent: a
fix found while investigating that survey, in a different layer from what the survey proposed,
landing as its own commit. Item 71's carve-out from item 62 is the nearer comparison in time and
passes the same test — this is not item 65's recipe, which was a schema keyword — but it fits
less well than it looks. Item 62's proposal survived item 71 untouched, whereas this measurement
**refuted item 65's own sentence** about the parameter. That half is not carved out; it is
corrected in place in item 65, per this document's convention of deleting a false sentence rather
than annotating it.

**Fixed (`b5b603ef`):** the negative case folded into the branch that already existed for an
offset outside the retained window — `input.sinceOffset < 0 || input.sinceOffset <
proc.ringWritten - RING_CAP` — so it reuses that branch's clamp and its `truncated = true` rather
than introducing a new path. Chosen over returning an error because `ReadResult`'s success variant
carries `newOffset: proc.ringWritten` unconditionally on every return path including the broken
one: a correct recovery position was always available whichever fix landed, so what a clamp buys
that an error does not is the current call's own data.

**`truncated` was swept before that branch was reused, because reusing it sets a flag the model
sees.** It is serialized straight into the tool result with no surrounding prose; the tool's own
`description` never mentions it; the system prompt's only `read_background_output` mention never
mentions it; no text anywhere says "ring" or "wrap"; and the same field name is already reused
generically in the same handler file for `run_command`, `read_file`, and a shared text-truncation
helper. Generic — so reusing the branch attaches no false explanation to a true flag.

**The reasoning that justified the clamp's exact shape was false, and catching it before it
reached the commit message is the part worth keeping.** The reused branch clamps to
`Math.max(proc.ringWritten - cap, proc.ringWritten - RING_CAP, 0)`, and the argument for reusing
that expression rather than writing a bare `0` was that a bare zero would be wrong for a
long-running process whose ring had already wrapped. No such process exists. `cap` is
`Math.min(…, 65536)` and `RING_CAP` is `262144`, so `cap < RING_CAP` holds for every possible
`max_bytes`, the `RING_CAP` term can never be the maximum, and the three-term expression always
reduces to the two-term one. A bare zero converges as well, for a sharper reason: `from` is dead
the moment `length` is computed from it — `readRingTail` receives `proc.ringWritten` and `length`,
never `from` — and the following `if (length > cap)` re-derives everything from `cap` alone.
Swept across every combination of twelve `ringWritten` values and six `max_bytes` values: no
divergence anywhere. **No test can distinguish the two shapes**, which is a structural fact about
the function, not a fixture that was too slow to write. The reuse is a consistency choice — one
clamp expression, in the branch that already had it — and nothing more. A future reader choosing
between the two shapes should choose on that basis and no other.

**No matching defect on the high side, established by measurement before symmetry was assumed.**
An offset at or past `proc.ringWritten` returns empty with `truncated: false`, which is correct:
nothing exists past the monotonic write count. The test covering it is a regression pin for
behaviour that was already right, not evidence of anything this commit fixed, and no mutation
exercises it.

**Coverage, and what it still does not cover.** The module had no vitest coverage at all before
this commit — no test file referenced it, and the one file that did, a spawn-and-poll script under
`__tests__/`, carries no `.test.` segment in its name and so falls outside vitest's `include` glob
entirely. The three tests added here spawn a real ten-byte process, because the module offers no
seam to construct a process state without a real `start()`. They cover the offset chain only: ring
wrap, kill escalation, group-kill, and the per-run concurrency cap remain covered by that
out-of-glob script alone.

**Where the code lives:** the offset chain, the clamp, and `readRingTail` are in
`backgroundProcessRegistry.ts`; the tool result's `truncated` pass-through is in
`read_background_output`'s handler, `toolExecutor.ts`; the tests are in
`backgroundProcessRegistry.test.ts`. See item 65 for the survey this was found while measuring.

## 73. Every entry that counts sink records is counting a number inflated by duplication

**Carry the direction, not the figures — the figures have been revised once already and may be
again.** Every key tried against this sink so far *under*-merges: each one fails to recognise some
duplicate pairs and leaves them counted separately. That has a consequence worth memorising
because it survives any further revision of the numbers below — **a count taken off this sink is
an upper bound on real events, never a lower one.** A later correction can only move a figure
down. So conclusions that hold at the current count — a zero, an ordinal ranking, a threshold that
is *not* met — stay safe under revision; the only kind at risk is one needing a count to be *at
least* something, and this document currently states none. **The signal that this direction claim
has broken is a re-derivation producing MORE events than a prior one.** If that ever happens the
under-merge assumption failed somewhere, and every count in this document needs re-deriving from
scratch rather than adjusting.

**This entry was corrected by the process it describes, one commit after it landed.** It said the
sink miscounts, then carried a miscount of its own — it named 814 as the duplication when 814 is a
floor — and that was found only because a later pass re-derived the document's counts, a pass that
ran only because this entry existed. Recorded because it bounds what the entry is good for: a
measurement of an instrument, taken with that same instrument, is not trustworthy as a point
value. It is trustworthy as a direction, which is why the direction is stated first.

**What it is:** the marker sink carries duplicate records at scale. Measured across the whole file
rather than sampled: 3747 records, 2933 distinct raw lines, and 814 lines that appear more than
once — always exactly twice, never three times. **814 is a floor, not the duplication.** It counts
only pairs whose two copies carry the identical timestamp; duplicates written a millisecond or two
apart are byte-different and invisible to it. Grouping instead on name, run, and payload while
ignoring the timestamp, the gaps within each group are sharply bimodal: **814 at zero, 158 at
1-2ms, 11 at 3-10ms**, then a genuine tail — 13 under a second, 68 under a minute, 33 beyond one.
The cluster at or under 10ms is one emission recorded twice; the tail is real repetition. The
duplication is therefore about **983 pairs, not 814** — the exact-identity figure was roughly 16%
short.

**The key: group on name, run and payload, and collapse records within 2ms.** Bounded in both
directions by measurement rather than judgement. Over-merging is ruled out empirically — collapsing
within 2ms and within 10ms return the *identical* count for `[zone-agent-tool-call]`, so nothing
genuine sits in that band; widening to a full second drops the count further, which is where real
repeats begin being eaten. 2ms sits on a plateau, not a slope. Under-merging is the error that
actually occurred, twice, and it is the safe direction — see the top of this entry.

**The duplicates are one emission recorded twice, not two events.** For the parity marker the pairs
are identical in every field except the timestamp, with deltas of zero and one millisecond. A delta
of zero rules out two independent calls for anything whose work takes measurable time, and the
1-2ms pairs are the same shape one tick later.

**What it costs, concretely, and why "divide by two" is not the fix.** Any count taken straight off
the sink is inflated, and not by a clean factor. On the corrected key `[zone-agent-tool-call]` gives
**64 calls from 130 raw records** — `search_in_files` 30 from 60, `read_file` 23 from 48,
`run_command_readonly` 6 from 12, `apply_patch` 4 from 8, `run_command` 1 from 2. Sixty to thirty is
a halving here but twenty-three from forty-eight is not, and some records are singletons, so a
blanket halving is wrong in the other direction. Every rate, denominator, and threshold comparison
in this document computed from raw counts is suspect until recomputed on this key.

**Which entries were affected, and what survived.** Item 65's tool-call census has now been
corrected twice — raw to exact-identity to this key — and its ordinal claim and its zero survived
both. Item 18's normalization-parity denominator is two calls, which is the same answer under
either key and needed no second correction. Item 61 carried a claim that the sink held no recent
records at all, now false by 1928 records, and the conclusion it supported came out stronger. Item
4's rate was wrong for a reason that has nothing to do with this entry — stated there, so nobody
re-checking it against this key concludes the key was applied inconsistently. Item 70's counts were
re-derived and are unchanged.

**Its own entry rather than a paragraph inside either, on item 11's precedent.** Item 11 records a
standing structural fact about the sink as an *instrument* — that its data accumulates only
passively — once, rather than restating it in every entry that reads the sink. This is the same
kind of fact about the same instrument, it invalidates arithmetic rather than any one finding, and
it applies to entries that do not exist yet. Item 54 is a second instance of that shape.

**The cause is not established.** That the duplication happens is measured; why is not. Two capture
points on one write path, a sink invoked both directly and through the stdout interception shield,
or something else — no investigation was run and none is prescribed here. Deduplicating by
timestamp and payload at read time is what both corrections above did; it is sufficient for
counting and it is not a fix.

**A second standing constraint on this instrument, about what can be joined rather than how records
are counted — recorded here on the same grounds this entry gives for its own placement.** Archetype
is not on the classification record: `[zone-task-classified]`'s payload carries the task hash, the
tier, the confidence, the classifier's model and cost, and the fallback flag, and no archetype field
at all. The only archetype-bearing marker is `[zone-archetype]`, emitted at loop close. **So a run
that never reaches loop close has no archetype record**, and any population question keyed on
archetype silently excludes exactly the interrupted, hard-killed and resumed runs — the population
several entries here care most about. Item 75's own trigger is a two-marker join over that
population, and the two resumed runs in its window are archetype-invisible for precisely this
reason. This is not a defect to fix so much as a limit to state before the next pass reads an
archetype breakdown as covering every run: it covers every *completed* run.

**A third standing fact, and it is about when the upper bound is tight rather than about what the key
misses.** Every entry citing this sink says "upper bound on item 73's key", correctly, and none says
where the bound closes — so a reader has no way to tell a figure that might shrink from one that
cannot. It varies by marker, not by window. Over a sink read on 2026-08-09, both plan-mode stores
survive the key untouched: the gate marker at nineteen raw and nineteen collapsed, the investigation
completion marker at twenty-five and twenty-five. Two other markers in the same file over an
overlapping window do not — `[zone-archetype]` collapses forty-nine to forty-four,
`[zone-task-classified]` twenty-six to twenty-one. So the duplication this entry measures is not
uniform across markers, and for the two plan-mode stores a count is an exact figure rather than a
ceiling. Worth stating because the safe reading this entry prescribes — treat every count as
shrinkable — costs precision wherever it is unnecessary, and which case applies is one dedup away.

**Where the code lives:** the sink's append path, its size cap, and its rotation are in
`markerSink.ts`; the interception that routes marker-shaped writes into it is the same shield item
11 describes. The file itself is `markers.jsonl` under the user-level `.zone` directory.

## 74. Several run shapes that applied nothing are indistinguishable downstream, and one of them is reported as validated

**What it is:** the material item 70 accumulated while open, which its own closure names as a
different question from the one it turned on. Three strands, all still open, all about the same
thing — a run that applied nothing is not one behaviour, and nothing downstream can tell the shapes
apart.

**Strand one: the verdict is correct but coarse.** `ef9d0608` made
`inferVerificationFromLog`'s not-patch-applied branch return `no_verification_attempted`, which is
true for every population that reaches it — read-only-archetype runs, runs whose every write failed,
`multi_edit` runs that matched nothing, and empty or read-only tool logs. Giving the every-write-
failed population a distinct verdict was considered during that pass and deliberately not built: it
needs an input the function does not receive — whether any write was attempted, or whether write
tools were offered at all — so it changes `inferVerificationFromLog`'s signature and its call site
in `deriveVerdict`, which is not confined to one module the way the value change was. Separable, and
separated on purpose so the correctness fix could land without waiting on it.

**Strand two: `patchValidatedByAgent` is set true on runs that applied nothing.** Re-established
after `5d01d27a` rather than assumed closed by it, and untouched by `ef9d0608` — that commit changed
a value the flag was already false for. **Half of it closed later, by `29230a1b` under item 69**;
the other half is open and the two are separated below.

**`patchValidatedByAgent` is the sibling half, re-established after `5d01d27a` rather than assumed
closed by it.** The flag is set true whenever the post-override reason is `tests_passed`,
`tests_skipped_no_infra`, or `tests_failed_unrelated`. Two shapes still set it true on a run that
applied nothing, and the widening closed neither:
- **Read-only-archetype runs on the max-iterations path** — **closed by `29230a1b`, a sibling's fix
  rather than this entry's own, and recorded because nothing else here would say so.** The route was
  item 69's surviving tag demand: the model picked `tests_skipped_no_infra`, nothing downstream
  contradicted it, and `applyNoInfraVerificationOverride` could not correct it because that override
  itself requires `patchApplied`. Item 69's third arm removes the demand for exactly this
  population, so the run reaches `inferVerificationFromLog` untagged and lands on
  `no_verification_attempted`, which is not one of the three reasons that set the flag. The shape
  below is untouched, so this strand is halved, not closed.
- **Any run of any archetype that applied nothing**, which `5d01d27a` never addressed and was never
  scoped to: a patch-archetype run whose patches all failed still receives the FINAL ASSESSMENT
  block correctly, and can still answer with a validating value. Worth stating because the two
  demotion paths land there too — `validatePassedClaim` with no `run_command` and a framework
  without tests demotes `tests_passed` to `tests_skipped_no_infra`, and `validateUnrelatedClaim`
  demotes the same way, so a *safety* demotion can produce a validated-patch flag on a run with
  neither a patch nor a test execution.

**Real records now exist for the sibling half, and they show the payload cannot separate the paths
that reach it.** `[zone-agent-final-assessment]` carries **24 raw records** over a
2026-07-29 → 2026-08-05 window, **19 distinct payloads** after deduping on exact payload text.
Deduped, they break down as: **12** `tests_skipped_no_infra` with `patchValidatedByAgent: true` and
`inferredFrom: "tag"`; **3** `no_verification_attempted` with `false`/`"heuristic"`; **3**
`tests_passed` with `true`/`"tag"`; **1** `tests_inconclusive` with `false`/`"tag"`. (Counting raw
rather than deduped gives 15/4/3/2 — the dedup matters because the natural-completion payload
embeds a `summaryPreview`, so identical payloads are near-certainly the same run recorded twice
rather than two runs agreeing byte-for-byte.)

**Both breakdowns were re-derived against item 73's corrected key and both are unchanged — but one
of the four shapes cannot be found by the obvious query, and that is worth stating so a later pass
does not "correct" a right number into a wrong one.** Only two of the three `tests_passed` records
carry `verificationReason`. The third has no such field at all: it is the single `max_iterations`
record counted below, and on that path the payload names the field `finalVerificationReason`
instead. A re-derivation keying on `verificationReason` alone finds 2, concludes the entry
overstated by one, and is wrong. That the same value travels under two different field names
depending on which termination path emitted it is not incidental to this entry — it is another
instance of exactly the collapse this entry is about, on the field the entry uses to read the
others.

**Those twelve are not one behaviour, and this is the same defect class item 61's second bullet
records — a new instance, now with records behind it instead of a trace.** `inferredFrom` reports
only *that* a tag was present, and `reason` is the **post-override** value (item 61's F3). So every
path that ends at `tests_skipped_no_infra` from a tagged run collapses into one indistinguishable
payload. Enumerated against the real code rather than the two the original framing named, there are
**five**: the model emitting `tests_skipped_no_infra` directly; `validatePassedClaim` demoting
`tests_passed` when no `run_command` ran or no success pattern matched and the framework has no
tests; `validateUnrelatedClaim` demoting `tests_failed_unrelated` the same way; and
`applyNoInfraVerificationOverride` converting either `tests_inconclusive` or
`no_verification_attempted` when a patch did apply to a framework without tests. A clean skip and a
rejected `tests_passed` claim are the same record.

**Three sibling markers would separate them, and none reaches the sink — checked, not assumed.**
`zone-agent-verdict-override` (which carries `originalVerdict` and the validator's own reason, the
exact discriminator) is emitted through `onProgress` as bare JSON with no `[tag]` prefix, so the
sink's tag-pattern classifier never matches it — that mechanism is untouched by what follows and
stands. All three read **zero records**.

**What was said about the other two markers' zeros is thrown out, and the zeros themselves are
kept.** This paragraph used to attribute `[zone-agent-no-infra-override]` and
`[zone-agent-no-infra-verdict]` reading zero to their `debugLog` gating on `ZONE_VERBOSE_LOGS`,
counting that as an independent mechanism alongside the prefix problem above. The gating is real;
the attribution is not. `[zone-agent-verdict-inferred-from]` is `debugLog`-gated the same way and
sits on the same call chain — `deriveVerdict` emits it on every verdict these two markers could
have fired beside — and it carries real records from a handful of runs inside a single
thirteen-minute window on 2026-08-05. So the gate was demonstrably open for those runs while both
no-infra markers stayed silent, which makes their zero a real absence across that window rather
than an artifact of routing. It is a much weaker sample than the counts above and cannot support
"these paths never fire"; what it does support is that the gate is not the explanation, and a later
pass reaching for one should not reach for that. See item 61's third bullet, which carried the same
mistaken "never reaches the sink" claim about the marker that disproves it.

**The three heuristic records are the pre-fix baseline, not evidence the gate widening works — a
distinction worth fixing in place before someone reads them as a measurement.** After item 61's
first bullet closed, a read-only-archetype run completing naturally with no tag lands exactly here:
`no_verification_attempted`, `patchValidatedByAgent: false`, `inferredFrom: "heuristic"`. So growth
in this shape is that fix working as designed, not a regression. But every record in this sink
predates it — the newest is dated 2026-08-05 and the gate widened the following day — so the
current three measure the world before the change. The expectation is forward-looking; the number
is a baseline.

**One record in nineteen is `max_iterations`** (one in twenty-four raw). Recorded as the current
observed rate because it bears directly on item 69's priority — the wrapup surface only fires on
that path — and recorded as `n=19`, which is a rate, not a trend.

**Strand three: the assessment payload cannot separate any of this, and could not before
`ef9d0608` either.** `AgentFinalAssessmentData`'s `max_iterations` variant carries
`finalVerificationReason`, `inferredFrom`, and `patchValidatedByAgent` — no tool names, no
write-attempt count, nothing naming which shape produced the record. So all four run shapes above
emit an identical payload, and did so under the old verdict too; this is a pre-existing
observability gap that the fix neither caused nor widened. Recorded here rather than as its own
entry because it is the same concern as strand one seen from the reading end: strand one is that the
verdict cannot distinguish them, strand three is that the record cannot either.

**Why here rather than in item 61, which owns the neighbouring ground.** Item 61's second bullet
records the payload-collapse defect class and item 70 named it as such while open. But item 61's
bullet is about `inferredFrom` and `reason` failing to separate *verdict-derivation paths*; this is
about the payload failing to separate *run shapes* that share one verdict. Related, not the same,
and item 61 is a closed-arc retrospective rather than a live defect entry. The correction
`ef9d0608` forced in item 61 is made there, in place.

**What would close it — a decision, and it is genuinely open.** Whether these shapes need to be
distinguished at all depends on what anyone would do differently knowing which one occurred, and no
consumer today branches on the distinction. Adding a discriminating field to the assessment payload
is the cheapest candidate and is not proposed here, because nothing yet establishes that the
distinction is worth carrying.

**Where the code lives:** `inferVerificationFromLog`, `validatePassedClaim`,
`validateUnrelatedClaim`, and `applyNoInfraVerificationOverride` are in `verification/classify.ts`;
`patchValidatedByAgent` is computed in `runCompletion/deriveVerdict.ts`; `AgentFinalAssessmentData`
and its emitter are in `llm/loopTelemetry.ts`, called from `runCompletion/composer.ts`.

## 75. A resumed run's rehydrated write entries carry no staged-files signal, and the predicate guesses rather than knowing

**What it is.** `21cb580a` closed item 12 by deciding what `didApplyPatch` should do when the
staged-files field is absent: treat it as changed. That is a guess, chosen because it is the cheaper
of two wrong answers, and this entry is the work that would remove the need to guess. The absence has
exactly one production producer — `rehydrateFileAccess`, whose entry shape declares no staged-files
member and hardcodes the success flag, rebuilding the tool-call log on resume because the envelope
does not persist it. Emit the field there and absence stops occurring for these tools, at which point
the arm's polarity on absence stops mattering for real runs.

**It is reachable, established against the code rather than assumed.** `reconcileEnvelopeStaging`
holds both halves of the comparison at the moment it decides to restore an entry: it reads the file's
current content off disk and compares its hash against the recorded base hash, restoring only on a
match. At that instant the disk content *is* the base, so comparing it against the staged content is
an exact per-path answer to "did the prior run change this file," available with no new persistence
and no new field on the envelope.

**Two gaps come with it, and the second is the larger one.** The signal is discarded one line after
it becomes available, because the restore writes only a path-to-content map and the base does not
survive into the resume input — so the comparison has to be made at the reconcile site or not at all.
And `write_file`'s new-file path bypasses staging entirely, writing straight to disk; those paths are
recorded on the envelope but read back only to compose a line of prose in the resume context block,
never as data reaching the loop. So a rehydrated create has no structured signal at all, and closing
that is a second threading rather than the same one.

**The trigger, on item 63's convention.** Build this when `[zone-resume-rehydrated]` and
`[zone-agent-final-assessment]` appear on the same run id with the validated flag true — that is a
resumed run whose applied-nothing status was guessed and then reported as validated, which is the
only shape where the guess reaches a surface anyone reads. **It does not occur today:** across the
sink window from 2026-07-29 to 2026-08-05 the two markers' run-id sets are disjoint, and neither
resumed run in that window reached run completion at all, so no resumed run has reached the predicate
yet. Both figures are upper bounds on item 73's key. **Neither resumed run carries an archetype
record either**, since archetype is emitted only at loop close — item 73 records that constraint,
and it bears directly here: this trigger cannot be narrowed to a read-only archetype even if a
later pass wanted it to be.

**Review point, independent of the trigger:** revisit after roughly fifty real runs that include at
least one resume reaching completion — the resume path, not the run count, is what gates this, and
fifty ordinary runs have so far produced two resumes and no completions among them.

**What a null result means, stated so a later pass does not read the silence as waiting.** If the
co-occurrence never appears, that is the answer and not a stalled entry: it means absence never
reaches a surface anyone reads, and the guess `21cb580a` made was right in practice as well as in
argument. The entry would then close on the observation, not on the threading.

**Why its own entry rather than inside item 12 or item 74.** Item 12 closes, and a closed entry is
the wrong place to park live work. Item 74's three strands are all about a verdict and a payload
failing to distinguish run shapes that already reached completion; this is about a signal missing
from a resumed run's reconstructed input, one layer earlier and in a different subsystem. Item 6 owns
the hardcoded success flag on that same reconstruction, but closed on the read-before-patch gate's
own terms — a different consumer of the same shape. Item 23 is the nearest resume-path sibling and is
about envelope id resolution, not about what the envelope carries.

**Bucket — Blocked on data**, on item 63's precedent: whether to build it is gated on an observation
that does not exist yet, which is that bucket's definition rather than an approximation of it.

**Where the code lives:** `rehydrateFileAccess` and its `REHYDRATED` set are in `llm/agentLoop.ts`;
`reconcileEnvelopeStaging` and the created-paths list are in `api/diskRunEnvelope.ts`; the resume
input is assembled in `cli/dispatch.ts`; the arm that consumes the field is `didApplyPatch` in
`llm/verification/logUtils.ts`.

## 76. The run summary's verification note falls through to a patch-or-error choice, and both of its arms are false for shapes that reach it

**What it is:** `deriveAgentVerificationSummary` maps a verification reason to the note that travels
on the run summary. Each of its five named arms keys on a reason a model-supplied tag produces —
tests passed, skipped, unrelated, inconclusive, failed-by-patch — and everything else falls through
to a two-way choice between "Patch applied by agent (no test verification)" and "Agent loop
encountered errors during execution", selected on the loop's own success flag. **`no_verification_attempted`
reaches only that fallthrough**, and on the max-iterations path `finalizeRun` reports failure
unconditionally — its success is computed as natural-completion-and-not-warned — so the note is
always the error one. A run that was never offered a write tool and simply exhausted its iteration
budget is described as having encountered errors during execution. Both fallthrough arms name a
patch or an error; neither describes a run that did neither.

**More than one shape reaches the fallthrough, and one of them lands in the arm that claims
success — this entry first recorded a single shape and that was wrong.** The reasons that reach it
are the ones no named arm keys on: `no_verification_attempted`, `verification_warnings`,
`verification_failed_staged`, and `no_changes_made`. `verification_regressed` reaches it too but
never surfaces, because the call site replaces both the note and the decision mode whenever the
reason is that value. **`no_changes_made` is the sharp one, and it lands in the opposite arm from
the one this entry was written about.** `finalizeStaging` returns it when every staged file's bytes
already equal the disk bytes, `deriveResultFields` hardcodes it for the no-change outcome, and the
fallthrough's success arm then reports that a patch was applied with no test verification — a run
that wrote nothing is told a patch was applied. `verification_warnings` reaches the same arm and
loses the warnings the run did surface. A single new arm cannot cover these: they differ in what
actually happened, not in one missing case, which is why closing this is not one commit.

**Which commit created the population, and which shapes predate all of them.** `ef9d0608` created
it: before that commit `inferVerificationFromLog`'s not-patch-applied branch returned
`tests_failed_by_patch`, which is a named arm — wrong for the run, but not a fallthrough — and after
it the branch returns `no_verification_attempted`, which no named arm keys on. `29230a1b` widened
it, by removing the tag demand from read-only-archetype runs at max iterations so that population
reaches the inference untagged; item 69's closure records this as the second consumer its own
un-masking reasoning missed. `21cb580a` changed `didApplyPatch`, which that same inference calls,
and did **not** touch this: for the shape it moved — a write that succeeded and staged bytes equal
to disk — `deriveResultFields` hardcodes the no-change reason before the note is derived, so the
note's input is the same value either side of it. **The `no_changes_made` and `verification_warnings`
shapes predate all three and were touched by none of them** — both are produced in `staging.ts` and
`deriveResultFields.ts`, and no commit in that arc opened either file. That is what makes this an
old defect surfaced rather than one the arc introduced.

**It is emitted, and it does leave the process — the entry's original claim of a single consumer
that ignores it was wrong in the one case that matters.** `assembleRunSummary` places the note on the
run summary payload's verification block and the surrounding code emits that payload as a
`run_summary` event on the bus. **Three consumers subscribe.** The TUI's own handler reads the cost
total and nothing else. The CLI sink reads the cost total and the changed-file list. The third is
`toWireFrame`, which copies the whole verification block — note included — onto the remote-control
wire frame, and the remote adapter broadcasts every frame it produces, so on that path the note
reaches a client outside the process. That path is opt-in rather than absent: the adapter is
constructed only inside the handler that starts the remote-control server on an explicit user
request, so a session that never issues that request never builds it and the note reaches nobody.

**The headless printer was named here among the renderers that ignore the event; it never receives
the event at all.** `printResult` takes the flow's own result object and reads its decision mode,
warnings, and reason off it — it is not a subscriber. Both facts are true separately and were run
together as one: the result object carries no note, and the event that carries the note has no
printer reading it. Item 60's report, for contrast, never crosses any boundary — its only readers in
the whole tree are test assertions.

**What is not specified, which is the reason this is not one commit.** The condition an arm would
select on is not written down here, and the value it would need is not in the function's scope:
`deriveAgentVerificationSummary` receives a verification reason, the loop's success flag, and a
run-command-failure flag, and nothing that says whether a write ever reached disk. Naming "a run with
no applied patch" as the selector describes an outcome the function cannot observe. Closing this needs
a decision about which of the reasons above earn their own arms and where the applied-or-not signal
comes from — a different kind of work from adding a branch.

**What survives the corrections, stated as a scope rather than a payoff.** Nothing persists the note:
the on-disk run envelope, the session transcript writer, and the cost log each carry no verification
block at all. So in the default configuration the wrong text is produced on every agent-loop run,
crosses a boundary, and is discarded by both readers that are there. Fixing it is a correctness fix
with no locally observable effect, and the one path that would make it observable has to be turned on
first. Urgency is contingent on that path being used, or on a local renderer appearing for the note;
neither holds in an untouched session today, which is why the wrong text has cost nothing so far.

**The type string is shared with an unrelated payload, which is why the consumer count was easy to
get wrong.** `costLogger.ts` appends a JSON line to the usage log whose type is also `run_summary`,
carrying a model name, an iteration count, a cost total, and a cache-hit ratio — and no verification
block — and `buildFeedbackReport.ts` reads that line back out. A grep for the type string returns it
alongside the three bus subscribers, and that is how the first enumeration written here came out
wrong. Item 61 records the same class one instance over: its sink-visible marker's two variants name
one value two ways, so a query grouping on either name silently drops half the records. A name that
looks like one thing and is two, in both cases; neither carries a proposed fix.

**A third artifact carries the same name, and reading it as a defect is the mistake the name
invites — recorded because a later pass made it.** The usage tracker appends a per-run record under a
sentinel model name that also reads as a run summary, in a different file, consumed by the metrics
aggregator rather than by the feedback report. Every one of its token and cost fields is zero across
the whole log, and an establish pass in this session reported that as an inert aggregate — a real
observation with a wrong conclusion attached. **The zeros are deliberate and documented at the
writer**, whose own comment says it appends a zero-cost record carrying latency and termination
reason without affecting cost or token totals, precisely so the record cannot double-count against
the per-call rows it sits beside. Nothing is broken. What the episode demonstrates is this
paragraph's own point at one more remove: three unrelated artifacts share a name, a grep returns all
three, and the third one's correct-by-design zeros read as a fault to anyone who arrives at them
through the name.

**Bucket — Neither, judged on the Actionable-now bar rather than by elimination.** That bucket asks
for a fix specified in the entry with nothing left to learn, and this entry fails it in three places:
the selecting condition is not written down, the value that would select on it is not in the
function's scope, and the entry named one shape where the fallthrough has several. Learning what to
do is the work, which is Neither's own definition.

**The precedent is item 60's bucket and not item 60's reason, and this document has no way to say so
outside the entry itself.** Item 60 sits in Neither because a prior decision blocks it — nothing can
be specified until someone decides what its report is *for*. This entry has no decision waiting on
it; it is blocked on an action having been named without being specified. Two different failures of
the same bar, landing in the same list, because the snapshot groups by mechanical status only and has
no finer axis. Recorded here rather than flattened into a shared reason the two do not share.

**Where the code lives:** `deriveAgentVerificationSummary` and `assembleRunSummary` are both in
`core/runLlmPatchFlow.ts`, as is the `run_summary` emission that carries the payload; the success
flag it reads is computed in `llm/runCompletion/composer.ts`. The three subscribers are the
`run_summary` case in the TUI's `eventToActions.ts`, the same case in `cli/sink.ts`, and the
lifecycle group in `remote/toWireFrame.ts` that `remote/remoteControlAdapter.ts` broadcasts;
`printResult` in `cli/dispatch.ts` reads the result object, not the event. The reasons that reach the
fallthrough are produced in `llm/verification/staging.ts`, `llm/runCompletion/deriveResultFields.ts`,
and `llm/verification/classify.ts`, or supplied by a model tag that `parseVerificationTag` accepts.
See item 69 for the change that widened this population, item 70 for the branch `ef9d0608` corrected,
and item 60 for the entry this one is bucketed beside but not for its reason.

## 77. The plan-approval cycle: an advertised action set that disagrees with the accepted one, a replan that can degrade a plan unseen, and a decision marker with two payloads

**What it is:** three strands around the plan-first approval gate, found by one trace and recorded
together because none of them causes any other. The gate is a loop inside `runOneShotInner` that
calls `requestPlanApproval` and switches on the decision it returns; exactly one arm continues the
loop, the rest end it or abort the run. Everything below is established against `79c317f6`, the last
commit to touch that file.

**Strand A — the answer-shaped footer advertises two actions and the key handler accepts four.**
`PlanActionPrompt` chooses its footer with a ternary on the proposal's answer-only reason: an
answer-shaped proposal is offered a read-only action, a plan-a-fix action, and cancel. Its
`useInput` handler does not read that field at all — every numbered branch is live for every
proposal. So two options are reachable and unadvertised, and they do different things. One enters
feedback mode carrying the approve-and-run decision, whose dispatch arm builds its replan with
`forceSteps` inferred from the current plan's own shape, true for exactly this proposal: the answer
plan is force-stepped into a patch run. The other sends the manual decision, which ends the loop
with the stepless plan untouched and hands it to execution as-is. **The component holds two
independent copies of "which actions exist"** — the footer's ternary and the handler's branch list —
neither derived from the other and neither derived from a shared table, so a change to one leaves
the other exactly as it was. The dispatch arm's own comment acknowledges the force-stepping one
("just without the footer telling the user that's what's about to happen") and says nothing about
the other.

**This strand meets the Actionable-now bar while the entry does not, which is stated here rather
than resolved by promoting the entry.** Reconciling the two copies is a change to one component,
its own test file is already shaped for it, and nothing has to be learned first. What is not settled
is which copy moves: gating the two branches makes the keys inert, extending the footer makes them
advertised, and the two have opposite user-facing outcomes with nothing in the code or the tests
naming an intent. Item 36's treatment is the precedent followed — a specified fix kept inside an
entry whose bucket is decided by what remains, with the mismatch said plainly and the footnote left
as the mechanism that flags a mixed entry.

**The inverse of the usual guard warning: tightening the component does not tighten the protocol.**
A guard relaxed for one shape is relaxed for every shape reaching it, and the reflex is to check
what else the guard covers. Here the reflex points the wrong way. The remote-control adapter's plan
case casts the decision straight off the wire and hands it to `resolvePlanApproval` with no
plan-shape check of any kind, so gating the keystrokes closes the shape for the terminal and leaves
it open for any remote client. Whatever fix lands has to say which of the two surfaces it covers.

**Strand B — a replan can degrade a plan to stepless and nothing is re-shown.** Three things
normally guarantee non-empty steps before the loop begins: the two early returns for a
problem-asserting task whose plan came back cannot-verify or no-change, and the safety net that
regenerates with forced steps and then falls back to a synthesized minimal plan. All three sit
above the loop and none re-runs on a replan, so a schema-valid stepless-with-reason response
produced inside the loop carries forward. The looping arm shows it — the user sees the degraded
plan on the next pass — and the approve-and-run arm does not.

**That arm's non-return to the gate is its specification, not a defect, and it is recorded plainly
so a later reader does not "fix" it.** The decision type's own comment reads that it regenerates
once and then executes; the project docs call it feedback-and-run; the arm's own inline comment
states it does not loop back; and an existing assertion pins a stepped plan through it showing the
gate exactly once. What is undecided is narrower and genuinely open: whether a replan that *degrades*
the plan should re-gate, which is a different question from whether the arm should re-gate in
general.

**No decision has been made and the instrument that would inform it is empty.**
`[zone-plan-empty-approval]` fires unconditionally through the sink-reaching logger and carries a
`reviewed` field separating the two arms — true for the looping one, false for the approve-and-run
one, which is the count it exists to measure. The sink holds **zero records** of it across the
window it covers, 2026-07-29 to 2026-08-05. **Zero means the path was not walked in that window,
not that it is sound.** The more useful fact sits beside it: over the same window
`[zone-plan-decision]` carries twenty-six records and the decisions appearing in them are reject,
accept-all, feedback and timeout — **the approve-and-run decision has never been exercised in this
sink at all**, so strand A is unmeasured because nobody has pressed the key, which is a different
kind of silence from a path that runs and stays clean.

**Strand C — the decision marker carries two payload shapes on two channels.** The plan-first loop
emits `[zone-plan-decision]` through the sink-reaching logger at every terminal arm, with a payload
naming the run, the plan, the decision, the attempt number, and whether a modal was actually shown.
The staged-checkpoint path emits the same tag through the verbose-gated logger at its own two exits,
with a payload naming a mode, a decision, and a refine count — no field in common but the decision.
So a sink query on the tag returns only the first family, since the second never reaches the sink
unless verbose logging is on, and the project docs describe the second shape only. Item 76 records
the same class one instance over, where an unrelated payload shares the `run_summary` type string;
this is the sharper version, because there the two payloads at least travel on different mechanisms,
and here they share a tag *and* differ in channel, so a reader who finds the documented shape and
queries for it gets an empty result that looks like an unused feature.

**Bucket — Neither, decided on what remains across the strands rather than on the readiest one, and
checked in both directions.** What it cites: item 46 is the matching shape for strand A, an entry
whose remaining work is choosing between two named, fully-specified options and which sits in
Neither on exactly that ground; item 38 is the same with three options. Item 61 supplies the
multi-strand rule — an entry carrying bullets of mixed readiness is bucketed on what is left over
all of them, and that entry stayed Neither while holding a closed bullet. What would cite it: any
later multi-strand entry with one shippable part. **That direction is what settles it** — promoting
this entry for strand A alone would make items 61 and 74 retroactively mis-bucketed, since neither
was promoted for its most-ready part, and a rule that only applies to the newest entry is not a
rule. Strand B is an open decision, strand C an observation with no fix proposed. **Neither.**

**Where the code lives:** the approval loop, its decision switch, the two early returns, the
forced-steps safety net, and both `[zone-plan-decision]` emitter families are all in
`runOneShotInner`, `cli/dispatch.ts`; the accumulated feedback is appended to the task there too,
just above the flow call, so what the user typed does reach execution even when the plan it produced
is never shown. `PlanDecision`, `requestPlanApproval`, and `emitPlanEmptyApproval` are in
`llm/planApprovals.ts`; the footer ternary and the key handler are both in `PlanActionPrompt.tsx`;
the wire-side resolver is the plan case in `remote/remoteControlAdapter.ts`. The stepless
predicates and the terminal-shape discriminator are in `llm/executionPlan.ts`, and the approved-steps
derivation that reads emptiness downstream of the gate is in `core/runLlmPatchFlow.ts`. See item 76
for the shared-tag class strand C belongs to.

## 78. Plan content: the prompt asks for brevity in several places, the investigation's own reads are dropped at its return boundary, and the marker that would price a fix measures on inconsistent bases

**What it is:** three strands around what a plan actually *says* to the user approving it, found by
one pass and recorded together because the second and third are the feasibility and cost questions
the first cannot be decided without. Item 77 owns the approval **cycle** — which actions exist and
what each does. This is the plan's **content**, a different subject, and nothing in this document
covered it before this entry.

**Strand one — the generation prompts ask for less output in several places, and the schema has
nowhere to put a reason.** Recorded by shape rather than by quotation, since the templates are long:
the lexical template opens by asking for a *concise* plan, has a rule asking for risks *briefly*,
states a character cap for each of the two free-prose fields, and specifies the per-step description
inline as a *short* approach of one to three sentences — five instructions asking for less, of which
the investigation template repeats three. The output ceiling those five sit under is the shared
auxiliary-call cap, which a plan does not come close to, so length is not what is binding. **Neither
schema field nor prompt asks why a step is needed or what was considered and rejected**: a step
carries a title, a description, a likely-files list and two optional subagent hints, and the plan
carries an objective, risk hints, a scope summary, an optional scope note and the three mutually
exclusive terminal reasons. There is no field a rationale could go in.

**The two character caps are stated to the model and enforced nowhere.** Both prose fields are bare
strings in the schema — no maximum — and the caps exist only as constants feeding a marker that fires
when a field overruns the number its own prompt asked for. That marker has fired, so the divergence
is observed rather than hypothetical, and its own comment already frames the open question correctly:
whether the model is ignoring the cap or the cap is wrong for the job that field actually does.

**That framing was overtaken by `e6eb298e`, and what the marker measures changed with it.** That
commit removed both caps from both templates, so the model is no longer told either number and the
question of whether it is ignoring one no longer has a subject — the paragraph above is kept as
written because the caps were stated when it was, and corrected here rather than rewritten. The
marker itself was left untouched deliberately, which leaves it measuring organic field length against
a threshold nobody is given. **It is also one-sided by construction**: it fires only when a field
exceeds its constant, so it can report the tail and never the distribution below it, and a run whose
fields both come in short is indistinguishable in the sink from a run that never happened. Two
records exist after that commit, from a plan generated on 2026-08-08 whose summary and scope note
both overran, against one record before it — one plan per side of a change is not a measurement of
it.

**A constraint any fix inherits, and it is a correctness constraint rather than a preference.** The
investigation reads at most a handful of ranked files and is instructed to stop as soon as it can
write the plan. A field inviting the model to say what it *considered and rejected* invites it to
describe files it never opened — and a plan is a surface a user approves on, not a note a later pass
audits. This document already records the same failure in its own text: the seventeenth pattern is
about entries written at the end of the pass that found something, generalizing past what was
actually read, and caught only by whoever read the code next. In a plan there is no next reader
before approval. **So any added field has to be answerable from what the model actually read**, and
the honest version of "what was rejected" is narrower than the phrase invites.

**Two mechanical facts a fix pass will hit immediately.** The two templates carry near-identical
JSON-shape blocks — same field names, same inline description specification — so a schema addition
has to move both in one commit or they drift into describing different plans. And the function that
renders an approved plan *into* the execution prompt has its output pinned by exact-substring
assertions, step line included, so any new field that must survive into execution changes that
format and those assertions with it.

**Strand two — the investigation's own reads are dropped at the function's return boundary.** The
loop result carries every tool call's name, arguments, result text and success flag.
`runPlanInvestigation` reads the summary, the refusal, the cost, the iteration count, the token usage
and the termination reason, and never the call log, because its return type is the plan alone.
**Nothing is lost for generation** — the plan is parsed out of the loop's own final message, so the
model holds every file it read in context at the moment it writes. What is lost is any *later* use:
per-step detail generated lazily when a user expands a step would need a second full investigation
rather than a lookup, because the material was in hand one line before the function returned and is
unreachable one line after.

**The iteration count and the cost are lost at that same boundary, for the same reason, and one
change to the return type would carry all three.** Both are read inside the function — they feed the
completion marker, which is how they are known to exist at all — and neither escapes it, because the
return type is the plan. A caller wanting to tell the user how many iterations produced the plan in
front of them, or what it cost, meets the identical shape as the lazy-expand case: the value is in
hand one line early and gone one line late. What separates them is only what each is for — the call
log serves an expansion that does not exist yet, the count and the cost serve the approval decision
itself, which is a surface that exists today and shows neither. See item 79.

**The lazy path has a second, independent blocker, and both would have to move together.** The plan
is drawn as a committed transcript entry inside a region that writes each item exactly once, keyed on
a generation counter. Expanding a plan already drawn means bumping that key, which redraws the whole
transcript. Retaining the call log without changing the render surface buys nothing, and changing the
render surface without retaining the log leaves nothing to expand into.

**A prior conclusion about carrying content forward rests on a premise that no longer holds.** An
out-of-document audit dated 2026-06-02 dropped a proposal to pre-seed plan-read file content into the
executor, on two grounds, one being that ranked-file content was garbage-collected before anything
could use it. That is no longer true on the plan path: the quick path reads file bodies and seeds them
into generation under an explicit per-file and total character cap. The fact is stated here in its own
terms rather than as a pointer, because that audit is not in this repository and a reader of this
document cannot open it — a pointer would be a dangling one.

**Strand three — the marker that would price any of the above measures cost and tokens on
inconsistent bases.** Before `fc26fda3` the plan-investigation completion marker carried a token
total only; that commit added input, output and cache-read fields beside it, without renaming or
removing the total. The total sums input and output. **Cache-write tokens reach neither** — they are
not merged into the cache field, they are never read into the usage type at any field. So dividing
the cost this marker reports by the tokens it reports still yields a rate that prices nothing real,
which is the same defect the added fields were meant to address, one level down.

**The next step is sized and, unusually for this document, has no branch to choose.** The meter that
populates the usage type already computes the full read-and-write split on every call, into a
different accumulator, and simply never copies it across. Closing it means widening the usage type,
extending the meter's accumulation, and updating the empty and normalize helpers — plus every literal
built against today's shape, test fixtures included. One remedy, no options, not built.

**Records predating `fc26fda3` carry the total and not the three new fields**, so any analysis
spanning that commit must treat them as absent rather than zero. Defaulting them to zero understates
the earlier window and overstates what the change did.

**Every record in the sink is on the earlier side of that line, so the added fields have no data
behind them yet.** The twenty-five completion records run from 2026-07-29 to 2026-08-01 — the whole
population rather than a sampled window, and not inflated by the duplication item 73 records, since
raw lines and records distinct on that item's key agree here. All of them predate `fc26fda3`, so
every one carries the total alone. That no run has exercised the new fields since is a consequence of
the gate item 79 records rather than of anything in this entry: the default route for an additive
task skips the investigation, and this marker only fires on the path that runs it. So the three
fields are untested against real output as well as unusable for a rate, and whichever record
exercises them first will also be the first to show whether they read as intended.

**What plan generation costs today, which is why this is a decision rather than an obvious yes.**
Measured from the completion marker over a window running 2026-07-29 to 2026-08-01, collapsed on item
73's key and therefore an upper bound on real events rather than a lower one: generation costs a mean
of `$0.0977` per plan, ranging from about `$0.026` to about `$0.166`, over a mean of about `4.8`
iterations per plan with none exceeding the cap of six — the iteration figure comes from the same
records over the same window and was absent here until it was re-derived alongside them, which is
worth naming because a cost with no iteration count beside it cannot say whether a dearer plan
thought longer or merely wrote more. Joined against the archetype
marker — and noting that the investigation loop emits its own archetype-less record, which is what
makes the join easy to get wrong — **roughly a third of the cost of a run that goes on to execute is
spent before the user has approved anything**; the per-run share ranges from under a fifth to nearly
three fifths. **About half the measured runs never executed at all**, matching the recorded decision
mix, and for those plan generation is the whole of the spend. A change that makes plans longer is
therefore not a change to a small number.

**What "none exceeding the cap of six" leaves out, and the arithmetic inverts the obvious reading.**
That sentence is true and stays: nothing ran past six. What it does not say is how many *reached* six
— twelve of the twenty-five did, of which seven finished on their own at exactly six and five were
stopped there by the cap, and seven plus five is the twelve. For those five the recorded cost is a
floor on what the run would have spent, not a measurement of it. **The tempting inference from that
is wrong, and the five values are given so it can be checked rather than believed:** those runs cost
`$0.1113`, `$0.0706`, `$0.1459`, `$0.0263` and `$0.0963`, summing to `$0.4504` for a mean of about
`$0.0901`, against `$1.9933` over the remaining twenty for a mean of about `$0.0997`. Weighting those
two means by five and twenty returns `$0.0977`, the same figure recorded above, so the split
reconciles with the whole rather than replacing it. **The cap is therefore binding on the cheaper
half of the population, not the dearer one** — a reader expecting it to be trimming the expensive
tail would have the direction backwards, and a change that raised or removed it would not mostly add
cost at the top.

**Strand four — the prompt formatter and the approval renderer disagree about what a plan is, in
both directions.** The formatter reads the objective, each step's title, description and likely-files,
the scope summary and the risk hints, and emits them in that fixed order; the rendering component
draws the same five plus the scope note and the three terminal reasons. Neither reads what the other
reads, and until `edadd60c` neither side's omission was recorded anywhere.

**Four fields reached the user and not the model, and three of the four are moot rather than
pending.** The scope note was the live one — the only field carrying what the model could not see or
had to assume — and `edadd60c` closed it. Of the three terminal reasons, two can never reach an
executing model at all: the no-change and cannot-verify shapes are either returned early by the two
conjunction gates in `runOneShotInner` that pair each with the problem-asserting predicate, or, on an
additive task where those gates are inert, regenerated away by the forced-steps retry whose own
prompt branch declares the three reason fields invalid. The third does reach the loop, and its
*shape* already reaches the model — the answer-only predicate is read at two sites in `agentLoop.ts`,
selecting the summary contract and gating the max-iterations wrapup — so what the formatter drops
there is the reason text, not the distinction. Recording them as moot is the point: a later pass
reading only the field list would file three fixes where none is owed.

**Two fields reach the model and not the user, through a different function, and they persist to
disk while rendering nowhere.** The per-step subagent eligibility flag and its type are emitted by
`buildPlanAnnotationsBlock`, not by the formatter, as a delegatable-steps block. The rendering
component's own props type declares only title, description and likely-files, so it cannot draw
them — but the approval payload stringifies the whole step array, so both fields survive every hop
into the store and into saved transcripts. Three of the five persisted plans carry them on disk,
rendered nowhere. This half is open; nothing here proposes showing them.

**A third asymmetry, smaller and now closed.** For a step with no likely files the formatter emitted
a positive assertion of ignorance while the renderer emitted nothing. `edadd60c` dropped it, applying
the principle `6dfe352f` had established one commit earlier on the renderer side — omit the label
with the content rather than assert a placeholder — after confirming the placeholder string appeared
nowhere else in the repository, in no test and no snapshot.

**What that commit cost, which is the unusual part.** Nothing in output tokens: the scope note was
already generated and already billed on every plan, and the change stops discarding it. What it adds
is input, inside the first user message, which the approved-plan block already occupies and which
sits inside the second cache breakpoint's prefix — so it is paid once at cache-write and read at a
tenth thereafter. That asymmetry is why this half needed no cost decision while the half below does:
the fields already exist, the content already exists, and only the discarding was a choice.

**The corpus, anchored to the sessions that carry it.** Five plans persist in session transcripts,
four dated 2026-07-31 and one 2026-08-08. The scope note is present on all five, running from about
two hundred to about six hundred characters, mean under four hundred, which is a small fraction of
the prose a plan already emits. At least three carry an unprompted admission of the model's own
limits: one corrects its own relevant-files list, naming test files that do not reference the symbol
the task named; one records that the exact clause it needs was never confirmed and must be located
during implementation; one states that no entry-point file for the command it was asked to change
appeared in its file list, and names what it assumed instead. **That is the strongest available
argument that a dedicated uncertainty field would be filled honestly rather than padded** — the model
already writes this content into the only free-prose field it has, on every plan measured, without
being asked.

**Ranked by groundedness, not usefulness, because the ranking is the decision.** *What the model
could not see and therefore assumed* is the most grounded candidate available: the relevant-files
list and the seeded bodies are both in the model's own prompt, so a claim about what was missing from
them is a claim about its input, answerable without knowing anything about the repository. *A question
back to the user* is the same class. *Prerequisites among the plan's own steps* are grounded while
self-referential and stop being so the moment they assert repository state. *Per-step rationale* is
grounded only for the handful of files whose bodies were actually seeded, and ungrounded for the
paths delivered as names alone. **And rejected alternatives are ungroundable, which is worth stating
in the strongest terms because it is the most useful-sounding candidate and the worst to add.** To
reject an alternative is to claim it was viable and then rule it out; both halves require having read
what was, by construction, not read. The constraint this entry already records applies to it directly,
and item 79 records that nothing downstream would catch the resulting claim, since the user is the
last reader before a plan takes effect.

**Bucket — Neither, and the rule is carried deliberately while the precedent is not.** Item 77
established one commit ago that a multi-strand entry is bucketed on what remains across its parts
rather than on its readiest one, because promoting for the readiest strand alone would retroactively
mis-bucket the entries that rule was drawn from. That reasoning applies here unchanged. **Its
citations do not.** Item 77 leaned on item 46 and item 38, whose remaining work is choosing between
named options — and strand three has no options to choose between, so those precedents do not reach
it. The one that does is **item 74**: three strands, all open, one of them a specified change that
was deliberately separated rather than built because it moves a signature and its call site. That is
strand three's shape exactly, and item 74 sits in Neither holding it. What would cite this entry: any
later entry whose most-ready strand is specified with no remedy to pick. Promoting on that basis
would mis-bucket item 74 by the same argument item 77 made about its own precedents. Strand one is a
design decision nobody has made, strand two is blocked on it and on a second change besides.
**Neither.**

**Re-checked after two strands partly closed, rather than inherited.** `e6eb298e` closed strand one's
prompt-side half and `edadd60c` closed strand four's backward-looking half, so the question is whether
what remains still fails the Actionable-now bar. It does, and by a wider margin than before: what
closed were the two parts that needed no decision — removing instructions, and stopping a discard —
and what is left is the part that needs one. Strand four's forward half is a ranking of five
candidate fields with no choice made among them and one named unbuildable; strand one's remaining
half is the same design decision it always was; strands two and three are unchanged. Applying the
two-way check the rule requires: nothing here would cite this entry as precedent for promotion, and
promoting it because two halves closed would say that an entry becomes actionable by having its
easy parts removed, which is the opposite of what the bucket measures. **Neither, more firmly.**

**Where the code lives:** the lexical template, the plan schema, both advisory-cap constants, the
overrun marker, and the approved-plan renderer whose output is pinned are all in
`llm/executionPlan.ts`; the investigation template, the iteration and file caps, and the completion
marker are in `llm/planInvestigation.ts`; the loop result's call log is declared on `AgentLoopResult`
in `llm/agentLoop.ts`; the usage type and its empty and normalize helpers are in `llm/subagents.ts`,
and the meter that populates it — along with the accumulator that already holds the read-and-write
split — is in `llm/tokenBudget/TokenBudgetMeter.ts`. The plan's rendering component and the
committing transcript region that draws it are in the TUI's components directory, and the file-body
seeding with its caps is in `runOneShotInner`, `cli/dispatch.ts`. For strand four: the formatter, the
block that wraps it for the first user message, and the revision note that reuses it are all in
`llm/executionPlan.ts`; the delegatable-steps block that carries the two subagent fields is
`buildPlanAnnotationsBlock` in `llm/agentLoop.ts`, which is also where the answer-only predicate is
read at its two sites; the two early returns and the forced-steps retry that make the other two
terminal reasons moot are in `runOneShotInner`; the payload that stringifies the whole step array is
in `llm/planApprovals.ts`, and the props type that declines to declare two of its fields is the
rendering component's own. See item 77 for the approval cycle this content is presented through, and
item 73 for why the figures above are upper bounds.

## 79. Plan context assembly: the gate that skips investigation routes on a lead verb, the context it hands the model is a handful of files and one wrong summary line, and the approval surface shows none of it

**What it is:** two strands around the *input* a plan is written from, and around what the surface
presenting that plan says about where it came from. Item 77 owns the approval **cycle** — which
actions exist and what each does. Item 78 owns the plan's **content** — what the prompt asks for and
what the schema has room for. This is a third subject, and nothing in this document covered it before
this entry. The two strands are recorded together for the reason item 77 gives about its own second
strand rather than the one item 78 gives about its: strand two is not a feasibility question strand
one cannot be decided without, it is the **instrument strand one would have been caught by**, and it
is absent. Established against the tree at `e6eb298e`; every figure drawn from a run comes from one
plan generated on 2026-08-08 and is named as such.

**Strand one — the gate decides how much context to gather without looking at the context it
already has.** The branch between a single lexical generation call and a full investigation loop is a
negation of one predicate in `llm/taskShape.ts`, and that predicate is a single regular expression
anchored to the task's first word. Nothing else is consulted — not the classifier, not the repo, not
the file list. And the file list exists by then: `runOneShotInner` awaits the context preparation
*before* it evaluates the branch, so the decision about whether the model needs to read anything is
taken with the list of what it would read already in hand and unexamined.

**Three more signals now reach the caller and are recorded but still not consulted, which is a change
in what is available rather than in what the gate does.** The context preparation computed the scanner's own
total file count, the ranker's per-file scores, and the raw grep-match set, and returned none of
them: its result type carried the project summary and the merged path list alone, so all three died
at that function's return. `774c9592` returns them raw — a count, score pairs, and a path list, with
no threshold and no classification — on the reasoning that whatever a gate concludes from a score
distribution is the gate's business rather than the context builder's. The grep field is the set as
the matcher handed it over, before the filter that drops paths the ranked list already holds; it is
not a pre-cap value, because the matcher applies its own ceiling internally and returns an
already-bounded set. **They were returned with no reader, and `dc8a1e60` is the reader**: the gate's
own marker now carries all three beside the outcome it already recorded, plus the merged list's
length, which was in scope at the marker all along and is a fourth quantity rather than one of the
three. The strand is unchanged in substance — the gate still consults a lead verb and
nothing else — and what moved is that the material it would need sits on the caller's side of the
boundary instead of dying inside it.

**What that marker cannot answer, which is the ceiling on any before-and-after comparison across a
change to this gate.** Only the total is captured outside the context builder's guarded block; the
other three are declared with empty defaults and assigned only inside it, so a throw from the ranker
leaves all three empty. **The ordering is what keeps that from being the wider claim it looks like,
and it is worth naming so a later reader can check it in one look:** the grep runs *after* the
ranker, in the same guarded block, and takes the task and the full scanned list — never the ranked
result — so an empty ranking still lets the grep run and report matches. A throw is therefore
distinguishable from a legitimately empty ranking *except* when that ranking's grep also comes back
empty, which is the only genuinely ambiguous case. Beneath it sits an older one this arc did not
introduce: a zero total means the guarded block never ran at all, and a truly empty repository is
indistinguishable there from a scan that threw, because the scan's own catch supplies the same empty
list either way. Neither is proposed for a fix; both are what a pass claiming to have measured a
gate change has to state it could not separate.

**What the widening costs, with its store, and it is a constructed figure rather than a sink
reading.** Serialising a representative payload at `dc8a1e60` — real path and score shapes taken from
a live probe of this repository — gives 574 bytes against the pre-widening 121, so roughly 453 bytes
more per gate decision, and one decision is one emission rather than one per iteration. Constructed
deliberately instead of measured off the sink: a figure read from the sink would first need item 73's
dedup key applied to it, where this one sidesteps the instrument entirely. The sink's own cap is a
whole-file rotation threshold rather than a per-record limit, so nothing about the wider payload
approaches a bound.

**The instrument has not fired once, which is the precondition any comparison across a gate change
rests on.** Read on 2026-08-09: the gate marker holds nineteen records spanning 2026-07-31 to
2026-08-08, and all nineteen carry the four widened fields as absent, because every one of them
predates `dc8a1e60`. So the baseline for the inputs is empty, not thin. **Item 74 records the
adjacent shape and the difference decides how each reads:** there, every record predates a change and
therefore measures the world before it, which is a usable baseline and is named as one. Here the
records predate the *field's existence*, so they are not a measurement of anything to compare
against — an absence rather than a prior value. A pass changing the gate today would be setting a
window without the inputs against a window with them and calling the difference an effect.

**The cheaper path is the one already running, and the alternative is priced so the choice is on
record rather than only its conclusion.** All four values are computed on every quick-path run
whether the gate investigates or not, so ordinary use accumulates them at no marginal cost and no
scheduling — the only requirement is that runs happen. Buying the same records deliberately means
running investigate-first tasks at the mean this document already records, around a tenth of a dollar
each, so a few dozen is a few dollars plus the wall-clock; and a deliberate set drawn from one
repository would still leave the file-count signal a near-constant, which is the thing it would most
need to vary. Waiting costs nothing and buying does not fix the sampling problem it would be bought
to fix.

**A sibling predicate in the same module disables both refusal paths for the same task shape.** The
two early returns that honour a plan coming back cannot-verify or no-change are each a conjunction
with `taskAssertsProblem`, which tests its own additive lead-verb list first and returns false before
reaching any problem word. The two verb lists are not identical — the pure-addition one excludes the
structural verbs and the ambiguous one — but they agree on an additive lead verb. So the task shape
that skips investigation is also the task shape whose refusals are discarded.

**Where the two lists disagree, the cost lands the other way round, which the sentence above stops
short of drawing.** The structural verbs and the ambiguous one are in the problem-predicate's list
but not the pure-addition one, so a task led by any of them takes the opposite pair of decisions: the
gate sends it to a full investigation, and both refusal exits stay dead anyway, because the
problem-predicate returns false on its own additive test before reaching any problem word. A rename
or a migration therefore buys the most expensive planning path available and then discards a
no-change or cannot-verify verdict if the investigation reaches one. Agreement on the additive verbs
is what the sentence above records; disagreement on the structural ones is the same mechanism costing
more, not less.

**A third consumer of the same predicate is negated, so the additive task is the one it fires on.**
Besides the two refusal exits, the merge of explicit path tokens from the task text into the first
step's likely-files — the floor the write-scope guard later reads — is gated on the predicate being
false. The task shape that skips investigation and cannot decline is therefore also the only shape
that gets its literal path mentions forced into scope, which is the one place this predicate's
additive branch adds a capability rather than removing one.

**Three mechanisms in series then convert a refusal into steps, and item 77 records the same three
from the other side.** With the early returns gated off, a plan that comes back with no steps is
regenerated with the forced-steps flag, whose prompt branch replaces the three terminal-reason field
descriptions with a comment saying they are not valid for this task and adds an instruction that at
least one concrete step must be returned; behind that sits a minimal-plan synthesis built from the
task text and the file list. Item 77's second strand records these three as guarantees sitting above
the approval loop that do not re-run on a replan, which is the defect on that side. On the first pass
they are the reason an additive task cannot decline at all: each turns an absence of steps into
steps, and they fire on exactly the shape that also got no investigation.

**What a stepless plan would have done downstream is narrower than "the guard goes off", which
matters because that is the usual reason given for closing the refusal side first.** The write-scope
guard has several returns of no-opinion, and an empty step list reaches only one of them: it declines
to constrain a plan with no steps *unless* the plan is answer-shaped, in which case it returns a hard
block on every write instead — the opposite of going off. Of the other no-opinion returns, two are
archetype and bookkeeping-directory exemptions that have nothing to do with plan shape, one covers a
plan that is absent or malformed, and the last covers a plan that has steps but names no valid path
between them, which the minimal-plan synthesis can produce when the task carries no path token and
the ranked list came back empty. So the mechanisms above do not stand between the user and an
unconstrained agent in the single way the phrase suggests; they stand between the user and a plan
that cannot say no, and the guard's behaviour on the shape they suppress depends on which stepless
shape it was.

**The repo summary was one line and, for this repository, the wrong one — closed by `a2fa9ee8`.**
The context preparation joins the notes a structure detector returns. Measured against the dogfood
worktree on 2026-08-08 that detector returned a single note, `React-like frontend detected`, and that
string was the entire repo-summary block the model received for a Node TypeScript command-line tool.

**What produced it, and the distinction that decided the fix's shape.** The old function keyed on
nothing but file paths — its input is the scanned file list and it never opened a manifest — so no
installed package could have caused this. Its frontend test matched on a file *extension*, and this
repository has dozens of files carrying it under the terminal-interface tree, plus one whose name the
same test matched a second time. The detector was therefore not reporting React because React is
present; it was reporting an extension. **And the single note was coincidental, not structural:** the
function built its notes from a series of independent pushes and could return all of them, and
returned one because every other test matched nothing. That mattered — a structural
returns-at-most-one defect would have needed the selection rewritten, where this needed the tests
themselves replaced.

**What replaced it.** Detections now run in tiers ordered by discriminating power — runtime and
language first, then project kind, then frameworks — keyed on what the manifest declares: the module
type, a declared binary entry for command-line kind, an exports map for library kind, dependency
names for frameworks, with a config file or a source extension for language. The note count is capped
at five, and the basis for the cap is this entry's own strand about cost: the summary lands in every
plan prompt on both generation paths, and that call is fully uncached, so every note is paid at full
input rate on every generation. Tiers one and two are at most four notes together, so the cap can only
ever truncate the framework tier. Before `a2fa9ee8` this repository's whole summary was
`React-like frontend detected`; after it, `Node.js project (ESM) TypeScript Command-line tool
(declares a bin entry) Ink terminal UI`.

**Two consumers beyond plan generation share this function, which a later pass changing it needs to
know.** The patch flow joins the same notes into its own project summary, and the feature agent reads
two of the returned booleans into a context string. Five of the returned booleans have no reader at
all. The returned type is unchanged by `a2fa9ee8`, so neither consumer moved.

**The finding that outranks the fix: a declared signal is not automatically better than an inferred
one, and this repository proves it twice in opposite directions.** The rule the fix started from was
prefer-what-is-declared, and taken plainly it would have failed. `react` is a genuine production
dependency here, pulled in by the terminal-interface library, so a declared-dependency test on it
would have produced exactly the wrong line the path test produced. What is conclusive is the
**absence** of the browser-DOM package, which a browser React application must carry and a terminal
one never does. In the other direction, `express` is declared at a real version with one surviving
type-only import long after its server was deleted; keying on that declaration alone made the backend
detection fire, a regression introduced during the fix and caught before it landed, so the detection
now requires the declaration *and* a server-shaped layout — which costs a single-file Express
application its note, the cheaper error under a rule that a missing note beats a wrong one. **The
corrected rule: what matters is not whether a signal is declared or inferred but whether it is
conclusive for the question being asked.** In an ecosystem where dependencies arrive transitively,
the presence of a package is weak evidence about what a project *is*; the absence of a package that a
given kind of project must carry is strong. Recorded here rather than left in the commit message
because a later pass reading only what the notes now say would re-derive it at the cost of the same
regression.

**The ranking is lexical, and three of its inputs are dead on this path.** The ranker accepts optional
semantic scores, a recently-changed file list and a task intent; the plan path passes none of the
three, so the hybrid branch, the last-changed boost and the intent boost are all unreachable here.
What runs is a keyword score over paths and names, plus a content pass that opens files — but only the
highest-scoring thirty by that same keyword score, so a file the path score does not already favour is
never read and cannot be rescued by what is inside it.

**Four caps apply in series and two of them are defects.** The ranker returns at most its own
context-file cap, five files by default. The context preparation then slices that result to its own
maximum of eight — **a longer bound applied to a shorter array, which can never bind** — and appends
grep matches afterwards, which is what takes the list past five in practice. The generation prompt
then renders only the first eight of whatever it is handed, so for the run on 2026-08-08, which
computed nine paths, the ninth never reached the model. And the dispatcher seeds file *bodies* for the
first five under its own per-file and total character caps. The distance between a path the model can
see and a path whose contents it can read is therefore several positions wide, and is stated nowhere.

**Widening a cap does not reach the file the task was about.** Re-running the same ranking against
the dogfood worktree on 2026-08-08 with the context cap lifted places the command-line entry point
four hundred and thirty-eighth of the eight hundred and seventy-five files that survive the ranker's
skip filter, at a score of one against a top score of five hundred and seventy-nine. It is not near a
boundary. The list's last four entries were all remote-control modules, of which the prompt showed
three; the plan named two of them as the command's home — present to the model as bare paths, never
seeded, so it attributed the feature to filenames it had not opened.

**The referent did not exist, and the consequence is the part worth stating plainly.** The task named
a `plan` command; the command-line surface declares one sub-command, and `plan` appears only as a
documented value of the permission-mode option, beside an output-format option that already offers
JSON. Given a summary line naming the wrong kind of project, eight paths of which three are test
files, five seeded bodies of which three are one module and its tests, and a task naming something
absent, **the plan the model produced was close to the best available inference from what it was
given.** The defect is not that it guessed badly. It is that nothing in the pipeline can say the input
was insufficient — and the model did say so, in the scope note, which is free prose that reaches the
user and nothing else.

**The gate's own marker records which rule decided, not what it decided.** It records the branch
taken, the lead verb that matched, and a third field whose value reads `default-non-additive`
whenever no environment override is set — including on the additive task that made the gate skip,
where it sits next to a recorded lead verb of `add` and a recorded mode naming the lexical branch.
The field distinguishes the default predicate from an override, which is what it is for and what it
reports correctly.

**That juxtaposition was read here as a contradiction, and it is not one — the sentence saying so is
withdrawn.** What stood in the paragraph above claimed the field's *value* named an outcome it did
not measure, and that a sink query filtering on it for additively-routed runs would return the
opposite of the intended set. Both halves are thrown out. The value is a source label: it names which
rule reached the decision, and the sibling arm of the same ternary is the bare word for the override
mechanism, which no reading construes as an outcome. `mode` sits beside it, emitted unconditionally
on both branches, and is the field that carries the outcome; a second field re-deriving the same
outcome would be duplication that nothing asked for. The paragraph above already contained the
correct reading — that the field reports the default-versus-override distinction correctly — and the
withdrawn sentence contradicted it one clause later, which is what a false claim looks like when it
is assembled next to the fact that disproves it.

**What settled it was the introducing commit, not the current code.** The field arrived, in the
commit that first gated investigation on task shape, reading the deciding predicate's own function
name against the bare word for the override — a source label with no second available reading. The
later commit that inverted the gate to its fail-safe form swapped the predicate and renamed that
literal in the same move, to a phrase naming the new default rule's disposition rather than any
task's outcome. The value has tracked which rule is in force for as long as it has existed. No
change is owed, and `a4824f39` withdrew the one that had been drafted.

**The two assertions on that field pin its presence, not its discrimination.** Both live in the
gate-marker test file, both name a branch in their own titles, and a mutation of the shared literal
run in `a4824f39` killed both. A value asserted identically on either side of a branch cannot witness
that branch — consistent with a source label, and the reason those two tests were left as they are.

**Strand two — the proposal carries content and no provenance.** Its fields are the plan and run
identifiers, the objective, the steps, the scope summary, the scope note, the risk hints and the
three mutually exclusive terminal reasons. The rendering component draws those and nothing else.
Neither the action nor the component carries an iteration count, a cost, a list of what was read, or
which of the two paths produced the plan.

**So a lexical plan and an investigated plan render identically**, and every difference that exists
lives outside the payload: the tool-call lines an investigation emits into the transcript above the
plan, elapsed time, and the cost in the status bar. A user approving a plan cannot distinguish one
written after reading files from one written from a handful of bodies picked by keyword — and on
2026-08-08 it was the second, with the module the task was actually about not among them.

**The zero cost was the lexical path's accidental signature — closed by `9874eb91`.** The store's
cost field was written by three events — loop completion, run summary, and the per-iteration cost
update — all of them agent-loop events when this was written. The lexical generation function took no
progress callback at all, so it could emit none of them and the field stayed at the value the initial
state gives it, while `runPlanInvestigation` explicitly re-emits the per-iteration cost and
token-budget events out of its inner loop and so did show a live figure at the same gate. The signal
was real and unusable: it is indistinguishable from accounting that is simply broken, which is how it
was read when it was noticed. The call is not free. The usage log records `$0.0515` for the plan
generated on 2026-08-08 against a displayed `$0.0000`, written there because the client factory wraps
every client in the recording one, and fully uncached with both cache counters at zero.

**What made it a wrong statement rather than a missing one, which is the part worth keeping.** The
status bar composes its left-hand text with the token figure suffixed only when that figure exceeds
zero, and the cost rendered unconditionally to four decimal places. The same run therefore showed no
token suffix at all and a `$0.0000` — one quantity absent, the other asserting. An absent figure
invites the question; an asserted zero answers it, wrongly, and a reader has no reason to doubt it.
The asymmetry is in the two renderings rather than in the two values, and it is why this was worth a
fix while the missing token count beside it was not.

**The derivation, and why it cannot drift from the ledger.** The generation function now takes an
optional cost callback and, when one is supplied, pulls the usage buckets out with the same exported
extractor the recording wrapper uses, prices them with the same shared pricing function, and rounds
with the ledger's own four-decimal helper — exported by that commit rather than copied, so the emitted
figure and the persisted row cannot round apart. The price is taken from the model the API echoes
back, falling back to the requested model only when the echo is absent, which is the recording
wrapper's own precedence reused rather than reimplemented. The emission sits after the refusal throw
and before the response is parsed, because the money is spent whether or not the text that comes back
parses; the investigation path's own repaint sits *after* its parse instead, which is safe only there,
because the parse helper it calls swallows its own failures and returns nothing where this one throws.

**The accumulator, and why forwarding each call's own figure would have been worse than the zero.**
The store's status action SETS the cost field rather than adding to it, and one pass through this gate
can call the generation function more than once — the forced-steps regeneration above, and a replan on
each feedback round. A callback wired straight through would have let a cheaper later call overwrite a
dearer earlier one, replacing an obviously wrong zero with a plausibly wrong number, which is the
harder of the two to catch. The gate instead keeps a running total for the flow, declared outside the
approval loop so repeated feedback rounds keep adding to it, and forwards the total rather than the
increment.

**The investigation path seeds that total through the event it already emits, because its return
value carries no cost.** Both of `runPlanInvestigation`'s returns yield the plan alone; the loop's
cost is read inside the function for the refusal throw and for the synthetic repaint, and reaches the
caller through neither. The mixed case is reachable — the branch choosing between investigating and
generating closes before the forced-steps regeneration, so an investigated plan that comes back
stepless is followed by a lexical call in the same pass — so the gate wraps the progress callback it
already passes down, reads the cumulative figure off the repaint event as it goes past, and forwards
the event untouched. Nothing about the investigation path's own behaviour changes.

**Verified end to end rather than by inspection.** On a run dated 2026-08-08 the status bar and the
usage ledger row carrying the same run identifier agreed exactly, both at `$0.0747`.

**The first measured pair, and what one pair cannot support.** Two runs of the same task text, both
dated 2026-08-08 and both recorded by the gate marker as the lexical route, now sit in the ledger
under their own run identifiers. The earlier drew about six thousand nine hundred uncached input
tokens and about two thousand one hundred output, at `$0.0515`; the later about six thousand three
hundred input and about three thousand seven hundred output, at `$0.0747`. Output rose by roughly four
fifths while input fell slightly. **Two commits landed between them** — the removal of the brevity
instructions from both templates, and the repo-summary correction — so the rise is not attributable to
either alone, and it is one pair rather than a distribution. Item 78 records the general form of the
insufficiency, that one plan per side of a change is not a measurement of it; what it does not say,
and what this pair makes concrete, is that two changes landing in the same interval are not separable
afterwards from whatever records the sink happens to hold. A measurement has to be built rather than
read: a fixed task set run against each side deliberately, one change at a time. Neither run exercised
the token-breakdown fields item 78 records as having no data behind them — those are populated only by
the investigation path's completion marker, and both of these took the lexical route, so that
population is unchanged.

**A second dollar figure on the same line disagrees with the first, and it is a different quantity
rather than the same one twice.** The status bar's badge line carries a used-against-cap figure beside
the run cost just corrected. Established by shape: it reads a different store field, updated by one
action with one dispatch site, fed by the usage aggregate over a rolling twenty-four-hour window
across every record in the ledger under the TUI's fixed user identifier — a whole-window total, not
this run's. It is rounded differently at two removes, the aggregate using the two-decimal helper where
the per-record row uses the four-decimal one, and the badge rendering two decimals against the cost
field's four. And it is refreshed once per run, after the run's costs reach disk, so at a mid-run
surface such as the approval gate it necessarily carries the value left by the previous run's
completion. **That last sentence was written as if the update action were the field's only source,
which is incomplete rather than wrong.** The same aggregate is read a second time at TUI startup and
seeded into the store's initial state, so on a session's first run the badge shows neither this run's
cost nor a previous run's completion value but whatever the window held when the process started.
The per-run refresh is the only *update*; it is not the only writer. **What remains unknown is which of those accounts for the gap actually seen.** For the
later of the two runs above the rolling window totals `$0.1262`, which the badge would render as
`$0.13`, while the value left by the previous completion would have been `$0.05`. A reported gap of
roughly a third matches the second, but the badge is not written anywhere — nothing persists it — so
which figure was on screen is not established here, and no fix is proposed. **This is not item 76's
class, and the check is worth recording because the surface invites it.** That entry is about one name
denoting several unrelated artifacts, so a query on the name returns all of them; these two fields are
distinctly named and nothing about their naming misleads. What misleads is adjacency — two amounts in
the same unit on one line, over different denominators, with neither labelled by the window it covers.

**The plan the fix ran against, filed to the strands it is evidence for.** The later run produced a
plan whose first step names the command-line entry point, where the same task on the earlier run named
two remote-control modules by guess — the persisted earlier plan carries both — so this is the summary
strand above working end to end, since the correction is what put a command-line tool in the model's
context. Three things it did not fix, each evidence for a strand already open. The task named a
command that does not exist in that worktree and nothing in the pipeline said so, which is the
referent paragraph above. Two later steps still treat a module as the home of plan serialization on
the strength of its filename, never having read it, which is the caps paragraph above — the same
never-seeded-so-attributed-by-name mechanism recurring after the summary was corrected, which is what
shows the two independent. The third has no owning strand: one step is a verification rather than an
implementation step, which the lexical template's own instruction to break the task into a bounded
range of implementation steps pressures toward. That instruction asks for *more*, where item 78's
strand one enumerates the instructions asking for *less* — the subject is item 78's, what the prompt
asks for, but no strand of it covers a floor on step count.

**Where those observations come from, since the window is part of them.** The later run's plan is not
on disk. Its gate marker and both of its cap-overrun records are in the sink and its usage row is in
the ledger, but no decision marker was written and no session file carries it — the session is written
when the TUI exits, which the strand below records, and that had not happened. So the earlier plan is
re-readable and the later one is a reading of the live approval surface. Recorded that way
deliberately: the eighteenth pattern is about this exact window, and both of its instances are in this
entry.

**The gate's own test surface could not see which branch fired, and it is now closed across all
three files.** The decision-marker file ran an additive fixture through the gate on every one of
its tests while asserting only on the decision marker's payload, which carries no plan-derived field
— run identifiers, the decision, the attempt number, the reviewed flag, and nothing read off a plan —
so every one of them was blind to the routing its own comments assumed. The answer-only safety-net
file was blind the same way. `a4824f39` closed those two, each gaining one assertion naming which of
the two generation functions was called, and `2d5316af` closed the stepless-replan file the same way.
That last file was the one worth measuring: each of its tests queues two plan responses expecting the
first to be consumed by the initial call and the second by the replan, an ordering a misroute
silently re-slots. Recorded in this entry rather than as its own because the subject is this gate's
observability, which is what the entry is about, and the blindness is a property of the gate's tests
rather than of any mechanism the other entries own.

**What the blindness actually cost is visible in the mutation that closed it, and it is not what
"blind" first suggests.** Inverting the gate's default arm killed every test in that file. Five died
on a call-count or length mismatch downstream of the replan draining the wrong queued value, three
crashed reading a second generation call that no longer existed, and one reported the routing fact
directly — the assertion added for it. So a misroute was always going to fail that file loudly; what
the file could not do was say what had gone wrong, and a reader would have spent the failure on the
replan ordering rather than on the branch above it. The distinction is worth keeping: these tests
were not insensitive to the defect, they were unable to name it.

**That surface has a blind spot for the signals the marker now carries, and it was predicted before
it could fire rather than found after.** Exactly one fixture object in the whole dispatch test
surface supplies a file count, ranked scores or grep matches, and it lives in the gate-marker file,
where its four tests assert on the emitted payload and never on routing. Every other context mock
across the thirteen files that stub the context builder returns a project summary and a path list
alone. So a gate modified to consult any of the three would read `undefined` in every routing test in
the repository and pass — the six fixtures pinning the branch would keep asserting the same routing
while exercising a comparison the change never intended. The remedy is cheap and belongs to whichever
pass makes that change: supply the signal in the fixtures before claiming the routing tests cover it.
Recorded here rather than as a pattern because the prediction-before-firing part has one instance
against the two the eighth pattern already holds from the other direction, which by the seventeenth's
own precedent is too few to generalize from.

**A leaked environment stub in the refusal-path file was also closed there, and it had not been
doing harm.** That file pinned the routing override for two of its blocks and never restored it,
where four sibling files restore the same variable. Every test downstream of the leak inside that
file wanted the pinned value anyway, and a full-suite run immediately before and immediately after
the fix returned identical totals, which is the evidence that nothing outside the file had been
inheriting it.

**The opposite failure of the same discipline sits in the context builder's own test file, and the
pair is what makes either one legible.** Two environment variables are read on that path — a scan
ceiling in the repository scanner and a context-file cap in the ranker — and neither was pinned
anywhere in that file, so every assertion in it ran against whatever the developer's shell happened
to hold. `774c9592` stubs both to their own coded defaults and unstubs after each test. The first
instance was a stub set and never restored, leaking outward to whatever ran next; this one is a read
never pinned, leaking inward from the ambient environment. Opposite directions, one missing
discipline — a test file owns the environment it reads as well as the one it writes, and only the
writing half had been noticed here before.

**What is lost where, per value, since the answers differ and a fix pass needs them apart.** The
iteration count and the cost of an investigated plan exist on the loop result and are dropped at that
function's return — retrievable at that boundary, which is why item 78's second strand now records
them beside the call log. The list of files read is the same boundary, surviving only as transient
transcript lines. The lexical path's cost is not lost at a boundary at all: it is written to the usage
log and never routed to an event, so it is on disk and absent from the process. Which path ran exists
only in the gate marker. **Nothing about provenance is unavailable; all of it is unrouted** — which
makes this plumbing rather than instrumentation, and is the one part of this entry where the shape of
a fix is not in question even though its surface is.

**What already joins after the fact, which is a different question from what is routed and was never
in doubt here — added because nothing states it.** The paragraph above is about values not reaching
the process's own event stream; it says nothing about reading the stores afterwards, and the run
identifier does that work today. Measured over a sink read on 2026-08-09, the gate marker's run
identifier matches the decision marker on all nineteen of its records, the investigation completion
marker on all seventeen of the runs it sent to investigation, the archetype marker on seventeen, and
the usage ledger on all nineteen. So a gate decision can already be read alongside its cost, its
iteration count, its archetype, its approval outcome and its token spend, by one key, with no work
owed. **The exception is the plan itself, and it is total:** the persisted transcript entry carries
the objective, the steps, the scope summary, the scope note and the risk hints, and no identifier of
any kind — its session file's only identifier is the session's, which appears in no marker store, and
the plan identifier the decision marker carries is never written beside the plan text. So every
question about a plan's *provenance* is answerable and every question about its *content* is not.
Recorded as the gap it is, with what would close it named — a plan identifier on the persisted entry,
or a run identifier on the session — and neither proposed here.

**What that join yields once read, and why the obvious question is not among the answers.** Of the
nineteen gate records, seventeen took investigation and two took the lexical branch; thirteen of the
seventeen ended in a rejection or a timeout, four in an acceptance, and both lexical runs ended
terminal. The question those numbers invite — did a run take investigation without needing it — is
**not answerable from them, for a reason the eighteenth pattern's qualification already owns**: no
field records *why* a plan was rejected, so the decision value has several states behind it and
cannot be read back to one. That is the ambiguous-value case, cited rather than restated.

**The second reason is separate from the first, is not owned anywhere, and is the sharper of the
two.** Every one of those records was produced by the operator building this feature, inspecting
plans as they appeared. A rejection in that population is an artifact of who was watching and how
closely, not a verdict on the plan — the split measures the operator's attention. Stated plainly
rather than as a caveat, because a caveat attached to a number gets dropped when the number is
quoted: **this rejection rate is not evidence about plan quality and no reading of it can be made
into evidence about plan quality.** What the same records do support is the routing split, cost per
route, the iteration distribution, and the share of investigation spend on runs that never executed
— none of which depend on why anyone rejected anything.

**A plan declined at the gate persists in full.** The session file is written when the TUI process
exits, not when the run ends, so the plan rejected on 2026-08-08 is on disk complete: the
`plan_ready` transcript entry the store appended, carrying the objective, all five steps with their
likely-files, the scope summary, the scope note in which the model reported its own missing context,
and every risk hint. The sink holds five records for the same run — the gate marker, the key-source
line, both cap-overrun records, and the decision itself, a rejection on its first attempt. So the
plan's *content* survives rejection, and the branch it took and the fact of the rejection survive
beside it. What is absent is what the run cost — the session's own total reads zero, for the reason
the strand above gives — and what was read to produce it. That is a provenance gap, not a
persistence one.

**The zero reached disk, which the sentence above leaves implicit, and whether the repair follows it
there is still open.** The session writer takes its total straight from the status-bar cost field, so
the same value the strand above records as displayed is the value persisted: the session written on
2026-08-08 carries a zero total, while the four investigation-path sessions dated 2026-07-31 carry
real ones. `9874eb91` fixed the field. Whether it fixes the persisted total follows by construction
and has not been observed — no session has been written on the lexical path since that commit, so
this stays open until one is.

**Both halves of the preceding paragraph were false when first written here, and the way they became
false is a repeatable error rather than a slip.** This entry originally said the plan persisted
nowhere and that only three records survived. Both readings were taken while the run was still open
— the decision marker was emitted minutes after the sink was read, the session written about an hour
after that — and a measurement of an in-flight process was generalized into a claim about what
exists. The eighteenth pattern is the general form and this is one of its two instances.

**Bucket — Neither, on item 77's rule, and with the citations distinguished again.** Item 77
established that a multi-strand entry is bucketed on what remains across its parts rather than on its
readiest one; item 78 carried that rule while rejecting item 77's citations on the ground that a
precedent's applicability lives in what makes it safe. The rule applies here unchanged and the
citations again do not transfer: item 46 and item 38 are entries whose remaining work is choosing
between named options, and most of what is above has no options named — what provenance a plan should
carry is a question nobody has posed, let alone narrowed to a choice. (This sentence also named the
summary line when it was written; `a2fa9ee8` answered that one, and the strand above records how.)
**One precedent that did reach has been withdrawn.** This paragraph cited **item 74** for a single
specified fact — that the gate marker's field was a one-word rename, held back only because the value
is a sink key every historical query over that marker matches on, which is item 74's own shape. The
strand above records that there is nothing to rename, so the citation has lost its subject and goes
with it: the sink-key objection was a reason not to make a change that turns out not to be owed, and
a reason not to do something unnecessary is not a precedent for anything. That leaves the two
remaining candidates for readiness, the inert maximum and the dropped ninth path, neither of which
has an agreed target to align on. **Checked in the other direction, as item 77 requires** — no entry
cites this one for that precedent, so withdrawing it moves nothing else's bucket, and item 74 keeps
its own place on its own facts. **Neither.**

**Re-checked after the summary strand closed, rather than inherited.** `a2fa9ee8` closed one of this
entry's strands outright, which is a stronger event than the partial closures item 78 re-checked
against one commit ago — and it still does not promote the entry, for the reason item 78's note gives:
an entry does not become actionable by having a part removed, whatever the size of the part. The check
that decides it is what remains, and what remains is the same set as before minus one: a routing
predicate nobody has decided to change, three step-guaranteeing mechanisms whose correct behaviour is
genuinely open, four caps with no agreed target, and a provenance surface with no proposal. **Item 79
differs from item 78 in what closed, not in what governs** — item 78's closures were the parts that
needed no decision, this one was a whole strand, and neither changes that the bucket measures the
remainder. Checked in the other direction: promoting on the strength of a closed strand would make
item 61 retroactively mis-bucketed, since it holds a closed bullet and stayed Neither on exactly this
reasoning. **Neither.**

**Re-checked again after the cost strand closed, and what governs is the rule already applied one
strand ago rather than anything about this closure.** `9874eb91` closed the lexical path's zero-cost
signature outright — the second strand-sized closure this entry has taken, where item 78's re-check
was against partial ones. The note item 78 established still decides it: an entry does not become
actionable by having a part removed, whatever the size of the part, and the bucket measures the
remainder. That remainder is the previous set minus one — the routing predicate, the three
step-guaranteeing mechanisms, the four caps, and a provenance surface that now shows a true cost and
still says nothing about which path produced the plan or what was read to write it. This pass also
*added* two open questions above rather than only removing one. Checked in the other direction, as the
rule requires: promoting here would retroactively mis-bucket item 61, which holds a closed bullet and
stayed Neither on this reasoning, and item 78 itself, which stayed Neither after two of its own
strands partly closed. **Neither.**

**Re-checked a third time, after the test-surface strand closed, and the rule does not need
restating.** `2d5316af` closed the last of the three blind files, which is the third strand-sized
closure this entry has taken, and item 78's note has now decided all three the same way. The
remainder is what it was: the routing predicate, the three step-guaranteeing mechanisms, the four
caps, and a provenance surface that still says nothing about which path produced a plan or what was
read to write it. The three signals recorded above have since gained a reader in `dc8a1e60`, and that
moves nothing here either — item 78's note is about a part closing, and a field gaining a consumer is
not even that: the decision still consults none of them, and the paragraph above adds two named
limits, so the entry is marginally more open rather than less. Checked in the other direction: item 61
and item 78 both hold closed parts and both stayed Neither, so promoting here would retroactively
mis-bucket both. **Neither.**

**Where the code lives:** the gate, its marker, the two early returns, the forced-steps regeneration
and the body-seeding caps are all in `runOneShotInner`, `cli/dispatch.ts`; both lead-verb predicates
are in `llm/taskShape.ts`; the minimal-plan synthesis, the forced-steps prompt branch and the slice
that renders only the first eight relevant paths are in `llm/executionPlan.ts`. The ranker — with its
unused semantic, last-changed and intent inputs, its skip filter and its content pass over the top
thirty — is `repo/rankRelevantFiles.ts`, and the scan it consumes is `repo/scanRepo.ts`; the summary
join and the inert maximum are in `core/preparePlanContext.ts`. The structure detector it calls,
its manifest read, its tiers, its note cap and the two conditions the declared-signal finding is
about are all in `repo/detectProjectStructure.ts`, whose own test file arrived with `a2fa9ee8`; the
patch flow's second summary join is in `core/runLlmPatchFlow.ts` and the feature agent's boolean read
is in `core/runFeatureAgent.ts`. On the presentation side, the proposal action and the store field it writes are in the TUI's
store core, the rendering component and the action prompt gating on it are in the TUI's components
directory, and the three cost-bearing events and their mapping are in the event-to-actions module;
the investigation loop's re-emission of two of them is in `llm/planInvestigation.ts`, and the
recording wrapper that writes the usage row is reached through `llm/factory.ts`. For the cost
closure: the optional callback, the usage extraction and the pricing call are in
`generateExecutionPlan`, `llm/executionPlan.ts`; the exported rounding helper and the rolling-window
aggregate the badge reads are both in `usage/usageTracker.ts`; the running total, the callback that
folds into it and the wrapper that seeds it off the investigation's repaint are all in
`runOneShotInner`, `cli/dispatch.ts`; and the two dollar figures, with the token suffix that hides at
zero beside the cost that does not, are composed in the status-bar component. See item 77 for the
cycle this gate sits in, item 78 for what the plan says once this context has produced it, item 76
for the shared-name class this entry's second dollar figure is checked against and is not, and item
73 for why sink counts are upper bounds.

## 80. The scope-revision approval surface is wired end to end and cannot fire, and the document that justified keeping it names a surface that has since been deleted

**What it is:** a complete approval surface — proposer, pending queue, resolver, TUI modal, and a
per-run cleanup call — exists and is imported and rendered, while the one function that would put
anything into it has no caller anywhere outside tests. Found by grep while checking a claim about
one of its parts, not by looking for dead code.

**The chain, each link established by its own grep.** `requestRevisionApproval`
(`llm/revisionApprovals.ts`) is the only producer of the `scope_revision_proposed` event; searching
the non-test tree for it returns its own declaration and nothing else. That event is the only thing
that dispatches `PLAN_PROPOSED`, which is the only writer of the store's scope-revision proposal
field, and the TUI renders `PlanModal` behind a non-null test on exactly that field. So the modal is
mounted in the component tree and gated on a condition nothing can satisfy. **The other half of the
surface is wired to real callers, which is what makes this worth recording rather than obvious:**
the resolver is called from the CLI approvals module and from the modal itself, and
`runOneShotInner` calls the queue's per-run reject helper in its cleanup — a cleanup that drains a
queue nothing can fill, on every run.

**The tool that looks like the trigger is not the trigger.** `suggest_scope_change` exists, is
described in the tool definitions, and is handled in the agent loop — but its handler emits a
`suggest_scope_change` structured event and pushes an acknowledgement, and it never reaches
`requestRevisionApproval`. Two similarly-shaped names for two unconnected paths, which is item 76's
class one instance further on; a reader tracing from the tool would conclude the surface is live.

**The design document's stated reason for keeping it is stale in a way its own text cannot show.**
`DESIGN-plan-mode-redesign.md` records the decision as keep-for-web, unwire-from-TUI: the modal and
the approvals module stay for the HTTP patch path, which the document says speaks this event, and
are removed only as the plan-mode gate. **The CLI-dead half of that is true at the tree this was
established against and remains true.** What has changed underneath it is the other half: the HTTP
server module that path named is gone, recorded in this repository's own contributor guidance as
removed. So the justification survives as written while the surface it points at does not, and
nothing in the document itself would reveal that.

**How stale, established from the document's own history rather than from reading it.**
`DESIGN-plan-mode-redesign.md` has exactly one commit in its history and has never been revised. It
was added on 2026-06-06; the HTTP server module it names was live at that commit, carrying both of
the routes it cites; and `2cb7afaa` deleted that module the next day. So the retention reasoning was
accurate for about a day and has stood unchanged for the two months since — drift, not an authoring
error, and deleting the clauses would destroy an accurate record of a decision rather than correct a
false claim. **The document is not unmarked, which is what makes this hard to see rather than easy.**
It opens by calling itself a proposal for review with no implementation yet, and its third part's own
status line records the first phase as shipped. What it carries nowhere is a date, or the commit it
was written against, and that is the one thing that would let a reader discount a clause about a
module deleted the day after it was written.

**Whether to add that is an open question rather than a fix, and it sits in this entry's bucket for
this entry's reason.** Dating a proposal after the fact is a claim about when its author wrote it;
marking the individual clauses superseded is the restructuring this document's own convention avoids;
leaving it alone is defensible on the ground that a document labelled a proposal was never a
specification. Nobody has chosen, which is a decision missing rather than a specification missing.
**If a later pass does revise it, the edit's shape is already known and it is not uniform:** the
Part 1 audit table's HTTP-endpoint row and the Part 2 risks bullet on two-surface divergence would
each take a whole-unit removal, since the endpoint and the second surface are what those units are
about, while the Part 3 risks bullet naming the same symbols as doubly-dead for CLI keeps a true
remainder — the CLI half is exactly what this entry establishes, and only its web-parity caveat is
stale.

**Bucket — Neither, and the reason is which decision is missing rather than how much work it is.**
Deleting the chain is mechanically small and the entry could specify it in a sentence, which is what
the Actionable-now bar asks for. What is not settled is whether scope revision is a feature this
project still wants: the tool that would front it is live in the toolset, the agent loop already
handles it, and only the approval half is orphaned — so deletion and rewiring are both coherent, and
nobody has chosen. That is a decision missing, not a specification missing, which is item 60's own
reason for sitting here rather than item 76's. **Checked in the other direction, as item 77
requires:** promoting this on the strength of "the deletion is small" would retroactively mis-bucket
item 60, which is blocked on exactly the same kind of prior decision and stayed Neither for it.
**Neither.**

**Where the code lives:** the producer, the queue and the resolver are all in
`llm/revisionApprovals.ts`; the modal and its own resolver call are
`cli/tui/components/PlanModal.tsx`; the store field and the `PLAN_PROPOSED` case are in the TUI's
store core, the event's mapping is the `scope_revision_proposed` case in `eventToActions.ts`, and
the per-run cleanup call is in `runOneShotInner`, `cli/dispatch.ts`. The tool that is not the
trigger is defined in `tools/toolDefinitions.ts` and handled in `llm/agentLoop.ts`. See item 76 for
the shared-name class the tool/event pair belongs to, and item 60 for the bucket precedent.

## Status snapshot — a partition, not a priority ordering

A snapshot, current as of this commit — it goes stale the moment any item closes or is
reclassified; the numbered entries above are the source of truth, and this section only saves a
reader the trouble of reading all 80 to find out which ones still need something. No index of
this kind existed before this pass — the intro's own "not a changelog, not a roadmap, not a
priority ordering" cautions against ranking by importance, which this section doesn't do: it
groups by mechanical status only, items listed by number within each group, not by what to do
first.

**Closed** (39): 6, 7, 8, 10, 12, 13, 14, 16, 20, 21, 22, 24, 25, 26, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 40, 41, 42, 44, 47, 48, 49, 55, 56, 64, 66, 69, 70, 71, 72

**Actionable now** — a fix is specified in the entry itself; nothing new needs to be learned
first (0):

**Blocked on data** — closing requires an observation that doesn't exist yet (7): 1, 4, 18, 23, 57, 63, 75

**Neither — a structural fact recorded, with no fix proposed** (34): 2, 3, 5, 9, 11, 15, 17, 19,
27, 36, 38, 43, 45, 46, 50, 51, 52, 53, 54, 58, 59, 60, 61, 62, 65, 67, 68, 73, 74, 76, 77, 78, 79, 80

Items 1, 2, 17, 18, 36, 38, 57, 61, 62, 65, 78, and 79 are partially closed or corrected; the
classification above covers only the portion still open, not the whole entry.

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

**A later instance, from the plan-approval establish pass (item 77) — and its counter-instance,
which is the more useful half.** One test file's header cites five constructs in the dispatch module
by line: the two early returns, the forced-steps safety net's range, and each of the two replan arms.
Every one of them misses at the tree this was found in. Two miss into a neighbouring construct
entirely — the safety-net range starts inside the guard above it, and the citation for the
approve-and-run arm lands on the last statement of the *other* arm, in the same switch the comment
is explaining. Three inline comments in the same file cite the initial plan-generation call by a
line holding an opening brace in an unrelated loop, and a second test file cites two ranges for a
read-only-mode predicate that lives hundreds of lines from either. A source comment in the flow
module does the same to its own classifier call. **The counter-instance is a third file citing the
same neighbourhood three times, two of which still resolve exactly and one of which is off by two
into its own comment block.** So the drift is not uniform even within one subject: some citations
survive, some die, and nothing distinguishes them from the outside, which is why "check whether the
number still resolves" is not a maintenance strategy — it is a per-citation cost with no batch form.

**What this instance does *not* show, checked rather than assumed.** The pass that found these had
just edited two source files and a script, and the natural reading is that its own edits moved the
lines. They did not: the file holding every cited construct has not been touched since the commit
that introduced the shape, and the two files the session did edit took their insertions below every
line cited into them. The drift predates the pass that found it by a long way. Worth stating because
the sharp version of this lesson at the top of the section — a citation wrong on arrival — is the
memorable one, and it makes the ordinary case easy to misattribute to whatever change happened to be
in progress when someone finally looked.

**A qualification on this section's own promise, from the same pass.** The claim above is that a
shape reference "fails loudly if the shape itself is ever renamed away." That holds when *code*
names the shape — a deleted symbol stops compiling. It does not hold in comments, which is the only
place this document asks anyone to put shape references. The plan-approval gate was once conditional
on an environment variable; a design note at the repo root records the decision to remove the
conditional and make the new flow unconditional, and the production read is gone. Comments in two
modules still describe the gate as firing when that variable is set, and a group of test files still
deletes it in cleanup. Nothing failed loudly, nothing broke, and a reader who greps the name finds
enough hits to conclude the gate is still opt-in. **Recorded as a qualification and not a reversal:**
a comment naming a removed shape is still better than a line number, because the name is searchable
and its absence is provable in a single grep — which is exactly how this one was found. A stale line
number cannot be falsified that cheaply, because it resolves to *something* every time. The finding
is left here rather than given a numbered entry: the variable having no reader is uninteresting on
its own, since removing it was the design's stated intent and that intent was carried out, and what
survives is three comments describing a gate that no longer exists. Items 43, 52 and 53 were read as
candidates and none fits — the first is a live function whose return value has no consumer, the
second is computed-and-unused values, the third is about the absence of detection tooling rather
than any instance of what it would detect.

**The densest instance so far, and it is in the file injected into every prompt.** A sweep of the
contributor-guidance file in `e8c5a96b` enumerated every one of its file-and-line citations: of the
fourteen it carried, twelve fell outside the sentences that commit was already editing, and every
one of those twelve misses at the tree it was checked against. Two are off by more than a hundred
and fifty lines, one names a function that has moved several hundred lines down its file, one lands
on an unrelated comment, and one points at a construct whose content the same file marks protected
until a named date — a wrong pointer into a protected zone, which is worse than a wrong pointer into
ordinary code, because the protection is what a later pass is supposed to check before trimming and
the pointer is how it would find it. **The smallest drift was counted, not waived.** One citation
carries a tilde prefix already conceding approximacy and misses by roughly eighty lines; the test
applied to it was the same one applied to the other eleven — does the citation land close enough
that the named content is visible from it — and at that distance it does not. A prefix that says
"don't expect exact" is not a prefix that says "exempt from the test."

**Two failure classes in one file, kept apart because the remedies differ.** That same sweep found
thirteen false symbol-or-value claims in the same document, which is a different defect from a
stale pointer: a wrong value misdescribes behaviour and is caught by grepping the symbol, while a
wrong pointer describes nothing and resolves to *something* every time, which is this section's
original point. Collapsing them into one figure would hide that the first class is mechanically
detectable by the very convention this section prescribes and the second is not detectable at all
without following each pointer by hand. **What the fix pass applied, and where it came from:** the
seeding claim in that file was rewritten in terms of its three named constants and the loop's own
control keyword rather than the file count those constants imply, on the reasoning this section
already states — a derived number has no symbol to grep, so it goes stale silently when either
constant moves, where a symbol name fails loudly. That is this section's criterion reused, not a
new one; recorded because it is the first time it has been applied to a *computed* claim rather
than to a citation.

**The second class splits the same two ways the first one already does, and the sweep could not see
the split from where it stood.** Every claim it corrected was false at the tree it was checked
against, which is what the figure above records and what it still means. What that tree cannot report
is *when* each became false. Running the pickaxe over each symbol's own history puts eight of the
eleven distinct claims as drift and three as wrong on arrival. The drift is real code with real
removal commits: a modal component imported and rendered in the TUI's own app file from `954c7bcf`
until `955d95a2` deleted it outright two months later; a marker payload emitted in exactly the
described shape at five exit sites until `7b0fd860` replaced it; an environment-gated escape hatch,
the audit-pipeline module it called, and the modal path it restored, all three retired together by
`577f1edb`; a fixed output-token default removed by `ed09286d` because it had been truncating
thinking models mid-answer. The arrival cases never existed at all: an environment-variable name that
appears in no commit anywhere in `src/`, a sub-flag naming shorthand that appears in no commit
anywhere in the repository, and the seeding claim above — whose three constants landed together in
`66c23fe0`, have not been touched by any commit since, and were already contradicting the sentence
that describes them by the time it was written seven days later.

**The remedies differ, which is the only reason the arithmetic is worth doing.** Drift is what a
shape reference already defends against: the symbol fails loudly, its absence is provable in one
grep, and the fix is to re-derive the sentence from current code — the procedure this section already
prescribes. An arrival error fails nothing, and re-derivation never finds it, because every later
reading returns the same "false now" the first one did and none of them distinguishes a claim that
decayed from a claim that was never checked against the code it describes. It is catchable at one
moment only, when the claim is written, and that is the moment this document has no procedure for.
**Recorded as a subdivision and not a correction:** the figure above stands, the sentences the fix
pass wrote stand, and what changes is that "false" was doing two jobs.

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

**The corollary that keeps catching this document out: a correction is a claim, and it does not
inherit authority from being a correction.** Reasoning that arrives as a *fix to earlier reasoning*
reads as settled — it has already survived one round of scrutiny, and rejecting it feels like
re-litigating. It is still reasoning, and it loses to running on the same terms as anything else.
Item 10 is the clean instance: a later pass reported that a function this document described did
not exist at all, and the report was wrong on every particular — the function, its call site, the
file's location and its size — while the entry it "corrected" had been right. The fifteenth pattern
records the other direction, where a review correction proposed a comparison point, the plan
accepted it, and the implementing pass rejected it on measurement rather than argument. In both
cases what settled it was going and looking, not the seniority of the claim.

**A third instance, and the sharpest, because both the claim and its correction were wrong and the
correction was the worse of the two.** An establish pass settled a question about a TUI modal by
quoting a design document, which is the plainest form of this failure — that document had already
been shown, in the same pass, to describe an escape hatch since retired from the tree, so it was
known not to be authority for current state at the moment it was cited. The correction grepped the
production tree instead and reported the modal wired unconditionally into the component tree,
contradicting the document. **That correction was also false, and it read as settled precisely
because it arrived as a correction.** The modal is rendered behind a non-null test on a store field;
the only writer of that field is one event; the only producer of that event is a function with no
caller outside tests. So the document's own claim was true where it mattered and the correction was
wrong on both halves — the render is conditional, not unconditional, and the path is dead, not live.
Item 80 records the surface.

**What the correction skipped is nameable and cheap: wiring is not reachability.** Grepping an
import and a render site establishes that a component is *connected*; it says nothing about whether
the condition guarding it can ever hold. The second question is a different grep — walk back from
the guard to whatever writes it, and from there to whatever produces *that*, until you reach either
a live caller or an empty result — and it is the one that decides whether code runs. The first grep
answers "is this attached," the second answers "can this fire," and only the second was ever the
question. Recorded beside the corollary rather than as its own pattern because the mechanism is
identical to what this section already states: the correction lost to going and looking, and being a
correction is what stopped it being looked at.

**The clause that sentence used to carry was itself false, and this document is the last place that
should have inherited it.** The escape hatch was implemented. It was an environment check in the
dispatch module guarding a call to the legacy audit pipeline with `forceAudit` set, restoring what
its own comment calls the old forced-audit and modal accept-or-reject path, with three tests
asserting exactly that; `66c23fe0` added it and `577f1edb` removed it fifteen days later, along with
the rest of the legacy audit chain. **The edit it was given as a reason for still stands, which is
the half worth keeping separate.** Deleting that sentence from the contributor-guidance file was
right, because that file describes current state and the hatch is gone from it — an artefact
surviving a false account of itself, which the tenth pattern already states from the assertion side
and item 36 from the entry side. What does not survive is the inference underneath: absence at HEAD
reported the falsity correctly and said nothing about its cause, and a cause was supplied anyway.

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

**The same rule from the other direction, and the cheaper half of it: a new assertion proves nothing
until it has been seen to fail.** Everything above is about whether a mutation *can* kill a test.
The mirror question is whether a new test *does* fail when the fix it was written for is absent, and
it is answered the same way — by running, against unmodified source, before the fix lands.
`29230a1b` produced the instance. Two assertions were added for one fix; run against the untouched
tree first, one failed as intended and the other passed, because the probe file's mock returns the
same response to every completion call regardless of what the prompt asked for, so the outcome it
asserted was already the outcome. It was a real gap being filled — nothing in the tree had driven
that path before — but not the gap it was written to fill, and it was renamed for what it actually
pins. **Nothing but running it could have told the two apart**: it is green either way, it sits in
the right file, and its name asserted the coupling it does not have. A pin that passes before the
change is a characterization test wearing a regression test's name, and the whole cost of finding
that out is one run against the tree you already have.

**The membership rule from the unpredicted-killer side: a fixture written after a fix adopts the
fixed syntax everywhere, including where it is not the subject.** `a3cbe763` made the snapshot
check's bucket pattern accept an empty bucket and added fixture blocks for it. Reverting the pattern
as a mutation was predicted to kill the two blocks whose subject *is* the empty bucket; it killed a
third, whose subject is a required bucket missing from the text entirely. The cause is in the
fixture, not in the code: that block declares its other buckets with the same bare zero-count syntax
the fix had just made legal, because once a syntax works it is the one anyone writes. Everything
above is about a predicted killer surviving; this is the mirror, an unpredicted killer appearing, and
it degrades the same property — the kill set stops being a map of what each block pins, because a
block can die for a fixture-construction reason its name says nothing about. Nothing here is wrong
enough to change: giving those buckets content would make the fixture less like the document it
stands in for. The prediction was wrong for a nameable reason, and the divergence was reported rather
than reconciled to the prediction, which is the only part that was ever in the pass's control.

**A predicted killer surviving because the assertion counts calls rather than reading values.**
`a4824f39` predicted a gate mutation would kill every test in a block that queues two plan responses
and expects the replan to consume the second. It killed all but one. The survivor asserts only that
the approval function ran once and the flow function ran once — and both remain true when the replan
consumes the wrong queued plan, because neither refusal exit nor the step-forcing safety net re-runs
on a replan, a non-re-run item 77's second strand already records from the other side. The mutation
did reach that test; it changed which plan flowed through it and changed nothing the test looks at.
**The addition to the rule:** before predicting a kill, read what the assertion compares, not what
the block is named for — a call-count assertion is insensitive to every substitution that preserves
arity, which is most of them. The same pass predicted a second green in a neighbouring block, where
a mutation skips the whole region containing the call under test so a `not.toHaveBeenCalled` stays
true vacuously; that one was predicted and held. Two greens, one pass, opposite epistemics: the
predicted-vacuous one is the check working, and only the unpredicted one is evidence of a blind spot.
Counting them together as two instances of anything would overstate what happened.

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

**The same property has a second limiting factor, found in `edadd60c`, and it is mechanical rather
than design: a test block can report at most one failure, because the runner stops it at the first
assertion that throws.** Two checks in one block therefore cannot distinguish two failure modes — on
any input that fails the first, the second never runs, so its verdict is unobtainable rather than
negative. That commit's three mutations against a newly-emitted section — removing it entirely,
removing only its header, and removing only its content — produce three genuinely different outputs,
and all three initially shared one predicted kill set for exactly this reason: the block asserting
header-and-content could only ever report that the header check failed. Splitting it into two blocks
turned "something broke" into "which thing broke," and the split was justified before running, not
after reading a result. **The rule: when two mutations are expected to differ only in which half of a
block's subject they destroy, the block is the wrong unit and has to be split, or the difference is
unobservable no matter how carefully the kill sets are predicted.**

**Its mirror, from the same pass, is about what an assertion looks at rather than where it sits.**
One prediction in that commit diverged: a mutation removing only the section's header was expected to
kill an all-fields block as well, and did not. That block asserts that every field's *content*
reaches the output and never separately checks any label, so a header-only removal is invisible to
it — correctly, since its subject is completeness of content. The lesson pairs with the one above:
splitting a block raises the granularity at which failures can be *reported*, and choosing what each
assertion inspects sets the granularity at which they can be *detected*. A kill-set prediction is a
claim about both, and this one was wrong about the second while being right about the first.

**The second instance arrived in `a2fa9ee8` and runs the opposite way, which is what turns the pair
into a rule.** There, an assertion comparing a whole expected array was predicted to be
order-sensitive, so a mutation raising a count cap was expected to kill only the block asserting that
cap. It killed the ordering block too: an exact-array comparison also compares length, so any change
to how many elements survive fails it. Set beside the first, the error is symmetric — one prediction
credited an assertion with inspecting *more* than it does, the other with inspecting *less* — and in
both the assertion was right and only the prediction about it was wrong. Neither is a coverage gap,
and treating either as one would have meant weakening a correct test to match a wrong forecast.

**So predicting a kill set has a step before it that neither the granularity rule nor the
shared-extraction rule supplies: enumerate what each assertion actually compares, then ask what could
move that.** It is a different question from what the block is *named* for, and both divergences came
from answering the name instead of the comparison — "the all-fields block checks all the fields" and
"the ordering block checks the ordering" are both true and both insufficient. The cheap version is to
read the assertion rather than its title, and it costs one line of reading per assertion in the
predicted set.

**A third instance, from the prediction side, and it reaches a grain the kill set does not have.** A
gate-inversion mutation on the plan-mode routing named its kill set exactly — every test in the file,
by name, with the mechanism each would die by — and named, inside the one block written for the
routing question, which of that block's two assertions would report. Membership held; the assertion
did not. Under the mutation the block's first assertion failed as well, on a generation call that
never happened, so the runner stopped there and the second one — the assertion the prediction was
actually about — never ran. The first-failure rule above is the whole explanation, and it governs a
single block's internal ordering as much as the two-mutation case that found it. **The refinement: a
kill-set prediction is answerable at block grain, and a claim about which assertion reports is a
different claim at a grain the block cannot express.** Nothing here weakens the prediction, which was
right about what it was for; what it names is the one thing a kill set is not evidence about.

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

## A thirteenth pattern: a string's presence or absence is evidence about the text, not about the behavior, and a matching number is not a confirmation

Checking whether a system does something by grepping a file for a keyword only tells you about
that file. It says nothing about a behavior implemented one layer away, in a module whose name
doesn't happen to match the concept being searched for. A claim about what a system does needs the
file that actually does it — found by tracing the call, not by guessing which filename sounds
right and grepping that one.

**The same error runs in the other direction, and reads as even more convincing.** Finding a
function's name written down is not evidence that anything calls it. Prose names functions freely —
a doc comment describing a path, an entry in this document, a header explaining an argument's
journey — and prose goes stale silently while code around it moves. A name in a comment is a claim
to verify, not a citation.

**The check that answers both, and the one worth running instead of either grep:** enumerate the
real callers — by symbol, by module name, and for dynamic imports and re-exports, since a search
for `from "…/x.js"` misses `await import(...)` and a re-export does not bind a name locally. If the
sweep returns only a definition and some prose, there is no call path, whatever the prose says. If
it returns callers in a file you never grepped, the behavior lives there. The two failures are one
habit — a string search standing in for a call-graph check — and one method retires both.

**"Is this branch tested" is the same question, not an adjacent one, and it failed here the same
way.** A test is a caller. So the sweep above answers coverage without modification: enumerate the
callers of the symbol and the tests are among them. The instance is item 12's anomaly branch, which
this document asserted was covered by nothing. It is covered — by a case that constructs the exact
absent-field entry and asserts both the return value and the marker — and the assertion of absence
came from checking the one test file sitting beside the module that *defines* the symbol, while the
test sits beside the module that *re-exports* it. Re-export is the fourth surface the method above
already names; the sweep was not run, a single co-located file was read instead, and its silence was
taken for the system's. Worth stating explicitly because the coverage question feels like a
different kind of question from the call-path one and invites a different, weaker check — opening
the obvious test file. It is the same question with the same four surfaces, and skipping the sweep
costs the same thing either way: a claim about the system derived from one surface of it.

The sharper half is what makes this failure mode survive review instead of getting caught
immediately: when a number asserted from a known default happens to equal the number actually
found in the code, that agreement reads as confirmation. It should read as a reason to check
harder. Two independent facts landing on the same digit is far more often one fact being read
twice under two different names than it is two facts that were each verified on their own.

This session produced a concrete instance of both halves at once. A claim that neither of two SDK
clients set an explicit timeout was checked by grepping a file that constructs adapter classes, not
SDK clients — the real constructions live one file away. And the claim's own asserted default, the
Anthropic SDK's documented ten minutes, was numerically identical to the value the codebase had
configured. The grep found nothing because it was reading the wrong file; the number matched because
one real ten-minute value was being compared against a restatement of itself, not against something
independently checked.

**Why the two values were the same is stronger than this essay first said, and the first account is
thrown out rather than softened.** It read "configured for an unrelated reason," which contradicts
the sentence immediately before it: a restatement of itself is not an unrelated value. The
configured floor's own doc comment says it is "the SDK's own DEFAULT_TIMEOUT, so small requests
behave exactly as before" — chosen to be the default, deliberately. So the agreement was not
coincidence and not near-coincidence; it was one number written twice under two names, and it will
keep agreeing indefinitely. That makes the general rule sharper, not weaker. Two facts landing on
the same digit are worth checking not because coincidences are rare, but because a codebase
deliberately adopting a vendor's value is common — and once it has, the match can never be evidence
of anything again.

**The mirror instance arrived one pass later, from the same entry.** Correcting the above, a pass
recorded that a second construction site was reachable "via a hosted-inference-mode path" — on the
strength of a doc comment naming that function. The function has no caller; the comment was stale.
The original error read an absence of a string as an absence of behavior; its own correction read
the presence of a name as the presence of a call. Two passes, opposite signs, one habit. That
symmetry is why the check above is stated as a method rather than as a caution: nothing about
"grep more carefully" would have caught either one.

**The matching-number half has a mirror too, found later and failing in the opposite direction.**
Above, two names for one value read as two independently verified facts. The converse is two genuine
bounds that share a magnitude reading as one. A file list in the plan pipeline passes two limits of
eight: the context builder slices the ranker's result to its own maximum, and the prompt renderer
slices whatever it is handed. The first is a longer bound over a shorter array and can never bind;
the second bound a real list at nine and dropped its last entry. Item 79's caps paragraph states both,
in sequence, correctly, and marks which is which — and a brief in this arc still read the two eights
as one and concluded the wrong one binds, a claim about the code that the entry it drew from already
contradicted. **What settles it is the method at the top of this section**, not more careful reading:
grep both, in the two files that hold them, and read what each one slices. Recorded because the digit
is doing identical work in both directions — a number that matches is not evidence the things
carrying it are one thing, and a number that repeats is not evidence they are two.

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

## A fifteenth pattern: a did-anything-change comparison belongs against the bytes actually written, never against an intermediate

Code that asks "did this call change anything" almost always has three values in scope, not two:
what was read before the call, some normalized or partially-transformed intermediate the logic works
in, and the final value handed to the writer. Comparing the first against the *last* is the only one
of those pairings that answers the question asked, because it is definitionally the question asked —
the bytes that were there against the bytes that replaced them. Comparing against an intermediate
answers a narrower question that merely resembles it, and the resemblance holds right up until a
transformation sits between the intermediate and the write.

**The asymmetry is what makes the rule non-arbitrary, and it is the whole argument.** The two ways
of being wrong here are not equally bad. Over-reporting a change that did not happen is a nuisance:
a downstream consumer does slightly more work, names a file that did not need naming, and nothing is
lost. Under-reporting a change that *did* happen is silent data loss — the modified-files set drops
a file that really was rewritten, and everything built on that set is wrong with no signal. An
intermediate comparison fails in the under-reporting direction specifically, because the
transformations that sit after it are exactly the ones that turn "nothing changed textually" into
"the bytes on disk are different." So the rule is not a stylistic preference between two defensible
positions; one position can only lose information and the other cannot.

This codebase produced both halves of the demonstration in a single commit (`21da1225`), narrowing a
staged-files field across three write tools. In the batch-edit tool, comparing the post-replace text
against its own pre-replace *normalized* form said "no change" for a file whose replacement text was
identical — while the write that followed still re-encoded every line ending to the file's dominant
style, persisting genuinely different bytes for any mixed-ending file. In the single-file write tool
the same rule was broken from the other side: the incoming argument is not what gets written either,
because a line-ending-preserving re-encode sits between the argument and the writer, so comparing
the raw argument could both over-report (submitted text that re-encodes to exactly what was already
there) and under-report (a mixed-ending file resubmitted unchanged, which homogenizes away from the
original on write). One rule, two tools, two different intermediates, the same correction.

**The provenance is the second thing worth keeping.** The intermediate comparison was not an
oversight that slipped through — it arrived as a *review correction*, was reasoned about explicitly,
and was written into an approved plan as the deliberately-chosen point, on the argument that
comparing after the transformation risked depending on its round-trip fidelity. That argument was
backwards: the transformation is not a round trip to be trusted or distrusted, it is part of what
gets written, so including it is what makes the comparison exact. The implementing pass caught it by
reading what the writer actually receives, and nothing about the correction's status as a correction
made it more likely to be right. See the fifth pattern's own corollary — a correction is a claim,
not authority.

## A sixteenth pattern: a claimed payoff has to be traced forward to the surface the claim names, because a downstream override can have fixed it already

Tracing a value to its first consumer is the natural stopping point — that consumer is what the
change was reasoned about, it is where the behaviour visibly differs, and once it is found the trace
feels finished. But an entry claiming a payoff is not making a claim about the first consumer. It is
making a claim about a surface: what the user sees, what gets recorded, what a later run reports. If
anything between the first consumer and that surface rewrites the value unconditionally for exactly
the population the fix targets, the claimed payoff is zero and the trace never went far enough to
notice.

This document produced the same failure twice in one arc, both against the same override. Item 70
claimed, while open, that item 12's coming predicate fix would route every no-op-only run into its
branch's verdict. Item 12 claimed that the same fix made a no-op run stop being upgraded and its
validated flag go false, and called that the intended direction. Both traced correctly as far as they
went — the flag really does reach only `applyNoInfraVerificationOverride`, and that override really
does stop firing. Neither noticed that `deriveResultFields` hardcodes both the reason and the flag
for the no-change outcome, nor that a no-op-only run reaches that outcome by construction, because
its staged bytes equal the disk bytes and `finalizeStaging`'s all-unchanged comparison fires first.
The user-visible field was already correct before either fix, and stayed correct after.

**What makes this worth a pattern rather than an incident is that the two surfaces are separated by
that override and therefore disagree by design.** The assessment telemetry is emitted before
`verifyAndFinalize` runs; the result field is derived after it. The same run hands two different
verdicts to two different readers, and no amount of care about *which value* is computed will settle
which of them a claim is about. So an entry that says "this changes what is reported" is
underspecified in this codebase, not merely imprecise — it has to name the surface, and the trace has
to reach that surface rather than stopping where the change is easiest to see.

The check is cheap and it is the same one either way: after establishing what a change does to a
value, keep following the value until it either reaches the named surface or is overwritten. An
overwrite is the interesting result, not the boring one — it means the payoff belongs to whatever
still reads the pre-overwrite value, which is a real payoff and worth claiming, just not the one that
was about to be written down.

**The third instance arrived one commit after this essay was written, and it fails in breadth rather
than depth — worth recording because the check above, read literally, would have missed it.** Item
69 argued that un-masking its tag demand was harmless because the branch item 70 had just fixed was
what the demand masked. The trace was correct and stopped at the first consumer; a second consumer
of the same absent-tag condition sits beside it, and its fallthrough now describes an
iteration-exhausted run as having encountered errors (item 76). So "follow the value forward" is not
quite the instruction — **enumerate what the condition reaches, then follow each**, because a
condition can have siblings where a value has successors. The verdict survived anyway, and that is
the second half worth keeping: un-masking really is harmless, but because nothing renders the second
consumer's output, not because the reasoning covered it. **A conclusion that happens to be right is
not evidence its argument was** — the argument is what a later pass inherits and reuses, and this one
would have carried a false generalization about there being a single consumer into whatever came
next.

**A fourth instance, and the first where the mechanism named did not exist at all — which is what
makes it worth adding rather than folding into the three above.** The first two failed by stopping
early; the third by tracing one member of a set. This one traced a mechanism that was never there.
The hypothesis behind the plan-content pass (item 78) held that plan generation runs an investigation
whose findings are *discarded* before the plan is written, so most of the material for a richer plan
was already paid for and thrown away — making the feature mostly a plumbing problem. **The conclusion
was right and the mechanism was invented.** The findings are not discarded before planning: the plan
is parsed out of the investigation loop's own final message, so the model holds every file it read in
context at the moment it writes. Nothing is paid for twice and there is nothing to rescue.

**What makes this sharper than the earlier three is that the mechanism was the actionable part.** A
trace that stops early still points at real code; a hypothesis about a mechanism that does not exist
points at work to do. Acting on this one as stated would have built plumbing to carry findings
forward across a boundary they never crossed — real effort, cleanly implemented, solving nothing —
and the pass would have felt vindicated throughout, because the conclusion it was serving was
correct. The true reason is a different fix in a different file: the material is already in context,
so what limits the plan is the prompt and the schema.

**The rule this adds to the closing line above.** "A conclusion that happens to be right is not
evidence its argument was" is stated there as a caution about what a later pass inherits. This
instance makes it operational: when a hypothesis names both an outcome and a mechanism, **the
mechanism is the part that decides what gets built, so it is the part that has to be checked first** —
and confirming the outcome is not a check on it. The cheap version is the same one the essay already
prescribes, run in the other direction: before believing something is lost, find the line that loses
it.

## A seventeenth pattern: a freshly written entry is the least-checked text in this document, not the most current

The instinct is that a recent entry is the more trustworthy one — written against the current tree,
by someone who had just read the code. The opposite holds here, for a mechanical reason. An old entry
has been read by every pass that cited it, and each of those readings was an opportunity for a false
sentence to be caught; some were. A one-commit-old entry has had none of them. Recency is a fact
about when text was written, not about how much scrutiny it has survived, and this document keeps
treating the first as evidence of the second.

Item 76 is the clearest instance. It was written in the same commit that closed item 69, by the pass
that discovered it, and it entered permanent record carrying three false claims: that the note it is
about has one consumer, when three subscribe to that event and one of them copies the whole
verification block onto a wire frame that leaves the process; that a single missing arm describes the
defect, when several reasons reach the fallthrough and one of them is told a patch was applied on a
run that wrote nothing; and a bucket argument that rested on the first of those. All three were
caught by the very next pass, and caught the same way — by reading the code the entry names instead
of reading the entry.

**What makes this a pattern rather than an incident is how ordinary the mechanism is.** The pass that
finds a defect understands it least well, because understanding it is what the pass was for; the
entry gets written at the end of that pass, out of the trace that found the thing, and a trace good
enough to find something is not an enumeration of what surrounds it. The failure concentrates in
exactly the sentences that generalize from that trace — counts of consumers, of shapes, of origins —
because those are the claims a single successful trace feels like it has already established. This
document has thrown out bullets for it before, in entries that name themselves as having pushed a
claim before anyone checked it, and item 36 recorded a neighbouring version — errors entering in one
wholesale rewrite — while declining to generalize from one instance. There are enough now.

**The corrective is not "write fewer entries," it is knowing where the checking happens.** An entry
written in the same commit as its own subject cannot be checked by that commit; there is no later
pass yet, and reading it back and finding it coherent proves only that it is coherent. So the check
belongs to the next pass that touches the entry, and it has to be a re-derivation from the code
rather than a re-reading of the prose — enumerations first, since those are where this fails.

**A second locus, found one commit later, and it is not an enumeration.** The closing line of the
sixteenth pattern's fourth instance — written in the same commit as item 78, about item 78 — reads
that the material is already in context, so what limits the plan is the prompt and the schema. Item
78's own second strand, in that same commit, is correctly scoped: it says the plan is parsed out of
the *investigation loop's* final message, which is true of the path that runs a loop. The essay
restated it with the qualifier dropped, as a claim about "the plan." On the default path for an
additive task there is no loop at all; the model gets a handful of file bodies chosen by keyword, and
what limited the plan observed on 2026-08-08 was neither the prompt nor the schema but which files
those were (item 79). The entry was right and the essay generalizing from it was not — same commit,
same pass, one sentence apart.

**What this adds is where to look, beyond the enumerations.** The paragraph above names enumerations
as the concentration point because that is where item 76 failed. This instance failed at a
**restatement**: a claim that carried a scope qualifier in the entry lost it on the way into the
essay. That is worse than losing it in an entry, because an essay is inherited as a *rule* rather
than as a fact about one subsystem, and a rule with a dropped qualifier is applied to everything the
next pass touches. Summarising an entry into a general lesson is the same act as writing an
enumeration — generalizing from one trace — with none of the visible seams that make an enumeration
checkable. So the re-derivation this pattern prescribes has to cover the essays, and the cheap
version is specific: when an essay restates an entry's finding, check whether the entry scoped it to
a path, a mode or a branch, and whether the restatement kept the scope.

**The cost of this one was very nearly paid and was not, which is the last thing worth recording.**
The commit that acted on item 78 removed the prompt's brevity instructions; it was correct on its own
terms and was not aimed at any observed symptom, since it predates the run that produced one. The
commit queued behind it — adding a field for rationale — would have been the first change actually
aimed at plan quality, and on the default path it would have been aimed at a mechanism that exists
and is not the operative one. This pass reached the mechanism first, so the pattern's cost was
avoided rather than incurred. It gets a sentence rather than a pattern of its own: writing one about
a failure that did not happen would be the same generalization-from-one-trace this pattern is about.

**The corrective this pattern prescribes has one blind spot, found by a false sentence that survived
it three times.** Re-derivation from the code is the check named above, and it cannot settle what a
value *means* when nothing consumes it. Item 79 carried a claim that the gate marker's source label
named a routing outcome. Three separate readings of the code — an establish pass, the brief drawn
from it, and a fix plan that queued a rename — reproduced the claim rather than killing it, and not
through carelessness: the emitting ternary assigns a string and stops, the field has no reader
anywhere in the tree, and its own entry contained both the true reading and the false one a clause
apart. Re-derivation returns the same ambiguity every time, and a name that sounds like an outcome
resolves the ambiguity the same wrong way every time. What killed it was the commit that introduced
the field, where the literal was the deciding function's own name set against the bare word for the
override — unreadable as an outcome, and one command away throughout. **So the rule gains a case:
when the disputed claim is about what a value denotes rather than what the code does, and the value
has no consumer to disambiguate it, read the commit that introduced it before reading the code again.
A third identical re-derivation is not a third check.** This is one instance, which by this pattern's
own precedent — item 36's neighbouring version, declined until there were enough — would not carry a
pattern of its own. It is recorded here instead, as a limit on this pattern's corrective rather than
as a pattern beside it, because that is exactly what it is.

**A second instance, and it widens the condition rather than lengthening a list.** The first case's
trigger was a value with no consumer: the code is ambiguous, so reading it again returns the same
ambiguity. The second has no ambiguity in it at all. A design note at the repo root justified keeping
a modal and its approvals module for an HTTP path, and every grep of the current tree agrees that
path is gone — correctly, unanimously, and at any number of readings. What the tree cannot report is
*when* the note was written, and a document saying a surface exists is not falsified by that surface
being absent today unless the two are contemporaneous. One command settled it and it was the same
command as before: the note has exactly one commit in its whole history, the module it names was live
at that commit, and it was deleted the day after. **So the condition generalises past the
no-consumer case — read the introducing commit whenever the disputed claim is about a past state and
the tree can only report the present one** — and the mechanism underneath both is one thing. A
re-reading of the current tree is the same source of evidence as the first reading, not a second one,
while the commit that introduced the text is a different source.

**The scale is what makes this worth widening rather than noting, and the unit is occurrences because
occurrences are what the method was applied to.** Of the thirteen false spans the
contributor-guidance sweep corrected against the current tree alone, ten named something that had
been real when the sentence naming it was written. So the tree-only reading was right about falsity
every time and silent about cause ten times out of thirteen, and on the single occasion a pass
supplied a cause anyway it supplied the wrong one — the fifth pattern's third instance, corrected in
the same commit as this paragraph. That is still two instances of the introducing-commit check
itself, which by the precedent above does not earn a pattern of its own; it earns a wider statement
of the one already here.

## An eighteenth pattern: a measurement's window is part of its claim, and a reading taken while the writer is still running expires

Both instances are in item 79 and both are mine. Reading the marker sink for a run that had just
reached its approval gate, I found no decision record and wrote that the run was abandoned without
one; the rejection was emitted minutes later, and the record exists. Reading the sessions directory
for the same run, I found no session file and wrote that a plan declined at the gate persists
nowhere and its text is unrecoverable; the session was written about an hour later, when the terminal
process exited, and it carries the whole plan. Neither observation was wrong when taken. Both became
false, in one case within minutes, and in both cases the sentence written into permanent record was
not the observation but a generalization of it into a claim about what the system does.

**Why this is not the seventeenth pattern.** That one is about a freshly written entry being the
least-checked text, and its corrective is a re-derivation by the next pass. It would not have helped
here: a re-derivation performed at the same moment would have reproduced the same absence and
confirmed the wrong sentence. The defect is not insufficient checking, it is a measurement whose
validity had an expiry the measurer did not think to name. Absence of a record is the one observation
that cannot be strengthened by repeating it more carefully at the same time.

**What makes it recognisable in advance is asymmetry between the two directions.** Finding a record
present is durable — a record that exists will still exist later. Finding a record absent is
provisional whenever anything that could still write it is alive. Every conclusion in this document
resting on a zero inherits that: item 77's "the sink holds zero records" is sound only because the
window it names is closed, and it says so; the same sentence about a currently-running process would
not be. The two failures above both took a provisional absence and wrote it down as a durable one.

**The check is one question, and it is cheap: is the process that would write this record still
running?** For sinks, that is whether the run has terminated. For session files and envelopes, it is
whether the terminal process has exited, which is later than the run ending and is exactly what
caught the second instance — the write is triggered by process exit, not by the run's own completion,
so a run can be finished, decided, and fully accounted for while its session file does not yet exist.
When the answer is yes or unknown, the honest form is to state the window rather than the conclusion:
"no record as of this reading" is a fact, "the run produced no record" is a claim that needs the
window closed first.

**A qualification on the durable half, because "present is safe" is doing more work above than it can
carry.** A record that exists will still exist later — that much holds, and nothing below contradicts
it. What durability does not supply is *invertibility*: a value that several distinct states all map
onto cannot be read back to the state that produced it, however permanent it is. This document has
recorded that failure three times without connecting them. Item 72 is the cleanest — a nonsense
offset and a genuinely caught-up reader returned byte-identical results, field for field, so the
record was durable and told the reader nothing. Item 74 is the same shape one layer up, several run
shapes that applied nothing collapsing into one downstream verdict, one of them reported as
validated. Item 64 is the weakest of the three and is named as such: its collapse is real, but the
value doing the collapsing is a *hash*, which is many-to-one by construction, so it belongs here only
because the collision was semantically wrong rather than because a many-to-one mapping is itself the
defect — a reader who takes it as the type specimen will over-generalise. The fourth instance is the
plan-gate marker item 79 now records, and it is the only one not observed after the fact: its
ambiguous case was established by tracing the context builder rather than by finding a misread
record, which makes it the instance most at risk of having been fitted to a class the same pass was
assembling. **The check this adds is one question asked when an instrument is built rather than when
it is read: how many states reach this value?** If more than one does, the field is a record of
something, but not of what it appears to name — and unlike the absence problem above, waiting does
not resolve it, because the ambiguity is in the mapping rather than in the timing.
