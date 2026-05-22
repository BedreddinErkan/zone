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
string and the returned `TaskClassification`. Randomness from the LLM itself is
controlled by `temperature: 0`.

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
budgets, iteration caps, and subagent quotas before dispatch. A non-deterministic
classifier would cause the same task to receive different budgets across retries,
making cost predictability impossible. The confidence gate exists to prevent
a low-certainty `"simple"` classification from under-provisioning a task that
actually requires medium-tier resources.
