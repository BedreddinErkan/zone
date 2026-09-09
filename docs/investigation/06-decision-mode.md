# 06 — Decision Mode Audit: Classifier Taxonomy, Cost, Correctness

**Date:** 2026-09-09 · **Scope:** `src/llm/taskClassifier.ts`, `src/llm/tierLimits.ts`, `src/llm/agentLoop.ts`, `src/cli/dispatch.ts`, `src/tools/tierToolSubsets.ts`, `src/tools/scopeGuard.ts`, `docs/determinism.md` · **Method:** read-only code trace

---

## §1 — Classifier Taxonomy

### 1.1 Classifier implementation

**`src/llm/taskClassifier.ts`** (919 lines) — an LLM-based classifier that calls a cheap model (default: Haiku/gpt-4o-mini) with a structured prompt to produce a `TaskClassification` JSON object.

**Invocation:** `classifyTask(task, options)` — called from `agentLoop.ts:2248-2280` before the main loop begins. The result is cached in a process-scoped `Map<string, TaskClassification>` keyed on the djb2 hash of the normalised task string.

**Temperature:** hardcoded to `0` (`taskClassifier.ts` — the LLM call). No PRNG in the classification path.

**Timeout:** 5000ms default (`DEFAULT_TIMEOUT_MS`), configurable via `options.timeoutMs`.

**Output ceiling:** 1024 tokens (`CLASSIFIER_OUTPUT_CEILING`), clamped by `getMaxOutputTokens(model)`.

### 1.2 Tier vocabulary (3 values)

```typescript
export type TaskTier = "simple" | "medium" | "complex";
```

| Tier | Definition (from prompt) | Example tasks |
|---|---|---|
| **simple** | ≤2 files, ≤10 iterations, no subagent needed | Comment add, single-file rename, small typo fix, single CSS change |
| **medium** | 3-8 files, 10-25 iterations, may need subagent (max 1) | Multi-file refactor, new feature in 1-2 modules, config migration |
| **complex** | 9+ files, 25+ iterations, may need subagent (max 3) | Architecture change, large refactor, cross-cutting concern, breaking changes |

**Prompt heuristics** (`taskClassifier.ts:73-168`):
- "find X with N callers" → multi-investigation → medium or complex
- "change signature that breaks callers" → cross-cutting → complex
- "all instances" / "every X" / "across the codebase" → complex
- Single file edit with no cross-references → simple
- Test fix tasks default to medium unless clearly a trivial assertion typo
- Signal words that raise tier: "stale", "outdated", "refactor", "Phase J/K/L/AS/D/..."
- When uncertain, classify UP (medium > simple, complex > medium)

### 1.3 Archetype vocabulary (7 values)

```typescript
export type TaskArchetype =
  | "simple_add"
  | "targeted_fix"
  | "refactor"
  | "debug"
  | "investigation"
  | "question"
  | "complex_multi_file";
```

| Archetype | Intent shape | Keywords |
|---|---|---|
| **simple_add** | Additive new code, 1-2 files, no investigation | "add", "create", "new", "expose" |
| **targeted_fix** | Bug fix in 1-2 known files, must read before patching | "fix", error messages, specific paths with line numbers |
| **refactor** | Mechanical rename/restructure ≥3 files, behavior preserved | "rename", "extract", "consolidate", "across all" |
| **debug** | Investigate-then-fix a failure, reproduction needed | "failing test", "why does X break", "exit code N" |
| **investigation** | Read-only "why/how" question, no code change | "why", "how does", "walk me through", "explain" |
| **question** | Pure Q&A, listing/enumeration, filesystem queries | "what's the difference", "list", "show all", "which files" |
| **complex_multi_file** | NEW feature spanning ≥3 files (not a rename) | "implement", "build", "add support for" + multiple nouns |

**Archetype is orthogonal to tier** — a `simple` task can be `targeted_fix` or `simple_add`; a `complex` task can be `refactor` or `complex_multi_file`.

### 1.4 Classification output shape

```typescript
export interface TaskClassification {
  tier: TaskTier;
  estimatedFiles: number;
  estimatedIterations: number;
  confidence: number;          // 0.0-1.0, model self-reported
  reasoning?: string;
  classifierCostUsd: number;
  classifierLatencyMs: number;
  classifierModel: string;
  fallbackUsed?: boolean;
  archetype: TaskArchetype;
  archetypeConfidence: number;
}
```

### 1.5 Confidence gate

