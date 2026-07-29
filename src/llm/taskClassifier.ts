import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createLLMClient } from "./factory.js";
import type { LLMProvider } from "./types.js";
import {
  extractResponsesApiOutputText,
  formatOpenAiThrownErrorPayload,
} from "./openaiClient.js";
import { extractUsage } from "./recordingClient.js";
import { getRequestContext } from "./openaiContext.js";
import { totalCost, type ProviderName } from "../usage/pricing.js";
import { log } from "../utils/logger.js";

export type TaskTier = "simple" | "medium" | "complex";

export type TaskArchetype =
  | "simple_add"
  | "targeted_fix"
  | "refactor"
  | "debug"
  | "investigation"
  | "question"
  | "complex_multi_file";

export interface TaskClassification {
  tier: TaskTier;
  estimatedFiles: number;
  estimatedIterations: number;
  /** 0.0-1.0 — model self-reported. Below CONFIDENCE_THRESHOLD triggers fallback. */
  confidence: number;
  reasoning?: string;
  classifierCostUsd: number;
  classifierLatencyMs: number;
  classifierModel: string;
  fallbackUsed?: boolean;
  archetype: TaskArchetype;
  archetypeConfidence: number;
}

export interface ClassifyTaskOptions {
  provider?: LLMProvider;
  userApiKey?: string;
  skipCache?: boolean;
  /** Test hook: override the 5s timeout. */
  timeoutMs?: number;
  /**
   * Explicit list of files the task will touch. When provided, used for the
   * Q.8 large-file bump instead of paths extracted from the task description.
   */
  targetFiles?: string[];
  /** Repo root for resolving relative targetFiles paths. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Test hook: override file line counting to avoid real fs access. */
  _fileLineCounter?: (filePath: string) => number;
}

