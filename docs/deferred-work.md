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

## 7. Sticky `failureDetected` suppresses durable-resume checkpoints across tools

**What it is:** within a single agent-loop iteration, the per-iteration failure flag on the
tool-event context is set once a write-tool fails and never reset until the next iteration.
The durable-resume checkpoint write is gated on that same flag being clear for
`apply_patch`/`write_file`/`multi_edit`. So one failing write-tool call silences checkpointing
for every *later, successful* write-tool call in the same iteration.

**Not created by any recent work.** Traced to the checkpoint-after-every-successful-write-tool
feature's original commit, well before the sessions that found it.

**What would close it:** scoping the failure flag (or the checkpoint gate) to the specific
tool call that failed, rather than the whole iteration. Not attempted — recent work in this
area was scoped to `multi_edit`'s own success signal, not this pre-existing cross-tool
coupling.

**Where the code lives:** the checkpoint call sits in the per-tool-call loop in
`runAgentLoop` (`agentLoop.ts`), gated on the tool-event context's `failureDetected` field
alongside a tool-name check for the three write tools.

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

## 14. `filesModified` is not a write oracle

**What it is:** `handleToolResult` adds a tool call's `filePath` to `ctx.filesModified` for
`apply_patch`/`write_file` unconditionally — no `success` check — so a failed attempt lands in
the set exactly like a successful one. The `multi_edit` path is different and accurate: it adds
via the entry's `filesStaged`, which stays empty unless a replacement actually happened.

**Why this matters:** `filesModified` looks, at a glance, like the obvious signal for "did this
run write anything" — it's already a `Set` of paths, threaded everywhere `toolCallLog` is. It is
not that signal for two of the three write tools. This was flagged during the establish pass
that led to `e21aab93` (see item 12), specifically to rule it out as an alternative to fixing
`didApplyPatch` directly — recorded here so the next person looking for a "did this write
anything" signal doesn't reach for it and rediscover the same trap.

**What would close it:** gating the `apply_patch`/`write_file` additions on `success`, the same
way the `multi_edit` path already gates on `filesStaged` — matching the asymmetry fix already
applied to chain-saturation counting (`86ba4bd1`) and to `didApplyPatch` (`e21aab93`) elsewhere
in this same file family. Not attempted here — found and recorded, not built, during a
documentation-only pass.

**Where the code lives:** the three additions are in `handleToolResult.ts`'s per-tool-call
bookkeeping — `apply_patch`/`write_file` unconditional on `filePath` presence, `multi_edit`
conditional on `result.filesStaged`.

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

## 20. `parsePatchBlocks` has no directly testable surface

**What it is:** `parsePatchBlocks` (`agentLoop.ts`) is not exported, and nothing in this
codebase imports it — confirmed by grep, zero hits. `hashPatchBlocks`, which calls it, is
exported and has callers, but the segmentation function underneath it has never been reachable
from a test file.

**Why this matters beyond the immediate gap:** the segmentation half of the FIND/REPLACE format
could be silently broken — by an unrelated edit, a bad merge, a naive refactor — with no test
noticing. This is plausibly part of why it was able to drift from the applier's walk unnoticed
in the first place (item 18): there was no test on either side that would have caught the two
falling out of sync when `normalizeSmartQuotes` was added to only one of them. Item 18's own
denominator pass makes this concrete rather than speculative: two more normalization classes
(line endings, the read_file prefix) drifted the same way, silently, with zero telemetry until
that pass — not just the one this entry already names.