**`CLASSIFIER_CONFIDENCE_THRESHOLD = 0.5`** (`taskClassifier.ts`). When `confidence < 0.5`, the tier is overridden to `"medium"` regardless of what the model returned. Two telemetry events fire:

- `[zone-tier-low-confidence-fallback]` — only when the override changes the tier (not `medium → medium`)
- `[zone-task-classified]` — always, with `fallbackReason: "low_confidence"`

### 1.6 Fallback behavior

On ANY failure (API error, timeout, parse failure, invalid tier value, low confidence), the result is `tier: "medium"` with `fallbackUsed: true`. **There is no failure mode that produces `"simple"` or `"complex"` from the fallback path.**

---

## §2 — Decision Paths (Routing)

### 2.1 The tier → limits resolution

**`src/llm/tierLimits.ts`** — `resolveTierLimits(classification?, options?)` maps a classification to execution limits.

**Priority (highest first):**
1. `options.forceTierOverride` — per-request override (sweep, API caller)
2. `ZONE_FORCE_TIER` env var — server-level testing bypass
3. User overrides from `~/.zone/tier-limits.json` — merged on top of defaults
4. `TIER_LIMITS` defaults — used when no classification or no user override

### 2.2 Tier limits table

```typescript
export const TIER_LIMITS: Record<TaskTier, TierLimits> = {
  simple:  { maxSubagentCalls: 0, tokenBudgetCap: 400_000, softIterWarn: 15 },
  medium:  { maxSubagentCalls: 0, tokenBudgetCap: 600_000, softIterWarn: 25 },
  complex: { maxSubagentCalls: 4, tokenBudgetCap: 800_000, softIterWarn: 40 },
};
```

| Limit | Simple | Medium | Complex |
|---|---|---|---|
| Max subagent calls | 0 | 0 | 4 |
| Token budget cap | 400k | 600k | 800k |
| Soft iteration warning | 15 | 25 | 40 |

### 2.3 Three independent locks withholding Task below complex tier

The `Task` tool (subagent dispatch) is withheld from simple and medium tiers by **three independent mechanisms** that reference each other nowhere in code:

| Lock | Location | Mechanism |
|---|---|---|
| **1. Tier tool subset** | `tierToolSubsets.ts` | `MEDIUM_TIER_TOOLS` (9-tool allowlist) does not include `"Task"`. Positive allowlist — tools must appear to be offered. |
| **2. Budget gate** | `agentLoop.ts:2567` | `taskBlockedByBudget = (tierLimits?.maxSubagentCalls ?? Infinity) === 0 \|\| taskIsSmall` — strips Task from `toolsForLLM` (the array sent to the provider). |
| **3. Runtime cap** | `toolExecutor.ts:1073-1077` | `effectiveSubagentCap` checked against `getSubagentCallCount(parentRunId)` — refuses the call at runtime if cap is 0. |

None is individually sufficient. Lifting one alone produces a tool the model can see, calls, and is refused — "strictly worse than leaving it hidden" (`docs/deferred-work.md` item 176).

### 2.4 Tool subset per tier

**`src/llm/tierToolSubsets.ts`** — `tierToolFilter(tier, capabilityFilter?)` returns the allowed tool names:

| Tier | Tool count | Notable inclusions/exclusions |
|---|---|---|
| **simple** | 5 tools | `read_file`, `list_files`, `search_in_files`, `apply_patch`, `write_file` — no `run_command`, no `multi_edit`, no `Task` |
| **medium** | 9 tools | Adds `run_command`, `run_command_readonly`, `multi_edit`, `find_references` — still no `Task` |
| **complex** | 18 tools (all) | Full toolset including `Task`, `run_command_background`, `suggest_scope_change`, etc. |

### 2.5 Archetype → scope guard interaction

**`src/tools/scopeGuard.ts:29-31`** — the archetype directly controls write-scope enforcement:

```typescript
if (archetype === "refactor" || archetype === "complex_multi_file") {
  // bypass: allow any write regardless of plan
}
```

The `refactor` and `complex_multi_file` archetypes **bypass the scope guard entirely** — any file write is allowed regardless of the execution plan. All other archetypes (`simple_add`, `targeted_fix`, `debug`, `investigation`, `question`) are subject to plan-scoped write enforcement.

**Symbol-grounded scope expansion** (`scopeGuard.ts:279-282`): when a write is blocked, the scope can be expanded if the blocked file contains a plan symbol — but **only for `refactor` and `complex_multi_file` archetypes**. Other archetypes get `"archetype_not_refactor"` and the write stays blocked.

