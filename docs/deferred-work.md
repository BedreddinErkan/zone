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

## 2. The parser's silent misparse on a matched, own-line embedded pair

Heavier than item 1: this is silent wrong content written to disk, not a rejection.

**What it is:** the FIND/REPLACE block-splitting walk (the loop that consumes
`FIND_MARKER`/`REPLACE_MARKER` occurrences in `apply_patch`'s handler, `toolExecutor.ts`) uses
the same substring-anywhere marker matching as the imbalance counter above it. If a patch's
REPLACE content contains an embedded, own-line, **matched** FIND/REPLACE pair (both markers
present, e.g. a doc example demonstrating the syntax), the walk splits there — truncating the
real block's replacement short and fabricating a second, unintended block from the example
text.

**Why it can't be recorded under the existing marker:** a matched embedded pair raises
`findMarkerCount` and `replaceMarkerCount` together, so they stay equal. The rejection branch
that emits `[zone-apply-patch-marker-imbalance]` never fires. There is no payload shape that
could capture this under that tag — it isn't a rejection at all.

**What would close it:** its own pass. Line-anchoring the parser's own segmentation (not just
the counter) would change which patches get *accepted*, not just which get rejected more
legibly — a real behavior change, deliberately out of scope for the recount work that found
it.

**Where the code lives:** a comment already sits directly above the start of the
block-splitting walk in `apply_patch`'s handler, `toolExecutor.ts`, stating this exact defect.
This entry is the index pointing at that comment, not a duplicate of it.

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
unreachability as a silent-failure signal.

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
the subject of a related, independent finding in the same log — see item 12.

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

## 12. `didApplyPatch` classifies by string-matching result text, never by reading `success`

**What it is:** `didApplyPatch` (`src/llm/verification/logUtils.ts`) decides whether a run
applied anything by scanning each `apply_patch`/`write_file` tool-call-log entry's `result`
text for the substrings "error", "not found", and "fail" — it does not read the entry's
`success` field at all.

**How this was found:** unprompted, while establishing whether item 6 (above) was a real
defect. Tracing every `toolCallLog` consumer to check what would change if rehydrated
`success` were made accurate turned up this one — and it's immune to any such fix, by
construction, because it never reads that field in the first place.

**Three consequences:**
- Any future fix to item 6's `success` field, if one is ever built, would not change this
  function's behavior at all — it is a fully independent classification path over the same
  log, not a downstream consumer of `success`.
- The rehydration placeholder text (`"(restored from a previous run; content not retained)"`)
  contains none of the three trigger substrings, so every rehydrated `apply_patch`/`write_file`
  entry counts as applied here regardless of what really happened before interruption — the
  same blind spot as item 6, reached by a completely different mechanism and unreachable by
  item 6's proposed fixes.
- It is consumed by `composer.ts` and `deriveVerdict.ts` (both in `src/llm/runCompletion/`) for
  verdict derivation — so this affects the run's final reported verdict, not an internal nudge.

**What would close it:** reading `success` instead of (or in addition to) string-matching
`result` — the same category of fix as the bare-catch work already landed this session (making
a `success` field trustworthy, or making a consumer stop trusting an untrustworthy proxy for
it). Not attempted here: found during a documentation-only pass with explicit
no-source-changes scope.

**Same failure class as marker-imbalance's original problem:** classifying an outcome by
pattern-matching human-readable text instead of reading a structured field meant to carry that
outcome is the same shape of fragility that motivated the line-anchored marker recount (item
1) — a different subsystem, the same lesson: prose is not a data model.

**Where the code lives:** `didApplyPatch` in `src/llm/verification/logUtils.ts`; called from
`composer.ts` and `deriveVerdict.ts` in `src/llm/runCompletion/`.

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
instead, per the note above, if the shape itself is ever renamed away.
