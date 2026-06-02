import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExecutionPlan } from "../llm/executionPlan.js";
import type { VerifyDiagnostic } from "../core/buildVerifyDiagnostic.js";

const execFileAsync = promisify(execFile);

/**
 * Plan-based write-scope guard (Tur P2-scope).
 *
 * Returns `null` when a write to `filePath` is allowed, or an error message
 * string when it should be blocked. Allowed when:
 *   - No plan provided (chat tasks, plan-failed runs, hosted contexts)
 *   - Plan exists but no step carries `filesLikely` info (graceful fallback)
 *   - `filePath` matches the union of `step.filesLikely` across all steps
 *
 * Path comparison normalizes leading `./` and Windows-style backslashes.
 * Per-step locking is intentionally NOT applied here — the agent may complete
 * steps in any order or merge them, so the union is the right granularity for
 * v1.
 */
export function checkWriteScope(
  filePath: string,
  executionPlan: ExecutionPlan | null | undefined,
  repoPath?: string,
  archetype?: string,
): string | null {
  if (archetype === "refactor" || archetype === "complex_multi_file") {
    return null;
  }

  // Zone's own .zone/ bookkeeping directory is never subject to plan-scope checks.
  // Use path.resolve to handle ".." traversal (e.g. ".zone/../src/evil.ts" must stay blocked).
  {
    const base = repoPath ?? process.cwd();
    const absFile = path.resolve(base, String(filePath ?? ""));
    const absZone = path.resolve(base, ".zone");
    if (absFile === absZone || absFile.startsWith(absZone + path.sep)) return null;
  }

  if (!executionPlan || !Array.isArray(executionPlan.steps) || executionPlan.steps.length === 0) {
    return null;
  }

  const allowedFiles = new Set<string>();
  for (const step of executionPlan.steps) {
    const list = (step as { filesLikely?: unknown }).filesLikely;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const normalized = normalizePath(raw, repoPath);
      if (normalized && normalized !== OUT_OF_REPO_MARKER) allowedFiles.add(normalized);
    }
  }

  if (allowedFiles.size === 0) {
    return null;
  }

  const target = normalizePath(filePath, repoPath);
  if (!target) return null;
  if (target === OUT_OF_REPO_MARKER) {
    return (
      `Write blocked: "${filePath}" resolves outside the repo. ` +
      `Use a path relative to repoPath (e.g., "app/page.tsx").`
    );
  }

  if (allowedFiles.has(target)) return null;

  // TS/JS extension-family tolerance: the plan LLM may list store.ts when the
  // real file is store.tsx (or vice-versa). Accept a write if the target shares
  // the same directory+stem with any allowed file, provided both extensions belong
  // to the TypeScript/JavaScript family. Cross-family paths (.py, .json, etc.)
  // still require exact match.
  const TS_JS_FAMILY = new Set(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]);
  const targetDot = target.lastIndexOf(".");
  if (targetDot !== -1) {
    const targetExt = target.slice(targetDot + 1);
    if (TS_JS_FAMILY.has(targetExt)) {
      const targetStem = target.slice(0, targetDot); // e.g. "src/cli/tui/store"
      for (const allowed of allowedFiles) {
        const aDot = allowed.lastIndexOf(".");
        if (aDot === -1) continue;
        if (TS_JS_FAMILY.has(allowed.slice(aDot + 1)) && allowed.slice(0, aDot) === targetStem) {
          return null;
        }
      }
    }
  }

  const planScope = Array.from(allowedFiles).slice(0, 5).join(", ");
  const more = allowedFiles.size > 5 ? ` (and ${allowedFiles.size - 5} more)` : "";
  return (
    `Write blocked: "${filePath}" is outside the planned scope. ` +
    `The plan covers: ${planScope}${more}. ` +
    `If this file genuinely needs editing, complete the planned work first ` +
    `and the user can request a follow-up.`
  );
}