### 2.6 Dispatch routing in agentLoop

**`agentLoop.ts:2248-2280`** — the classification feeds into:

1. **Tier resolution** → `resolveTierLimits(input.taskClassification)` at line 2559
2. **Tool subset** → `tierToolFilter(tier, capabilityFilter)` determines `effectiveAllowedSet`
3. **Budget gate** → `taskBlockedByBudget` strips Task from offered tools
4. **Iteration budget** → `tierLimits.softIterWarn` sets the soft warning threshold
5. **Token budget** → `tierLimits.tokenBudgetCap` sets the hard ceiling
6. **Subagent cap** → `tierLimits.maxSubagentCalls` forwarded to `executeTool`
7. **Archetype** → forwarded to `executeTool` for scope guard decisions
8. **Telemetry** → `[zone-task-classified]` event with tier, archetype, confidence, cost

---

## §3 — Cost Profiles

### 3.1 Classifier cost

The classifier itself costs ~$0.0001-0.0003 per call (Haiku/gpt-4o-mini, ~2000 input tokens + ~120 output tokens). It is called **once per distinct task string per process** (cached thereafter).

### 3.2 Execution cost by tier

| Tier | Model selection | Iteration ceiling | Token budget | Subagent budget | Expected cost range |
|---|---|---|---|---|---|
| **simple** | User's model (no downgrade) | softIterWarn 15 (hard: 45) | 400k tokens | 0 | $0.005-0.03 |
| **medium** | User's model | softIterWarn 25 (hard: 75) | 600k tokens | 0 (dead config, see §4.2) | $0.02-0.10 |
| **complex** | User's model | softIterWarn 40 (hard: 120) | 800k tokens | 4 | $0.05-0.30 |

**Note:** The model is NOT downgraded for lower tiers. The classifier selects the tier, but the user's chosen model runs regardless. Tier affects budgets and tool availability, not model selection.

### 3.3 Iteration budget mechanics

The `softIterWarn` is a warning threshold. At this iteration count, the agent receives a wrap-up prompt. The **hard stop** is `softIterWarn * 3` (the cost ceiling via `tokenBudgetCap`). The agent loop at `agentLoop.ts:2798-2830` applies the tier limits:

```typescript
if (tierLimits) {
  const effectiveSoftIterWarn = tierLimits.softIterWarn;
  // Overwrites the default maxIterationsForRun
  // ...
}
```

---

## §4 — Correctness Analysis

### 4.1 Classifier determinism

**`docs/determinism.md`** records a measured finding:

> "Three of forty task strings returned a different tier on a byte-identical repeat."

The classifier uses `temperature: 0`, but this **constrains sampling; it does not make the model reproducible across calls**. The cache bounds the exposure: a byte-identical task string is classified once per process and replayed thereafter. The non-determinism only affects the **first classification of each distinct task string in each process**.

**Impact:** A task that gets classified as `simple` on one run might get `medium` on another (or vice versa), receiving different budgets and tool subsets. The confidence gate (`< 0.5 → medium`) mitigates the most dangerous misclassification (false `simple`), but does not address false `complex` (over-provisioning) or false `medium` (the fallback is already medium, so this is invisible).

### 4.2 Dead config: medium tier maxSubagentCalls

**`TIER_LIMITS.medium.maxSubagentCalls`** was `1` in earlier code but is now `0` (`tierLimits.ts:26`). The AUDIT-subagent-adoption.md identified it as dead config when it was `1` (because `Task` was absent from the medium toolset). It has since been corrected to `0`, matching reality. **This is now consistent, not dead.**

### 4.3 Archetype bypass is a security surface

The `refactor` and `complex_multi_file` archetype bypass in `scopeGuard.ts:29-31` means:

- A task classified as `refactor` can write to ANY file, regardless of the execution plan
- A task classified as `complex_multi_file` has the same unrestricted write access
- If the classifier misclassifies a `targeted_fix` as `refactor`, the scope guard is bypassed for a task that should have been scoped

**Risk:** Classifier error in archetype directly weakens write-scope enforcement. The bypass exists because refactors and complex multi-file changes legitimately touch files not in the plan — but the trust is placed in the classifier's archetype judgment, not in any runtime verification.

### 4.4 Fallback is always medium — asymmetric safety