const CLASSIFIER_SYSTEM_PROMPT = `You classify coding tasks for a tier-based execution system.

Tier definitions:
- "simple":  ≤2 files, ≤10 iterations, NO subagent dispatch needed.
             Examples: comment add, single-file rename, small typo fix, single CSS change.
- "medium":  3-8 files, 10-25 iterations, MAY need subagent (max 1).
             Examples: multi-file refactor, new feature in 1-2 modules, config migration.
- "complex": 9+ files, 25+ iterations, MAY need subagent (max 3).
             Examples: architecture change, large refactor, cross-cutting concern,
             find-and-modify across N callsites, intentional breaking changes
             that ripple through callers, multi-investigation tasks.

Two scopes matter:
- Edit scope: files that will be modified
- Investigation scope: files that must be read/understood before editing

A task with single-file edit scope can have multi-module investigation
scope. Both raise complexity. Tier accounts for the LARGER of the two.

Test-fix examples:
- "Fix typo in existing test assertion" → SIMPLE (single file, no investigation)
- "Fix stale tests after Phase X refactor" → MEDIUM (single edit, multi-module investigation: refactor context required)
- "Update fixtures to match new behavior in 3 modules" → MEDIUM (single edit, cross-module investigation)
- "Fix failing tests in src/cli/index.test.ts referencing outdated format flag handling" → MEDIUM (test fix requires reading implementation + related routing logic)

Classification heuristics:
- "find X with N callers/usages" → multi-investigation → MEDIUM or COMPLEX
- "change signature that breaks callers" → cross-cutting → COMPLEX
- "all instances" / "every X" / "across the codebase" → COMPLEX
- "intentional break" / "type errors" / "breaking change" → COMPLEX
- Single file edit with no cross-references → SIMPLE
- Pure cosmetic change (comment, rename in single file) → SIMPLE
- Test fix tasks (filename matches *.test.ts or task mentions "tests") default to
  MEDIUM unless the task is clearly a trivial assertion typo. Reason: test fixes
  typically require reading the implementation under test plus related modules to
  understand the correct expected behavior.
- Signal words that raise tier by one: "stale", "outdated", "refactor",
  "Phase J/K/L/AS/D/...", "recent change", "after refactor". Task framing
  suggesting "implementation is correct, tests are stale" should NOT be trusted
  — verify by reading the implementation first.

COMPLEX tier triggers (any one is sufficient):
- Rename / refactor of a symbol across ≥3 files where its definition +
  imports + call sites all need coordinated updates
- Task wording includes "across all N files" / "every reference" /
  "throughout the codebase" / "in each file" combined with a count ≥3
- An explicit list of 3+ file paths in the task description, all needing
  coordinated edits
- Signature change that ripples through caller files
- Cross-file API contract changes (rename, signature, return type)
  affecting ≥3 consumers

When uncertain between medium and complex, prefer complex for tasks involving:
- "rename" keyword + multi-file scope (≥3 files)
- "import" + "call site" mentioned together (suggests coordinated cross-file edit)
- Explicit file list with ≥4 entries

Counter-examples (stay MEDIUM, not COMPLEX):
- "Add new export to N files" — pure additions don't require coordinated
  FIND/REPLACE across files
- "Rename X to Y in 2 files" — count <3, medium scope

Be conservative: if uncertain, classify UP (medium > simple, complex > medium).

Output ONLY valid JSON:
{
  "tier": "simple" | "medium" | "complex",
  "estimatedFiles": <integer>,
  "estimatedIterations": <integer>,
  "confidence": <0.0-1.0>,
  "reasoning": "<one short sentence>",
  "archetype": "simple_add" | "targeted_fix" | "refactor" | "debug" | "investigation" | "question" | "complex_multi_file",
  "archetypeConfidence": <0.0-1.0>
}

ARCHETYPE CLASSIFICATION (orthogonal to tier):
Classify the task into one of 7 archetypes by intent shape:

- simple_add: Additive new code (endpoint, function, type, component), typically 1-2 files.
  No investigation needed because new code doesn't exist yet.
  Keywords: "add", "create", "new", "expose".

- targeted_fix: Bug fix in 1-2 known files. The buggy code MUST be read before patching.
  Keywords: "fix", error messages, specific file paths with line numbers.

- refactor: Mechanical rename/restructure across >=3 files. Behavior preserved, structure changed.
  Keywords: "rename", "extract", "consolidate", "across all", "everywhere".

- debug: Investigate-then-fix a failure. Reproduction required.
  Keywords: "failing test", "why does X break", "exit code N", "throws error", "returns 500".

- investigation: Read-only "why does X work this way" or "walk me through Y". No code change requested.
  Keywords: "why", "how does", "walk me through", "explain the".

- question: Pure Q&A, listing/enumeration, or filesystem queries. No code change requested.
  Keywords: "what's the difference", "should I use", "list", "show all", "what files",
  "which files", "enumerate", "find all", "how many", glob patterns (*.ts, **/*.ts).

- complex_multi_file: NEW feature spanning >=3 files (NOT a rename). Multiple components mentioned.
  Default fallback when uncertain.
  Keywords: "implement", "build", "add support for" + multiple nouns.

Boundary rules:
- "Add X" + 1 file = simple_add (not complex_multi_file).
- "Rename X to Y" = refactor (not complex_multi_file), regardless of file count.
- "Failing test" + "fix" = debug (not targeted_fix). Reproduction matters.
- When uncertain between targeted_fix and debug: debug if failure repro needed, targeted_fix if bug is already pinpointed.
- When uncertain between any narrow archetype and complex_multi_file: pick complex_multi_file (safer).
- "list / enumerate / show all" + filesystem scope = question (NOT complex_multi_file).`;

const DEFAULT_TIMEOUT_MS = 5000;
/** Confidence gate: classifier outputs below this threshold are overridden to "medium". */
export const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.5;
const MAX_OUTPUT_TOKENS = 300;

/** The tier vocabulary. */
const VALID_TIERS: readonly string[] = ["simple", "medium", "complex"];

/**
 * The archetype vocabulary. One copy, shared by the parser and
 * `getFallbackArchetype` — the parser now needs it before it validates tier, and
 * two lists that must agree are two lists that will eventually disagree.
 */
const VALID_ARCHETYPES: readonly string[] = [
  "simple_add", "targeted_fix", "refactor", "debug",
  "investigation", "question", "complex_multi_file",
];

const classificationCache = new Map<string, TaskClassification>();

function truncateForLog(value: unknown, maxChars = 600): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (typeof s !== "string") s = String(s);
  return s.length > maxChars ? `${s.slice(0, maxChars)}…[truncated]` : s;
}

// Q.8 large-file trigger helpers -----------------------------------------------

