# Classifier Determinism

The task classifier (`src/llm/taskClassifier.ts`) is designed to be deterministic
within a single server process lifetime. This document records the invariants and
the rationale behind them.

## Invariants

**Same input → same output (cache hit).** The classifier caches results in a
`Map<string, TaskClassification>` keyed on the djb2 hash of the normalised
(trimmed) task string. Identical task descriptions — even with varying whitespace —
always resolve to the same cache slot after the first call.

**No PRNG in the classification path.** Temperature is hardcoded to `0` on the LLM
call. No `Math.random()` or equivalent is introduced anywhere between the task
string and the returned `TaskClassification`.

**`temperature: 0` constrains sampling; it does not make the model reproducible
across calls — measured, not assumed.** The same forty task strings were classified
twice against a byte-identical prompt, harness, options and model, once at
`49aa3615` and again at `dbf37726`. Between those two runs three of the forty tasks
returned a *different tier*, twenty-four of the forty produced *different reasoning
text*, one request timed out and was retried, and one task that had returned
`"simple"` at confidence `1.0` came back on the repeat as a fallback at confidence
`0`. Temperature zero removes Zone's own contribution to sampling variance and is
what makes repeated calls comparable at all; reproducibility for a given task string
comes from the cache-hit invariant, not from the temperature.

Two boundaries on that measurement, because it is easy to read as broader than it is.
It says nothing about the cache-hit invariant: both runs passed `skipCache` from a
fresh process, so they measured the uncached path deliberately and left the cached one
untested and unrefuted. And its scope is one model (`gpt-4o-mini`), forty task strings,
and a single repeat — one draw of how far this classifier moves against itself, not an
estimate of how far it can.

**Fallback tier is always `"medium"`.** When the classifier fails for any reason
(API error, timeout, parse failure, invalid tier value, low confidence), the result
is `tier: "medium"` with `fallbackUsed: true`. There is no failure mode that
produces `"simple"` or `"complex"` from the fallback path.

**Confidence gate boundary is a constant.** `CLASSIFIER_CONFIDENCE_THRESHOLD = 0.5`
is a module-level export in `taskClassifier.ts`. It is not configurable from the
request body, environment variables, or user settings. Changing it requires a code
change with empirical justification.

## Confidence gate

If the classifier returns `confidence < CLASSIFIER_CONFIDENCE_THRESHOLD`, the result
is overridden to `tier: "medium"` regardless of what the model said. Two telemetry
events are emitted:

- `[zone-tier-low-confidence-fallback]` — emitted only when the override changes
  the tier (i.e. the classifier returned `"simple"` or `"complex"`, not `"medium"`).
  Contains `classifierTier`, `forcedTier`, `confidence`, and `threshold`.
- `[zone-task-classified]` — always emitted, with `fallbackReason: "low_confidence"`.

The intent: silent downgrades (`medium → medium`) don't create noise; visible
downgrades (`complex → medium`, `simple → medium`) produce an actionable log event.

## Cache lifecycle

The cache is process-scoped. A server restart clears it. There is no persistence
layer. `clearClassificationCache()` is exported for test isolation — it is not
called in production code.

## Why this matters

Zone's tier-bounded execution model relies on the classifier to determine token
budgets, iteration caps, and subagent quotas before dispatch. This section used to
argue from a hypothetical — that a non-deterministic classifier *would* cause the same
task to receive different budgets across retries. The repeat-run measurement recorded
under the invariants satisfies that hypothetical's premise, so the consequence is
stated directly instead: tier gates all three of those limits, and three of forty task
strings returned a different tier on a byte-identical repeat, so the same task can be
provisioned differently on two uncached classifications.

The cache bounds how far that reaches. A byte-identical task string is classified once
per process and replayed from the map thereafter, so the exposure is the first
classification of each distinct task string in each process, not every dispatch. How
often that occurs is not measured here and is not claimed.

The confidence gate exists to prevent a low-certainty `"simple"` classification from
under-provisioning a task that actually requires medium-tier resources. Correcting that
premise says nothing about whether the gate achieves it — this document records no
measurement of the gate's effect.