The fallback to `medium` on any classifier failure is **conservative in one direction**: it prevents under-provisioning (a task that should be `complex` gets `medium` budgets, which is insufficient but not dangerous). It does NOT prevent over-provisioning: a genuinely simple task that the classifier fails on gets `medium` budgets and tool access, which wastes cost but doesn't create a correctness risk.

### 4.5 Test coverage

| Test file | Coverage |
|---|---|
| `taskClassifier.test.ts` | Core classification, JSON parsing, tier validation, fallback behavior |
| `taskClassifier.stability.test.ts` | Cache hit invariant, same input → same output |
| `taskClassifier.outputBudget.test.ts` | Output ceiling clamping, token budget |
| `taskClassifier.fallbackTelemetry.test.ts` | Telemetry events on fallback, confidence gate |
| `taskClassifier.tierArchetypeDecoupling.test.ts` | Tier and archetype are independent axes |
| `taskClassifier.archetype.test.ts` | **Excluded from main suite** (`vitest.config.ts` exclude) — separate `test:l3` script |

**Gap:** The excluded `archetype.test.ts` is not run in CI's `npm test`. If archetype classification regresses, the main suite will not catch it.

### 4.6 Known determinism issues

From `docs/determinism.md`:
- 3/40 tasks returned different tiers on repeat (measured, not fixed)
- 24/40 produced different reasoning text (cosmetic, not behavioral)
- Process-scoped cache mitigates within a session but not across restarts
- No measurement of how often distinct-task-first-classification occurs in production

---

## §5 — Decision Paths Summary

```
User prompt arrives
        │
        ▼
  classifyTask(prompt)  ──── cache hit? ─── return cached
        │                         │
        │ (cache miss)            │
        ▼                         │
  LLM call (Haiku, temp=0)       │
        │                         │
        ▼                         │
  Parse JSON response            │
        │                         │
  ┌─────┴──────┐                  │
  │ confidence │                  │
  │  < 0.5?    │                  │
  └─────┬──────┘                  │
        │ yes              no     │
        ▼                  ▼      │
  Override to          Use model  │
  tier: "medium"       output     │
        │                  │      │
        └──────┬───────────┘      │
               ▼                  │
     TaskClassification           │
     { tier, archetype,          │
       confidence, ... }         │
               │                  │
               ▼                  │
     resolveTierLimits()  ◄──────┘
               │
     ┌─────────┼──────────┐
     ▼         ▼          ▼
  Tool       Budget    Archetype
  subset     limits    → scope guard
  (tier      (token,   bypass for
   filter)   iter,     refactor/
             subagent) complex_multi_file
     │         │          │
     └─────────┼──────────┘
               ▼
        Agent loop begins
```

---

## §6 — Top Risks and Gaps

### 6.1 Classifier non-determinism affects provisioning

**Risk: Medium.** 3/40 tasks get different tiers across runs. The cache mitigates within a process, but the first classification of each new task string is exposed. A task that should be `complex` but gets `simple` is under-provisioned (400k token budget vs 800k, no subagent access, restricted tool subset).

**Evidence:** `docs/determinism.md` — measured finding.

### 6.2 Archetype bypass is trust in the classifier

**Risk: Medium.** `refactor` and `complex_multi_file` bypass the scope guard. A misclassified archetype weakens write-scope enforcement. No runtime verification checks whether the archetype's unrestricted writes are actually refactor-shaped.

**Evidence:** `scopeGuard.ts:29-31`.

### 6.3 Excluded archetype test not in CI

**Risk: Low-Medium.** `taskClassifier.archetype.test.ts` is excluded from the main test suite and runs only via `npm run test:l3`. If archetype classification regresses, `npm test` in CI will not catch it.

**Evidence:** `vitest.config.ts` exclude list.

### 6.4 No misclassification telemetry

**Risk: Low.** There is no feedback loop that measures whether the classifier's tier/archetype matched the actual run outcome (e.g., a `simple` task that exhausted its 400k token budget, or a `complex` task that completed in 3 iterations). Without this, classifier tuning is guesswork.

**Evidence:** No test or code searches for "misclassify" or "tier mismatch" in production telemetry.

### 6.5 Large-file bump heuristic

**Risk: Low.** The classifier prompt mentions a "Q.8 large-file bump" — tasks touching files over a certain line count get bumped up a tier. This is a heuristic that can over-classify tasks touching one large but simple file (e.g., a generated config).

**Evidence:** `taskClassifier.ts` prompt text, `ClassifyTaskOptions.targetFiles`.
