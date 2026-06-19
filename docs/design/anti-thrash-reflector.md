# Zone — Anti-Thrash Reflector: Design Plan

## Context

Long-running agent tasks fail in two modes: hard kills (addressed by durable resumable runs, audit #1) and soft failures where the agent keeps running but stops converging — repeating failed patches, reading without writing, or burning cost with nothing modified. This plan designs the detection + intervention system for three of the five stall patterns: P4 (repeated identical failures post-coaching), P5 (semantic wandering: reads without writes), P6 (cost-burn with static working set). P1 (exact-call repeat) is already handled by the loop detector. P2 (oscillation) and P3 (error-count no-progress) are out of scope: P2 needs a new content-hash ring; P3 is undermined by a finalize-only + baseline-masking verify-gate.

## Architecture

### Two-stage response state machine

Every stall pattern follows the same lifecycle:
- **Stage 1 (REFLECT)** — fires at the START of iteration `T` via a new `PreIterationHook`. Injects a cache-safe reflection into the last `role:"tool"` message (Pattern A / `appendContext{mode:"append-to-tool"}`). The model sees it before its next call. Non-terminal.
- **Stage 2 (CIRCUIT-BREAK)** — fires at the END of iteration `T + ANTI_THRASH_BREAK_ITERS` via an inline check alongside the existing L5.1b-2 / forced-tier promotions (~agentLoop.ts:3963). If the stall signal is still non-null (pattern persists), returns `synthesizeStallExit()` with `terminationReason:"semantic_stall"`. The model gets `ANTI_THRASH_BREAK_ITERS` full iters to self-correct.

Two components, clean separation:
- **`PreIterationHook` (`antiThrashHook`)** — detection, state tracking, Stage 1 reflection only. Mold = `chainSaturationWarnHook` (agentLoop.ts:2765); closes over loop bindings; no `PreIterationContext` widening.
- **End-of-iter inline check** (inside `if (toolCalls.length > 0)` block, before `continue` at :3965) — Stage 2 only. Calls `synthesizeStallExit()` → `terminationReason:"semantic_stall"` → graceful, resumable.

This keeps `{kind:"block"}` → `hook_blocked` out of the critical path. Stage 2 is in the established end-of-iter inline region where cross-iter checks already live (`rollbackCount >= 2`, `iter >= 2 && hasRepeatReads`), with direct access to all mutable closure state and the ability to `return`.

### Hook state (closure variables, declared near agentLoop.ts:1894)

```typescript
let antiThrashStage1Fired = false;
let antiThrashStage1FiredAtIter = -1;
let antiThrashStage1Pattern: "failure_stall" | "wandering" | "cost_burn" | "" = "";
```

No per-iter snapshot variables are needed — all three predicates use **accumulated** free signals (see below). The hook itself has no `shouldRun` guard re: other hooks (chain-saturation and anti-thrash are independent; their messages are distinct and complementary).

### Pure signal module: `src/llm/antiThrash.ts` (new file)

Pure functions, no I/O, fully unit-testable. All thresholds are params (callers pass the constants).

```typescript
export interface AntiThrashContext {
  iter: number;
  failureHistory: Map<string, FailureRecord[]>;  // from closure: agentLoop.ts:2048
  coachingAttempts: number;                       // coachingController.attempts getter
  filesReadCountThisRun: Map<string, number>;     // from closure: agentLoop.ts:2456
  filesModifiedSize: number;                      // filesModified.size: agentLoop.ts:2043
  isReadOnly: boolean;                            // isReadOnlyMode closure binding
  archetype: string | undefined | null;           // input.originalArchetype
  costUsd: number;                                // budget.snapshot().costUsd: agentLoop.ts:2427
}

export type AntiThrashSignalKind = "failure_stall" | "wandering" | "cost_burn";

export interface AntiThrashSignal {
  pattern: AntiThrashSignalKind;
  summaryTitle: string;           // short, for toast/ERROR_LINE
  detail: Record<string, unknown>; // for telemetry + reflection text
}

// Exported for tests
export function detectFailureStall(ctx, thresholds): AntiThrashSignal | null
export function detectWanderingSignal(ctx, thresholds): AntiThrashSignal | null
export function detectCostBurnSignal(ctx, thresholds): AntiThrashSignal | null

// Priority order: P4 > P5 > P6 (returns first match)
export function computeAntiThrashSignal(ctx, thresholds?): AntiThrashSignal | null
export function buildStallReflectionText(signal: AntiThrashSignal): string
```

`FailureRecord` imported from agentLoop.ts (already exported: agentLoop.ts:1097 — confirm export or re-export from antiThrash.ts after reading).

### Three predicates with guards

**Pattern 4 — `detectFailureStall`**

Signal: `detectRepeatedFailure(failureHistory, path)` returns a non-null verdict for ANY path in `failureHistory` where records ≥ 2. Function lives at agentLoop.ts:1186-1218; already exported — reuse verbatim.

Guard / de-confliction:
- Only fires when `coachingAttempts >= ANTI_THRASH_FAILURE_COACH_MIN` (default 2). Coaching has tried at least twice without fixing the pattern. This cleanly gates out the first coaching round.
- Gate: `!isReadOnly` (same as chainSaturationWarnHook). No archetype exclusion — apply_patch failures are always patch-mode.
- Loop detector de-confliction: loop detector catches exact `(tool,args)` repeat in an 8-call window. Pattern 4 catches apply_patch failures with DIFFERENT args (different patch content each try). No overlap.

Reflection text template (P4):
```
[ZONE_ANTI_THRASH] The same patch failure has recurred on '${filePath}' after ${coachingAttempts}
coaching attempt(s). Pattern: ${reason}. Coaching has not resolved this.
Break the cycle NOW:
(a) ABANDON this approach — use a different implementation strategy entirely.
(b) Call suggest_scope_change if the target file differs from your plan.
(c) Write the FINAL SUMMARY acknowledging what could not be resolved and exit.
Do NOT apply another patch to '${filePath}' using the same failing approach.
```

**Pattern 5 — `detectWanderingSignal`**

Signal: `iter >= ANTI_THRASH_WANDER_ITER_MIN` AND `filesModifiedSize === 0` AND `totalReadsAcrossFiles >= ANTI_THRASH_WANDER_READ_MIN`.

`totalReadsAcrossFiles` = `[...filesReadCountThisRun.values()].reduce((s, c) => s + c, 0)`.

Guard:
- Archetype exclusion: `archetype === "question" || archetype === "investigation"` → return null. Mirrors chainSaturationWarnHook's exclusion.
- `isReadOnly` → return null.
- `filesModifiedSize > 0` → return null (writes happened, not wandering).

Relationship with `chainSaturationWarnHook`: chain-saturation fires once at iter≥6 with zero successful apply_patches (patch-mode only). P5 fires at iter≥8 with zero writes across ALL tools (broader condition). Let both fire — they're distinct signals. If chain-saturation fired, the LLM already had one nudge; P5 fires with a more specific "read count" diagnostic.

Reflection text template (P5):
```
[ZONE_ANTI_THRASH] Semantic wandering: ${uniqueFiles} files read (${totalReads} total reads,
${multiReadCount} re-read multiple times) across ${iter} iterations — no code written.
You must commit now:
(a) Apply a patch implementing your best current hypothesis (imperfect is acceptable).
(b) Write the FINAL SUMMARY with your findings if this task requires no code changes.
Do NOT continue reading without committing to an action.
```

**Pattern 6 — `detectCostBurnSignal`**

Signal: `iter >= ANTI_THRASH_COST_BURN_ITER_MIN` AND `costUsd >= ANTI_THRASH_COST_BURN_USD` AND `filesModifiedSize === 0`.

Guard:
- Archetype exclusion: `archetype === "question" || archetype === "investigation"` → null. Same rationale as P5.
- `isReadOnly` → null.

Reflection text template (P6):
```
[ZONE_ANTI_THRASH] Cost burn with no forward progress: $${costUsd.toFixed(3)} spent
across ${iter} iterations with no files modified. Commit to an action:
(a) Apply a patch or write a file implementing your current hypothesis.
(b) Write the FINAL SUMMARY and exit if this task requires no code changes.
```

### Constants (all in `src/llm/antiThrash.ts`, all env-overridable)

| Constant | Default | Env override | Notes |
|---|---|---|---|
| `ANTI_THRASH_FAILURE_COACH_MIN` | 2 | `ZONE_ANTI_THRASH_FAILURE_COACH_MIN` | P4: coaching attempts before stage 1 |
| `ANTI_THRASH_WANDER_ITER_MIN` | 8 | `ZONE_ANTI_THRASH_WANDER_ITER_MIN` | P5: min iters before wander fires |
| `ANTI_THRASH_WANDER_READ_MIN` | 5 | `ZONE_ANTI_THRASH_WANDER_READ_MIN` | P5: total reads threshold |
| `ANTI_THRASH_COST_BURN_ITER_MIN` | 10 | `ZONE_ANTI_THRASH_COST_BURN_ITER_MIN` | P6: min iters |
| `ANTI_THRASH_COST_BURN_USD` | 1.00 | `ZONE_ANTI_THRASH_COST_BURN_USD` | P6: min cost before check |
| `ANTI_THRASH_BREAK_ITERS` | 3 | `ZONE_ANTI_THRASH_BREAK_ITERS` | iters of persistence before stage 2 |

All parsed with `Number.isFinite` guard (per feedback: `parseFloat` + NaN fallback pattern). Candidates for a future Settings preset alongside `TERMINATE_THRESHOLD`, `TOKEN_BUDGET_MID_WARN`.

### Hook registration

Priority 40 — after chain-saturation (30). Registered in `_internalPreIterHooks` array at agentLoop.ts:2797:
```typescript
const _internalPreIterHooks = [softIterWarnHook, midBudgetWarnHook, chainSaturationWarnHook, antiThrashHook];
```

`shouldRun` reads: `!antiThrashStage1Fired && computeAntiThrashSignal({...}) !== null`.

`run` mutates closure state directly (like all internal hooks): sets `antiThrashStage1Fired = true`, `antiThrashStage1FiredAtIter = ctx.iter`, `antiThrashStage1Pattern = signal.pattern`. Emits `[zone-anti-thrash-stage1]` telemetry. Emits `stall_warning_emitted` structured event. Returns `{kind:"appendContext", mode:"append-to-tool", content: buildStallReflectionText(signal)}`.

Stage 2 inline check (after promotion block, before `continue` at :3965):
```typescript
if (
  antiThrashStage1Fired &&
  !isReadOnlyMode &&
  (iter - antiThrashStage1FiredAtIter) >= ANTI_THRASH_BREAK_ITERS
) {
  const persistingSignal = computeAntiThrashSignal({
    iter, failureHistory, coachingAttempts: coachingController.attempts,
    filesReadCountThisRun, filesModifiedSize: filesModified.size,
    isReadOnly: isReadOnlyMode, archetype: input.originalArchetype,
    costUsd: budget.snapshot().costUsd,
  });
  if (persistingSignal !== null) {
    input.onStructuredEvent?.({
      type: "stall_detected_terminal",
      title: `Semantic stall: ${persistingSignal.summaryTitle}`,
      status: "error",
    });
    debugLog("[zone-anti-thrash-stage2]", JSON.stringify({
      iter: iter + 1, runId: input.runId, pattern: persistingSignal.pattern,
      itersAfterReflection: iter - antiThrashStage1FiredAtIter,
    }));
    return synthesizeStallExit(iter, persistingSignal);
  }
}
```

### Resumable terminal wiring

**1. `terminationReason` union** (agentLoop.ts:316):
Add `| "semantic_stall"` to the existing union. `EnvelopeStatus` at diskRunEnvelope.ts:30-33 is derived via `Exclude<NonNullable<AgentLoopResult["terminationReason"]>, "natural_completion">` — **auto-includes `"semantic_stall"`, zero schema change**.

**2. `synthesizeStallExit`** (new function, near agentLoop.ts:2640, after `synthesizeScopeBlockCircuitBreakerExit`):
```typescript
const synthesizeStallExit = (iterNumber: number, signal: AntiThrashSignal): AgentLoopResult => {
  const msg = `Task paused: semantic stall detected (${signal.pattern}). ${signal.summaryTitle}. ` +
    `Use --resume to try again with a different approach.`;
  debugLog("[zone-anti-thrash-terminal]", JSON.stringify({ iter: iterNumber, runId: input.runId, ...signal.detail }));
  emitRunBreakdownSummary();
  emitCacheSummary();
  emitWebSearchSummary();
  emitSelfValidationSummary();
  return {
    success: false, summary: msg, toolCallLog,
    filesModified: Array.from(filesModified),
    patchValidatedByAgent: false,
    verificationReason: "no_verification_attempted",
    terminationReason: "semantic_stall",
    tokenUsage: budget.tokenUsage, costUsd: budget.snapshot().costUsd,
    iterCount: iterNumber + 1,
  };
};
```

**3. `getPatchUserFacingReason`** (patchUserFacingReason.ts — add explicit case):
```typescript
case "semantic_stall":
  return {
    reason: terminationReason,
    userFacingMessage: "Detected a non-progress loop. Paused to prevent wasted spend. Retry with a more specific approach.",
    canResume: true,
    resumeHint: "Narrow the task or provide a different implementation hint",
    category: "warning",
  };
```
`canResume: true` — the durable envelope captures the full task state; `--resume` re-plans with stall context visible in the envelope.

**4. Event types** (agentLifecycleEvents.ts, near `loop_warning_emitted` at line ~144):
```typescript
| "stall_warning_emitted"
| "stall_detected_terminal"
```

**5. TUI dispatch** (eventToActions.ts, mirror `loop_warning_emitted` / `loop_detected_terminal` pattern):
```typescript
case "stall_warning_emitted":
  return { actions: [{ type: "TOAST_PUSH", entry: { id: randomUUID(), message: evt.title ?? "Stall warning", level: "warning" } }], intents: [] };

case "stall_detected_terminal":
  return { actions: [{ type: "SPINNER_STOP" }, { type: "ERROR_LINE", text: evt.title ?? "Semantic stall" }], intents: [] };
```

The `agentLoopComplete` / `run_summary` bus event sequence remains unchanged — only a new event type is added.

### Composition with audit #1 (durable resumable runs)

A `semantic_stall` terminal stamps the envelope with `status:"semantic_stall"` (same path as other non-success exits: agentLoop.ts:1755 → `stampEnvelopeStatus`). The envelope records `task`, `executionPlan`, `todos`, `failureHistory`, `staging` state. On `--resume` / `/resume`, the TUI/CLI load the envelope and re-enter `onSubmit`, which re-generates a plan with prior context visible via `priorSessionSummary`. The stall reason appears in the session summary but does NOT re-trigger the same stall immediately (the new run is a fresh agent loop with the same task + plan context, giving the model a fresh perspective).

The TUI startup toast (already fires for any resumable envelope) fires for `"semantic_stall"` with zero additional code — the toast logic at `diskRunEnvelope.ts` checks `status !== "running"` && `status !== "natural_completion"`.

## Files changed

| File | Change |
|---|---|
| `src/llm/antiThrash.ts` | **NEW** — pure signal functions, types, constants, reflection text builder |
| `src/llm/agentLoop.ts` | Union +:316, `synthesizeStallExit` ~:2640, closure state ~:1894, hook def ~:2796, `_internalPreIterHooks` :2797, Stage 2 inline check ~:3964 |
| `src/llm/patchUserFacingReason.ts` | Add `"semantic_stall"` case |
| `src/core/agentLifecycleEvents.ts` | Add `"stall_warning_emitted"` / `"stall_detected_terminal"` to event union |
| `src/cli/tui/hooks/eventToActions.ts` | Add two cases |
| `src/llm/antiThrash.test.ts` | **NEW** — unit tests for all pure functions |

`diskRunEnvelope.ts` — no change (EnvelopeStatus auto-derives). `postToolUseHook.ts` — no change (no framework modification). `handleToolResult.ts` — no change (Stage 2 is not in the per-tool path).

## Increment plan

### Inc-1 — Pattern 4 + full wiring (land first, dogfood)
1. `src/llm/antiThrash.ts`: `AntiThrashContext`, `AntiThrashSignal`, `AntiThrashSignalKind`, `AntiThrashThresholds`, `ANTI_THRASH_FAILURE_COACH_MIN`, `ANTI_THRASH_BREAK_ITERS`, `detectFailureStall()`, `computeAntiThrashSignal()` (P4 branch only), `buildStallReflectionText()` (P4 case).
2. `agentLoop.ts`: add `"semantic_stall"` to union, add `synthesizeStallExit()`, add closure state vars, add `antiThrashHook` (P4 shouldRun/run), register at :2797, add Stage 2 inline check.
3. `agentLifecycleEvents.ts`, `eventToActions.ts`, `patchUserFacingReason.ts` — wire new event types + reason case.
4. `antiThrash.test.ts`: P4 true-positive (identical_patch_retried, trigger_repeated_3x), false-positive guards (< COACH_MIN attempts, isReadOnly), two-stage transition, `synthesizeStallExit` returns `{terminationReason:"semantic_stall"}`, canResume true.
5. `npm run typecheck && npm test` green.

### Inc-2 — Pattern 5 (wandering)
1. `antiThrash.ts`: `ANTI_THRASH_WANDER_ITER_MIN`, `ANTI_THRASH_WANDER_READ_MIN`, `detectWanderingSignal()`, add P5 branch to `computeAntiThrashSignal()`, add P5 case to `buildStallReflectionText()`.
2. `antiThrash.test.ts`: P5 true-positive, false-positives (question/investigation archetype, isReadOnly, filesModified>0, below iter threshold).
3. No changes to agentLoop.ts or wiring files (pattern is fully in antiThrash.ts).

### Inc-3 — Pattern 6 (cost-burn)
1. `antiThrash.ts`: `ANTI_THRASH_COST_BURN_ITER_MIN`, `ANTI_THRASH_COST_BURN_USD`, `detectCostBurnSignal()`, add P6 branch to `computeAntiThrashSignal()`, add P6 case to `buildStallReflectionText()`.
2. `antiThrash.test.ts`: P6 true-positive, false-positives (archetype gate, cost below threshold, iter below threshold, filesModified>0).

## Test strategy

**Unit tests (`antiThrash.test.ts`):**
- `detectFailureStall`: returns null when `<2` records, returns null when coaching attempts < threshold, returns signal for `identical_patch_retried` with 2 paths, returns signal for `trigger_repeated_3x`, returns null for `same_trigger_repeated_2x` (below threshold).
- `detectWanderingSignal`: returns null for `question`/`investigation` archetypes, returns null when `filesModifiedSize > 0`, returns null below iter threshold, returns null below read threshold, returns signal at threshold.
- `detectCostBurnSignal`: returns null below USD threshold, returns null below iter threshold, returns null when `filesModifiedSize > 0`, returns signal at both thresholds.
- `computeAntiThrashSignal`: P4 takes precedence over P5/P6 when all three match.
- Two-stage transition: Stage 1 fires at first true signal; Stage 2 fires after `ANTI_THRASH_BREAK_ITERS`; Stage 2 does NOT fire if signal resolves mid-way.

**Integration test (existing `agentLoop.dispatch.test.ts` pattern):**
- Synthesize a run with K apply_patch failures producing `identical_patch_retried` verdict in failureHistory + coaching attempts ≥ 2 → verify `loop_warning_emitted` event fires → verify after `ANTI_THRASH_BREAK_ITERS` more iters → `stall_detected_terminal` event + result `terminationReason:"semantic_stall"`.
- Verify loop detector (PostToolUseHook) does NOT fire for P4 (args differ each iter).

**Typecheck:** `npm run typecheck` verifies no `terminationReason:"semantic_stall"` fallthrough to generic `default` (explicit case in patchUserFacingReason ensures it), and `EnvelopeStatus` derivation includes the new value.

## Key risks / notes for implementer

1. **`detectRepeatedFailure` export** — verify it is already exported from agentLoop.ts (agentLoop.ts:1186). If not, either re-export or duplicate in antiThrash.ts with a `/* duplicated from agentLoop.ts — consolidate on refactor */` note.
2. **Stage 2 placement** — must be inside `if (toolCalls.length > 0)` block, before `continue` at :3965. If placed after the `if` block, it fires on the final-answer (no-tool) path too, potentially interrupting a legitimate conclusion.
3. **`budget.snapshot().costUsd` hot path** — verify `snapshot()` in `TokenBudgetMeter` is O(1) (just reads `_iterCostAccumulator.total_cost`). It is — confirmed in exploration.
4. **Double-reflection guard for P5 vs chain-saturation** — chain-saturation one-shot fires at iter≥6, P5 fires at iter≥8. There is a window (iter 8+) where P5 can fire even after chain-saturation already fired. This is acceptable — the messages are distinct. No guard needed.
5. **`FailureRecord` import** — `FailureRecord` type is declared at agentLoop.ts:1097. Either export it from agentLoop.ts or re-type in antiThrash.ts. If it's not exported, redefine as `export type FailureRecord = { trigger: string; errorLine: number | null; patchHash: string; iter: number }` in antiThrash.ts (same shape, string-typed trigger).
6. **Archetype gate type** — `input.originalArchetype` is `string | undefined`. Guard in antiThrash.ts: `ctx.archetype === "question" || ctx.archetype === "investigation"`. Already the chainSaturationWarnHook pattern.