// Matches relative file paths mentioned in task descriptions, e.g. src/api/server.ts
const FILE_PATH_REGEX = /\b(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|go|py|rs|java|json|yaml|yml|md)\b/g;

function extractFilePaths(text: string): string[] {
  const matches = text.match(FILE_PATH_REGEX);
  return matches ? [...new Set(matches)] : [];
}

function safeFileLineCount(filePath: string, repoRoot: string): number {
  try {
    const fullPath = resolvePath(repoRoot, filePath);
    if (!existsSync(fullPath)) return 0;
    const content = readFileSync(fullPath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

function bumpForLargeFiles(
  tier: TaskTier,
  targetFiles: string[],
  repoRoot: string,
  fileLineCounter?: (filePath: string) => number
): { tier: TaskTier; bumpedFile?: string; bumpedLineCount?: number } {
  if (tier !== "simple" || targetFiles.length === 0) return { tier };
  const threshold = Number(process.env.ZONE_LARGE_FILE_LOC ?? 2000);
  const getLineCount = fileLineCounter ?? ((f) => safeFileLineCount(f, repoRoot));
  for (const filePath of targetFiles) {
    const lineCount = getLineCount(filePath);
    if (lineCount > threshold) {
      return { tier: "medium", bumpedFile: filePath, bumpedLineCount: lineCount };
    }
  }
  log("[zone-tier-bump-skipped]", JSON.stringify({
    event: "tier_bump_skipped",
    tier,
    candidateCount: targetFiles.length,
    candidates: targetFiles.map((f) => ({
      path: f,
      lineCount: getLineCount(f),
      exists: existsSync(resolvePath(repoRoot, f)),
    })),
    threshold,
    repoRoot,
  }));
  return { tier };
}

// -------------------------------------------------------------------------------

function hashTask(taskDescription: string): string {
  // Deterministic djb2 hash → base36 string. Produces stable cache keys
  // independent of Node version (no built-in crypto dependency).
  let hash = 5381;
  for (let i = 0; i < taskDescription.length; i += 1) {
    hash = ((hash << 5) + hash) ^ taskDescription.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function pickClassifierModel(provider: LLMProvider): string {
  // Use the cheapest registered model per provider. claude-haiku-4-5 ~$1/Mtok
  // input, gpt-5.4-mini ~$0.75/Mtok input — well below $0.0005/classification
  // for prompts under ~500 tokens.
  if (provider === "anthropic") {
    return process.env.ZONE_CLASSIFIER_MODEL_ANTHROPIC?.trim() || "claude-haiku-4-5";
  }
  return process.env.ZONE_CLASSIFIER_MODEL_OPENAI?.trim() || "gpt-4o-mini";
}

interface ParsedClassifierResponse {
  tier: TaskTier;
  estimatedFiles: number;
  estimatedIterations: number;
  confidence: number;
  reasoning?: string;
  archetype: TaskArchetype;
  archetypeConfidence: number;
  /**
   * What the model put in `tier` when it was not a tier. Present only on the
   * degraded path; carried for telemetry, never for behaviour — `tier` and
   * `confidence` already encode the degradation.
   */
  rejectedTier?: string;
}

function parseClassifierResponse(text: string): ParsedClassifierResponse {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  if (!cleaned) {
    throw new Error("empty classifier response");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback: extract the first top-level {...} block (handles leading/trailing prose).
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("no JSON object found in classifier response");
    }
    parsed = JSON.parse(match[0]);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("classifier response is not an object");
  }
  // Tier and archetype are two independent judgements that arrive in one
  // response — the prompt calls them "orthogonal to tier". Parse them that way.
  // Validating tier first and throwing discarded the archetype with it, which is
  // how a run the classifier had correctly called `investigation` reached the
  // agent loop as a `refactor` patch run.
  const tierValid = VALID_TIERS.includes(parsed.tier);
  const rejectedTier = tierValid ? undefined : String(parsed.tier);
  const tier = (tierValid ? parsed.tier : "medium") as TaskTier;

  const estimatedFiles = Math.max(1, Math.floor(Number(parsed.estimatedFiles) || 1));
  const rawArchetype = parsed.archetype;
  const archetypeFieldUsable =
    typeof rawArchetype === "string" && VALID_ARCHETYPES.includes(rawArchetype);
  const archetypeConfidence = Math.min(1, Math.max(0, Number(parsed.archetypeConfidence) || 0));

  // When the model put archetype vocabulary in the tier slot AND the archetype
  // field is itself unusable, that misplaced value is the only archetype signal
  // in the response. Take it rather than defaulting to complex_multi_file, which
  // would answer "read-only" with a patch archetype. It is then subject to the
  // same confidence gate as a correctly-placed archetype (below) — adoption
  // recovers a signal, it does not manufacture confidence in one.
  const adoptedArchetype =
    !tierValid && !archetypeFieldUsable && VALID_ARCHETYPES.includes(String(parsed.tier))
      ? (String(parsed.tier) as TaskArchetype)
      : undefined;

  const archetype: TaskArchetype = archetypeFieldUsable
    ? (rawArchetype as TaskArchetype)
    : (adoptedArchetype ?? "complex_multi_file");

  return {
    tier,
    estimatedFiles,
    estimatedIterations: Math.max(1, Math.floor(Number(parsed.estimatedIterations) || 10)),
    // A tier we could not read is a tier we cannot trust. Zeroing confidence
    // routes it through the existing low-confidence gate instead of inventing a
    // second degradation path, so every downstream consumer treats it exactly as
    // it treated the thrown-away classification before.
    confidence: tierValid ? Math.min(1, Math.max(0, Number(parsed.confidence) || 0)) : 0,
    reasoning:
      typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 200) : undefined,
    archetype,
    archetypeConfidence,
    rejectedTier,
  };
}

// ZONE_FALLBACK_ARCHETYPE (default 'refactor'): archetype to use when the classifier
// times out or errors. 'refactor' yields REFACTOR_PIPELINE (iterCap:12, coachingBudget:4)
// via archetypeDispatcher.ts, and sets pipelineApplied=true which enables the
// soft-promotion gate at agentLoop.ts:3235 (_isPromotable requires pipelineApplied===true).
// The lever is iterCap + promotion gate — NOT multi_edit steering, which is archetype-agnostic
// (agentLoop.ts:426). Requires ZONE_ARCHETYPE_ENABLE_REFACTOR !== "0" (default) for the
// refactor pipeline to resolve; if disabled, dispatcher returns null — same as today.
// Set ZONE_FALLBACK_ARCHETYPE=complex_multi_file to restore legacy behavior exactly.
function getFallbackArchetype(): TaskArchetype {
  const raw = process.env["ZONE_FALLBACK_ARCHETYPE"];
  return (raw && VALID_ARCHETYPES.includes(raw) ? raw : "refactor") as TaskArchetype;
}

function buildFallback(
  model: string,
  costUsd: number,
  startTime: number,
  reason: string
): TaskClassification {
  return {
    tier: "medium",
    estimatedFiles: 5,
    estimatedIterations: 15,
    confidence: 0,
    reasoning: `classifier fallback: ${reason}`,
    classifierCostUsd: costUsd,
    classifierLatencyMs: Date.now() - startTime,
    classifierModel: model,
    fallbackUsed: true,
    archetype: getFallbackArchetype(),
    archetypeConfidence: 0,
  };
}

function computeResponseCost(
  response: unknown,
  provider: LLMProvider,
  fallbackModel: string
): number {
  const usage = extractUsage((response as { usage?: unknown })?.usage);
  if (!usage) return 0;
  const providerName: ProviderName = provider === "anthropic" ? "anthropic" : "openai";
  const responseModel =
    (response as { model?: string })?.model || fallbackModel;
  return totalCost(providerName, responseModel, {
    input_uncached: usage.input_uncached,
    cache_write: usage.cache_write,
    cache_read: usage.cache_read,
    output: usage.output,
  });
}

/**
 * Whether the model ran out of output budget mid-response.
 *
 * Read off the response, never inferred from a parse failure. Truncation and
 * malformed output are different defects with different fixes, and they do not
 * coincide: 6 of 14 measured calls truncated *without* failing to parse, because
 * the JSON happened to precede the prose the model appended. Inferring from a
 * parse failure would have missed every one of those, which is how a 43%
 * truncation rate survived an audit cycle described as "safe with default Haiku".
 *
 * `"length"` is the Chat Completions spelling on both providers — OpenAI emits it
 * natively, and the Anthropic adapter maps `stop_reason:"max_tokens"` onto it
 * (`anthropicAdapter/convertResponse.ts`). The Responses-API shapes are checked
 * too, since this classifier is routed by provider and may meet either.
 */
function wasTruncated(response: unknown): boolean {
  if (typeof response !== "object" || response === null) return false;
  const r = response as Record<string, unknown>;
  const first = Array.isArray(r.choices) ? r.choices[0] : undefined;
  if (first && typeof first === "object") {
    if ((first as Record<string, unknown>).finish_reason === "length") return true;
  }
  if (r.finish_reason === "length") return true;
  const incomplete = r.incomplete_details;
  if (incomplete && typeof incomplete === "object") {
    if ((incomplete as Record<string, unknown>).reason === "max_output_tokens") return true;
  }
  return false;
}

/** Why a classification did not come out of the model intact. */
type ClassifierFallbackReason =
  | "truncated"
  | "invalid_tier"
  | "low_tier_confidence"
  | "error";

interface ClassifierFallbackEvent {
  reason: ClassifierFallbackReason;
  taskHash: string;
  classifierModel: string;
  provider: string;
  /** The field Zone could not use, and what was in it. */
  rejectedField?: string;
  rejectedValue?: string;
  /** The values actually used. Absent when nothing fell back. */
  fellBackTo?: { tier: TaskTier; archetype: TaskArchetype };
  /** Whether the archetype in effect came from the model or from configuration. */
  archetypeSource?: "model" | "fallback";
  /** `truncated` only: whether a usable classification came out anyway. */
  classificationSurvived?: boolean;
  /** `truncated` only: the model's own output. */
  rawResponse?: string;
  impact: string;
}

/**
 * A classification that degraded, on stderr.
 *
 * stdout is wrong for this: the TUI's stdoutShield swallows every `[zone-*]`
 * line, so `log()` here is invisible in the one place a user would see it.
 * stderr survives under ZONE_TUI_DEBUG=1 / ZONE_VERBOSE_LOGS=1, which is the
 * convention `[zone-context-window-fallback]` (`models.ts`) already sets for
 * "your input was not what this code expected".
 *
 * `rawResponse` is carried deliberately. It is a few hundred tokens of the
 * model's own JSON and contains no user code — and it is precisely the evidence
 * that was missing when `invalid tier: investigation` had to be re-derived from
 * a live classifier because the log was gone.
 */
function emitClassifierFallback(event: ClassifierFallbackEvent): void {
  console.warn("[zone-classifier-fallback]", JSON.stringify(event));
}

export async function classifyTask(
  taskDescription: string,
  options: ClassifyTaskOptions = {}
): Promise<TaskClassification> {
  const startTime = Date.now();
  const normalized = String(taskDescription || "").trim();
  const cacheKey = hashTask(normalized);

  if (!options.skipCache && classificationCache.has(cacheKey)) {
    const cached = classificationCache.get(cacheKey)!;
    // Re-run large-file bump against cached result so stale pre-Q.8 entries
    // (or any cache populated before file grew past threshold) get upgraded.
    const targetFiles = options.targetFiles ?? extractFilePaths(normalized);
    const repoRoot = options.repoRoot ?? process.cwd();
    const bumpResult = bumpForLargeFiles(
      cached.tier,
      targetFiles,
      repoRoot,
      options._fileLineCounter
    );
    if (bumpResult.bumpedFile !== undefined && bumpResult.tier !== cached.tier) {
      log("[zone-tier-bumped]", JSON.stringify({
        event: "tier_bumped",
        fromTier: cached.tier,
        toTier: bumpResult.tier,
        filePath: bumpResult.bumpedFile,
        lineCount: bumpResult.bumpedLineCount,
        source: "cache_rerun",
      }));
      const upgraded = { ...cached, tier: bumpResult.tier };
      classificationCache.set(cacheKey, upgraded);
      return upgraded;
    }
    return cached;
  }

  const ctx = getRequestContext();
  const provider = options.provider ?? ctx?.provider ?? "anthropic";
  const model = pickClassifierModel(provider);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let costUsd = 0;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = createLLMClient({ apiKey: options.userApiKey, provider });

    const response = await Promise.race([
      client.createChatCompletion({
        model,
        temperature: 0,
        // gpt-5.x mini / reasoning-style models reject `max_tokens` — they
        // require `max_completion_tokens`. The OpenAI SDK accepts both fields,
        // so prefer the new spelling everywhere this classifier runs.
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: `Task: ${normalized}\n\nClassify this task.` },
        ],
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("classifier timeout")),
          timeoutMs
        );
      }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    costUsd = computeResponseCost(response, provider, model);

    const extraction = extractResponsesApiOutputText(response);
    if (!extraction.ok) {
      throw new Error(`text extraction failed: ${extraction.reason}`);
    }

    const truncated = wasTruncated(response);
    const emitTruncated = (classificationSurvived: boolean): void =>
      emitClassifierFallback({
        reason: "truncated",
        taskHash: cacheKey,
        classifierModel: model,
        provider,
        classificationSurvived,
        rawResponse: extraction.text,
        impact: classificationSurvived
          ? "classifier hit its output cap; this response parsed anyway because the " +
            "JSON preceded the cut, which is luck rather than a property"
          : "classifier hit its output cap and the response was unusable; the run " +
            "falls back to medium tier with no archetype signal",
      });

    let parsed: ParsedClassifierResponse;
    try {
      parsed = parseClassifierResponse(extraction.text);
    } catch (parseErr) {
      if (truncated) emitTruncated(false);
      throw parseErr;
    }
    if (truncated) emitTruncated(true);

    if (parsed.rejectedTier !== undefined) {
      emitClassifierFallback({
        reason: "invalid_tier",
        taskHash: cacheKey,
        classifierModel: model,
        provider,
        rejectedField: "tier",
        rejectedValue: parsed.rejectedTier,
        fellBackTo: { tier: parsed.tier, archetype: parsed.archetype },
        archetypeSource: "model",
        impact:
          "tier degraded to medium with confidence 0; the archetype is unaffected " +
          "and still selects the pipeline",
      });
    }

    // Q.8 large-file trigger: bump simple → medium if any target file exceeds threshold.
    // Applied before the confidence gate so a bumped tier is reflected in the fallback path too.
    const targetFiles = options.targetFiles ?? extractFilePaths(normalized);
    const repoRoot = options.repoRoot ?? process.cwd();
    const bumpResult = bumpForLargeFiles(parsed.tier, targetFiles, repoRoot, options._fileLineCounter);
    if (bumpResult.bumpedFile !== undefined) {
      parsed.tier = bumpResult.tier;
      log("[zone-tier-bumped]", JSON.stringify({
        event: "tier_bumped",
        taskHash: cacheKey,
        fromTier: "simple",
        toTier: "medium",
        reason: "large_file_threshold",
        filePath: bumpResult.bumpedFile,
        lineCount: bumpResult.bumpedLineCount,
        threshold: Number(process.env.ZONE_LARGE_FILE_LOC ?? 2000),
        ts: new Date().toISOString(),
        source: "fresh",
      }));
    }

    if (parsed.archetypeConfidence < CLASSIFIER_CONFIDENCE_THRESHOLD && parsed.archetype !== "complex_multi_file") {
      log(
        "[zone-archetype-low-confidence-fallback]",
        JSON.stringify({
          classifierArchetype: parsed.archetype,
          forcedArchetype: "complex_multi_file",
          archetypeConfidence: parsed.archetypeConfidence,
          threshold: CLASSIFIER_CONFIDENCE_THRESHOLD,
        })
      );
      parsed.archetype = "complex_multi_file";
    }

    if (parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
      const fallback = buildFallback(model, costUsd, startTime, "low confidence");
      // `parsed.confidence` is the confidence in the TIER. It says nothing about
      // the archetype, which the gate above has already vetted on its own
      // confidence. Overwriting it here with ZONE_FALLBACK_ARCHETYPE (default
      // `refactor`) is the same tier/archetype coupling as the parser's, and it
      // fires with no parse error at all: a response reading
      // {archetype:"investigation", archetypeConfidence:0.95, confidence:0.4}
      // became a patch run.
      const archetypePreserved = parsed.archetypeConfidence >= CLASSIFIER_CONFIDENCE_THRESHOLD;
      if (archetypePreserved) {
        fallback.archetype = parsed.archetype;
        fallback.archetypeConfidence = parsed.archetypeConfidence;
      }
      emitClassifierFallback({
        reason: "low_tier_confidence",
        taskHash: cacheKey,
        classifierModel: model,
        provider,
        rejectedField: "confidence",
        rejectedValue: String(parsed.confidence),
        fellBackTo: { tier: fallback.tier, archetype: fallback.archetype },
        archetypeSource: archetypePreserved ? "model" : "fallback",
        impact: archetypePreserved
          ? "tier fell back to medium; the archetype was confident enough to keep"
          : "tier and archetype both fell back; the archetype is ZONE_FALLBACK_ARCHETYPE, " +
            "not a judgement about this task",
      });
      classificationCache.set(cacheKey, fallback);
      if (parsed.tier !== "medium") {
        log(
          "[zone-tier-low-confidence-fallback]",
          JSON.stringify({
            classifierTier: parsed.tier,
            forcedTier: "medium",
            confidence: parsed.confidence,
            threshold: CLASSIFIER_CONFIDENCE_THRESHOLD,
          })
        );
      }
      log(
        "[zone-task-classified]",
        JSON.stringify({
          taskHash: cacheKey,
          tier: fallback.tier,
          confidence: parsed.confidence,
          rawTier: parsed.tier,
          classifierModel: model,
          classifierCostUsd: costUsd,
          classifierLatencyMs: fallback.classifierLatencyMs,
          fallbackUsed: true,
          fallbackReason: "low_confidence",
        })
      );
      return fallback;
    }

    // Listed field by field rather than spread: `parsed` now also carries
    // `rejectedTier`, which is diagnostic and has no place in the classification
    // every downstream consumer reads.
    const classification: TaskClassification = {
      tier: parsed.tier,
      estimatedFiles: parsed.estimatedFiles,
      estimatedIterations: parsed.estimatedIterations,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      archetype: parsed.archetype,
      archetypeConfidence: parsed.archetypeConfidence,
      classifierCostUsd: costUsd,
      classifierLatencyMs: Date.now() - startTime,
      classifierModel: model,
      fallbackUsed: false,
    };

    classificationCache.set(cacheKey, classification);

    log(
      "[zone-task-classified]",
      JSON.stringify({
        taskHash: cacheKey,
        tier: classification.tier,
        estimatedFiles: classification.estimatedFiles,
        estimatedIterations: classification.estimatedIterations,
        confidence: classification.confidence,
        classifierModel: classification.classifierModel,
        classifierCostUsd: classification.classifierCostUsd,
        classifierLatencyMs: classification.classifierLatencyMs,
      })
    );

    return classification;
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const errPayload = formatOpenAiThrownErrorPayload(err);
    const responseData =
      (err as { response?: { data?: unknown } } | undefined)?.response?.data ??
      (err as { error?: unknown } | undefined)?.error;
    log(
      "[zone-task-classifier-failure]",
      JSON.stringify({
        taskHash: cacheKey,
        classifierModel: model,
        provider,
        name: errPayload.name,
        message: errPayload.message,
        status: errPayload.status,
        code: errPayload.code,
        type: errPayload.type,
        responseData:
          responseData === undefined ? undefined : truncateForLog(responseData),
      })
    );
    const fallback = buildFallback(model, costUsd, startTime, errPayload.message);
    emitClassifierFallback({
      reason: "error",
      taskHash: cacheKey,
      classifierModel: model,
      provider,
      rejectedValue: errPayload.message,
      fellBackTo: { tier: fallback.tier, archetype: fallback.archetype },
      archetypeSource: "fallback",
      impact:
        "no classification at all; the archetype is ZONE_FALLBACK_ARCHETYPE and " +
        "carries no signal about this task",
    });
    log(
      "[zone-task-classified]",
      JSON.stringify({
        taskHash: cacheKey,
        tier: fallback.tier,
        confidence: 0,
        classifierModel: model,
        classifierCostUsd: costUsd,
        classifierLatencyMs: fallback.classifierLatencyMs,
        fallbackUsed: true,
        fallbackReason: "error",
      })
    );
    return fallback;
  }
}

export function clearClassificationCache(): void {
  classificationCache.clear();
}