/**
 * scope-guard-path-bug Tur: normalizePath previously stripped leading "/"
 * unconditionally, so an absolute path like
 *   /home/bedo/zone-landing/app/global-error.tsx
 * (extracted from a build/tsc stack trace) became
 *   home/bedo/zone-landing/app/global-error.tsx
 * — a relative-looking string that polluted the scope set. The agent later
 * matched that bad scope entry, wrote to it, and toolExecutor's path.join
 * produced a doubled-prefix nonsense path on disk.
 *
 * With `repoPath` provided, absolute paths are handled correctly:
 *   - matching the repo prefix → returns the trailing relative form
 *   - equal to repoPath        → returns ""
 *   - outside the repo         → returns the OUT_OF_REPO_MARKER so callers reject
 *
 * Without `repoPath`, legacy behavior is preserved (back-compat for tests
 * and callers that don't care about absolute-path defense).
 */
export const OUT_OF_REPO_MARKER = "__OUT_OF_REPO__";

function normalizePath(p: string, repoPath?: string): string {
  const s = String(p ?? "").replace(/\\/g, "/").trim();
  if (!s) return "";

  if (s.startsWith("/") && repoPath) {
    const repoNorm = String(repoPath).replace(/\\/g, "/").replace(/\/+$/, "");
    if (s === repoNorm) return "";
    if (s.startsWith(repoNorm + "/")) {
      return s.slice(repoNorm.length + 1).replace(/^\.\//, "").trim();
    }
    return OUT_OF_REPO_MARKER;
  }

  return s.replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

export interface ScopeExpansionResult {
  expanded: boolean;
  addedFile: string | null;
  reason: string;
}

/**
 * scope-expansion Tur: evidence-driven widening of the plan's covered file set.
 *
 * When `buildVerifyDiagnostic` extracts a concrete `failingFile` from a real
 * verification failure (build/test stderr, parsed by `parseVerificationError`),
 * append that file to the plan's covered set so the agent's subsequent
 * apply_patch / write_file lands instead of being blocked by `checkWriteScope`.
 *
 * Conservative gates (return early without expanding):
 *   - No plan, or plan with no steps.
 *   - Diagnostic carries no parsed failingFile (parser had no hard evidence).
 *   - Failing file lives in a framework-generated path (.next/, dist/, …).
 *     Generated paths are downstream artefacts; widening to them would mask
 *     real bugs in user source.
 *   - File already in the covered set (no-op, but reported as "already_in_scope").
 *
 * Mutation strategy: the plan is passed by reference from runLlmPatchFlow →
 * runAgentLoop → executeTool. Pushing to `steps[0].filesLikely` widens the
 * union that `checkWriteScope` derives on every call. Orchestrator steps
 * share the same plan reference, so the expansion persists across step
 * boundaries within a run.
 *
 * Bounded growth: one file per call. The agent's self-correction budget
 * (5 attempts) caps the total number of expansions per run.
 */
export function maybeExpandScopeForVerifyDiagnostic(
  executionPlan: ExecutionPlan | null | undefined,
  diagnostic: VerifyDiagnostic,
  repoPath?: string
): ScopeExpansionResult {
  if (!executionPlan || !Array.isArray(executionPlan.steps) || executionPlan.steps.length === 0) {
    return { expanded: false, addedFile: null, reason: "no_plan" };
  }
  const failingFileRaw = diagnostic?.parsed?.failingFile ?? null;
  if (!failingFileRaw) {
    return { expanded: false, addedFile: null, reason: "no_parsed_failing_file" };
  }
  if (diagnostic.generatedPathDetected) {
    return { expanded: false, addedFile: null, reason: "generated_path" };
  }

  const normalized = normalizePath(failingFileRaw, repoPath);
  if (!normalized) {
    return { expanded: false, addedFile: null, reason: "empty_after_normalize" };
  }
  if (normalized === OUT_OF_REPO_MARKER) {
    return { expanded: false, addedFile: null, reason: "outside_repo" };
  }

  const covered = new Set<string>();
  for (const step of executionPlan.steps) {
    const list = (step as { filesLikely?: unknown }).filesLikely;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const n = normalizePath(raw, repoPath);
      if (n && n !== OUT_OF_REPO_MARKER) covered.add(n);
    }
  }
  if (covered.has(normalized)) {
    return { expanded: false, addedFile: null, reason: "already_in_scope" };
  }

  const targetStep = executionPlan.steps[0];
  if (!targetStep) {
    return { expanded: false, addedFile: null, reason: "plan_has_no_steps" };
  }
  if (!Array.isArray(targetStep.filesLikely)) {
    targetStep.filesLikely = [];
  }
  targetStep.filesLikely.push(normalized);

  const errorType = diagnostic.parsed?.errorType ?? "unknown";
  return {
    expanded: true,
    addedFile: normalized,
    reason: `verify_diagnostic_failing_file:${errorType}`,
  };
}

const SYMBOL_STOP = new Set([
  "const", "class", "async", "await", "return", "import", "export",
  "function", "interface", "string", "number", "boolean", "object", "array",
  "refactor", "rename", "across", "codebase", "update", "change", "every",
  "where", "files", "should", "using", "every", "replace", "apply",
]);

function extractPlanSymbols(text: string): string[] {
  const raw = text.match(/\b[A-Za-z][A-Za-z0-9_]{4,}\b/g) ?? [];
  const seen = new Set<string>();
  return raw
    .filter(t => !SYMBOL_STOP.has(t.toLowerCase()) && !seen.has(t) && seen.add(t))
    .slice(0, 10);
}

/**
 * For refactor/complex_multi_file tasks: when a write is scope-blocked, check whether
 * the blocked file actually contains a symbol mentioned in the plan objective. If so,
 * add it to scope (same mutation as maybeExpandScopeForVerifyDiagnostic) so the agent
 * can retry immediately. Fails safe — returns expanded:false on any rg error.
 */
export async function maybeExpandScopeForSymbolMatch(
  executionPlan: ExecutionPlan | null | undefined,
  blockedFilePath: string,
  repoPath: string | undefined,
  archetype: string | undefined,
): Promise<ScopeExpansionResult> {
  if (archetype !== "refactor" && archetype !== "complex_multi_file") {
    return { expanded: false, addedFile: null, reason: "archetype_not_refactor" };
  }
  if (!executionPlan?.steps?.length) {
    return { expanded: false, addedFile: null, reason: "no_plan" };
  }
  const symbols = extractPlanSymbols(
    `${executionPlan.objective} ${executionPlan.scopeSummary}`
  );
  if (symbols.length === 0) {
    return { expanded: false, addedFile: null, reason: "no_symbols_in_plan" };
  }

  const absPath = repoPath ? path.join(repoPath, blockedFilePath) : blockedFilePath;
  const pattern = symbols.join("|");
  try {
    // rg exits 0 (no throw) when a match is found, exits 1 (throws) when no match
    await execFileAsync("rg", ["--quiet", pattern, absPath]);
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 1) {
      return { expanded: false, addedFile: null, reason: "symbol_not_in_file" };
    }
    // rg unavailable or other error — fail safe, do not expand
    return { expanded: false, addedFile: null, reason: "rg_unavailable" };
  }

  const normalized = normalizePath(blockedFilePath, repoPath);
  if (!normalized || normalized === OUT_OF_REPO_MARKER) {
    return { expanded: false, addedFile: null, reason: "path_outside_repo" };
  }
  for (const step of executionPlan.steps) {
    const list = (step as { filesLikely?: unknown }).filesLikely;
    if (Array.isArray(list) && list.map(f => normalizePath(String(f), repoPath)).includes(normalized)) {
      return { expanded: false, addedFile: null, reason: "already_in_scope" };
    }
  }

  const target = executionPlan.steps[0];
  if (!target) return { expanded: false, addedFile: null, reason: "plan_has_no_steps" };
  if (!Array.isArray((target as { filesLikely?: unknown }).filesLikely)) {
    (target as { filesLikely: string[] }).filesLikely = [];
  }
  (target as { filesLikely: string[] }).filesLikely.push(normalized);

  return {
    expanded: true,
    addedFile: normalized,
    reason: `symbol_match:${symbols.slice(0, 3).join(",")}`,
  };
}