**What `a7f4ff03` did about it, and what it didn't:** the characterization tests pin
`parsePatchBlocks`'s behavior indirectly, entirely through the exported `hashPatchBlocks` — a
hypothesis assertion (a hand-written `{find, replace}` guess, hashed with a test-local helper
that replicates `hashPatchBlocks`'s own concatenation formula) plus a discriminating companion
patch, per claim. A mutation to that formula (changing the separator between `find` and
`replace`) was confirmed to break the hypothesis assertions, ruling out the helper being a
silent second source of truth. This pins current behavior; it does not create a testable surface
on `parsePatchBlocks` itself, and it does not make the function exported.

**What would close it properly:** exporting `parsePatchBlocks` directly, or extracting it as
part of item 16's shared-segmentation module — either creates a surface a test can call
directly, with assertions on `{find, replace}` fields instead of hash equality.

**Where the code lives:** `parsePatchBlocks` is in `agentLoop.ts`, not exported. The
characterization tests are in `agentLoop.patchBlocksCharacterization.test.ts`.

## 21. Two existing EOL telemetry sites are each incomplete, in opposite directions

**What it is:** `toolExecutor.ts` has two pre-existing `debugLog` sites describing FIND/REPLACE
block line-endings, and neither observes the match-time normalization completely.
`[zone-apply-patch-eol-warn]`'s CR-only check tests `/\r(?!\n)/` against the raw block content —
it catches bare-CR-only content but *misses ordinary CRLF entirely*, since the negative
lookahead excludes any `\r` immediately followed by `\n`. `[zone-apply-patch-eol]` carries
`findEolBefore`/`replaceEolBefore` via `detectLineEnding`, whose own regexes never test for a
bare `\r` with no `\n` anywhere in the string — a bare-CR-only block reads as `"none"`, silently
missing exactly the case the *other* site exists to catch.

**Two of the three EOL sites share a tag with different payloads.** The CR-only check and a
third, unrelated site (the target file's own mixed-line-ending re-encoding, at output time — not
a FIND/REPLACE content signal at all) both emit under `[zone-apply-patch-eol-warn]`, with
different payload shapes.

**Neither reaches the sink regardless of the above — both are `debugLog`.** Confirmed while
building the item-18 denominator pass: this is exactly why that pass built a fresh, direct
before/after comparison instead of promoting either site — promoting either one gives an
incomplete or wrong-question denominator, not a fix.

**What `563d5b63` did about it, and what it didn't:** built
`[zone-apply-patch-normalization-parity]` alongside these two, using a direct string comparison
rather than either proxy. It did not fix, reconcile, or retire the two existing sites — they are
unchanged, still incomplete, still `debugLog`-only.

**What would close it:** reconcile the two into one complete, correct signal, or retire them now
that a complete signal exists elsewhere — not attempted here, found and recorded during a
detection-only pass that deliberately left matching and existing telemetry untouched.

**Where the code lives:** both sites are in `apply_patch`'s handler, `toolExecutor.ts` — the
CR-only check immediately before the match-time normalization, the `detectLineEnding`-based one
immediately after it. The unrelated third site sharing the CR-only check's tag is later in the
same handler, at output re-encoding.

## 22. `multi_edit` carries a fourth, independent copy of the EOL-normalization transformation

**What it is:** `multi_edit`'s own handler has the identical
`.replace(/\r\n/g,"\n").replace(/\r/g,"\n")` two-line chain, written independently of
`apply_patch`'s walk and of `normalizeEol` (the helper item 18's denominator pass extracted so
the walk and its own telemetry share one implementation). `multi_edit` takes `find`/`replace` as
separate JSON arguments (see item 17) and never feeds `hashPatchBlocks`/`parsePatchBlocks`, so
this copy is not part of item 18's divergence and is not a live defect today.

**Why it's recorded anyway: this is a drift candidate, not a hypothetical one.** This exact
transformation has already drifted once in this codebase — `normalizeSmartQuotes` was added to
`apply_patch`'s walk and never mirrored into `parsePatchBlocks`, which is item 18 in full. A
fourth independent copy of a two-line transformation is a small blast radius per copy, but the
mechanism that produced item 18 — one copy edited, a sibling copy not — applies exactly as well
to a third or fourth copy as it did to the second.

**What would close it:** nothing urgent — recorded so a future normalization change to one copy
prompts a check of the others, not a fix in itself. If `multi_edit` and `apply_patch` ever need
the same EOL behavior deliberately kept in sync, `normalizeEol` (`toolExecutor.ts`) is already
the shared implementation to point `multi_edit` at instead of writing a fifth copy.

**Where the code lives:** `multi_edit`'s own EOL-normalization is in its handler in
`toolExecutor.ts`, independent of `apply_patch`'s handler in the same file.

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

## 24. `saveSession`'s failure at exit is silent

**What it is:** the clean-exit tail wraps `saveSession` and `pruneOldSessions` in one
`try/catch` with an empty catch body — a save failure is swallowed entirely, with no marker and
no message. The comment marking this block calls it "non-critical."

**What `f7cd3c2e` changed, and what it left alone.** `f7cd3c2e` made the exit-time resume hint
conditional on `saveSession` actually succeeding (a `saved` flag, set immediately after the
write returns), closing the false-promise case: the user is no longer told to resume a session
that was never written. But the underlying failure is still silent on its own terms — the user
exits, sees nothing printed either way, and their conversation is gone with no indication why a
later `--resume` won't find it. The fix narrowed what a failed save *causes* (a false hint)
without touching whether a failed save is itself *observable*.

**The "non-critical" framing is what's worth revisiting, not the catch block's shape.** The
comment is accurate from the process's point of view — a failed save must not block exit, and a
`try/catch` around it is correct for that. But "non-critical" describes the process's exposure,
not the user's: a lost conversation, with no attempt made and no possibility of a later
`--resume`, is not obviously non-critical to whoever just lost it.

**What would close it:** a named marker on the catch path (consistent with this document's own
markers elsewhere — see items 1, 2, 5, 21), or a printed message alongside the resume hint's own
call site, using the same restore-stdout/restore-stderr-then-print placement `f7cd3c2e`
established. Either keeps the process's own resilience (exit must still happen) while making the
loss observable instead of silent. Not attempted here — found and recorded during a
documentation-only pass.

**Where the code lives:** the `try/catch` around `saveSession` and `pruneOldSessions` is in the
clean-exit tail of `runTui`, immediately before the resume-hint call site `f7cd3c2e` added, in
`index.tsx`.

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

**Where the code lives:** the catch block sits in the same `if (opts.resume)` block as
`_resolveResumeRequest`'s own call, in `runTui`, `index.tsx` — immediately preceding the
`if (envResumeId)` envelope-resume block that `_composeResumeMessage`'s own reconciliation
already accounts for.

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
