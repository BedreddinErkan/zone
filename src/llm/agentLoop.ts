import {
  extractResponsesApiOutputText,
  getModelName,
} from "./openaiClient.js";
import { createLLMClient } from "./factory.js";
import { getRequestContext, withRequestContext } from "./openaiContext.js";
import { readMemory, formatMemoryForPrompt } from "../memory/projectMemory.js";
import { log, debugLog, errorLog } from "../utils/logger.js";
import { parseVerificationError } from "../core/parseVerificationError.js";
import { sanitizeVerificationEnv, strippedEnvKeys } from "../core/buildEnv.js";
import { buildVerifyDiagnostic } from "../core/buildVerifyDiagnostic.js";
import { maybeExpandScopeForVerifyDiagnostic } from "../tools/scopeGuard.js";
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { ZONE_TOOLS } from "../tools/toolDefinitions.js";
import { resetSubagentCallCount } from "./subagents.js";
import { extractUsage } from "./recordingClient.js";
import {
  buildIterCostUpdate,
  emptyIterCostAccumulator,
  type IterCostAccumulator,
} from "../usage/iterCostMeter.js";
import {
  executeTool,
  withStagingTempFlush,
  type ToolResult,
} from "../tools/toolExecutor.js";
import type { ProjectFramework } from "../repo/detectFramework.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions";

export interface AgentLoopInput {
  task: string;
  repoPath: string;
  runId?: string;
  framework?: ProjectFramework;
  maxIterations?: number; // default: 10
  /**
   * Optional custom max iterations. When set, this is a hard cap: escalation
   * bonus logic is disabled so restricted runtimes stay bounded.
   */
  maxIterationsOverride?: number;
  onProgress?: (msg: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
  onStructuredEvent?: (evt: unknown) => void;
  abortSignal?: AbortSignal;
  /** Optional import-ecosystem context block built by buildImportContextSummary. Injected by runLlmPatchFlow. */
  importContextSummary?: string;
  /**
   * BYOK: user-supplied LLM API key (sent from the browser via X-Zone-LLM-Key header).
   * Takes priority over process.env.OPENAI_API_KEY when present.
   * Never logged â€” only the source ("user" vs "env") is logged.
   */
  userApiKey?: string;
  /** Tur P2-scope: when present, write tools reject paths outside the
   *  union of plan.steps[*].filesLikely. Forwarded into executeTool. */
  executionPlan?: import("./executionPlan.js").ExecutionPlan | null;
  /** agent-persistence Tur: full repo file list, used by buildVerifyDiagnostic
   *  to surface candidate culprits when a build/test failure points to a
   *  framework-generated path. Optional — when missing, the diagnostic still
   *  fires but with no candidate list. */
  repoFilePaths?: string[];
  /** Usage-tracker Tur: who to attribute this run's BYOK token spend to.
   *  Defaults to "local-dev" when missing. Plumbed through runLlmPatchFlow. */
  userId?: string;
  /**
   * Optional tool whitelist. If provided, only tools whose name appears in this
   * set are exposed to the LLM and accepted by the executor. If undefined,
   * defaults to the full ZONE_TOOLS set.
   */
  allowedTools?: ReadonlySet<string>;
  /**
   * Optional subagent metadata reserved for the Task tool follow-up. Setting
   * this does not change behavior beyond allowedTools enforcement.
   */
  subagent?: {
    id: string;
    type: "worker" | "explore" | "verifier";
    parentRunId: string;
  };
  /**
   * Shared staging map owned by a parent agent loop. Subagents write into this
   * map so the top-level parent keeps exclusive flush/discard authority.
   */
  parentStagingFiles?: Map<string, string>;
}

export type VerificationReason =
  | 'tests_passed'
  | 'tests_skipped_no_infra'
  | 'tests_inconclusive'
  | 'tests_failed_unrelated'
  | 'tests_failed_by_patch'
  | 'no_verification_attempted'
  | 'verification_failed_staged'
  | 'no_changes_made';

export interface AgentLoopResult {
  success: boolean;
  summary: string;
  toolCallLog: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>;
  filesModified: string[];
  error?: string;
  patchValidatedByAgent: boolean;
  verificationReason: VerificationReason;
}

const MAX_SELF_CORRECTION_ATTEMPTS = 5;
// agent-loop-stability Tur: bumped 10 → 15. Build-failure investigations need
// more headroom than test-failure ones — first iter for the build, second to
// read the failing file, third to apply the fix, fourth to re-verify; multiply
// for two-bug scenarios. Existing escalation bonus still adds 5 on top for
// apply_patch repeat-failure (max 20).
export const BASE_MAX_ITERATIONS = 15;
export const ESCALATION_BONUS_ITERATIONS = 5;

function getZoneToolName(tool: (typeof ZONE_TOOLS)[number]): string {
  return (
    (tool as { function?: { name?: string }; name?: string }).function?.name ??
    (tool as { name?: string }).name ??
    ""
  );
}

function getToolSortName(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const t = tool as { function?: { name?: unknown }; name?: unknown };
  return typeof t.function?.name === "string"
    ? t.function.name
    : typeof t.name === "string"
      ? t.name
      : "";
}

export function sortToolsForPromptCache<T>(tools: readonly T[]): T[] {
  return Array.from(tools).sort((a, b) =>
    getToolSortName(a).localeCompare(getToolSortName(b))
  );
}

export function buildOpenAIPromptCacheKey(runId: string | undefined): string | undefined {
  const normalized = typeof runId === "string" ? runId.trim() : "";
  if (!normalized) return undefined;
  return `zone-run-${normalized.slice(0, 16)}`.slice(0, 64);
}

export function assembleAgentSystemPrompt(input: {
  agentIntro: string;
  frameworkLines: string[];
  hasFramework: boolean;
  projectMemoryBlock: string;
  importContextSummary?: string;
  baseMaxIterations: number;
  canRunCommand: boolean;
  backgroundCommandBlock: string;
  repoPath: string;
}): string {
  return (
    `${input.agentIntro}\n\n` +
    (input.hasFramework ? `${input.frameworkLines.join("\n")}\n\n` : "") +
    (input.projectMemoryBlock ? `${input.projectMemoryBlock}\n\n` : "") +
    (input.importContextSummary
      ? `RELATED FILES (read-only context for planning â€” call read_file for full content):\n` +
        `This block lists the primary file's import ecosystem. Use it to anticipate what other files might need updating, but do NOT assume contents â€” call read_file when you need to actually edit.\n` +
        input.importContextSummary + `\n` +
        `(End related files context)\n\n`
      : "") +
    `CRITICAL PATCH RULES â€” follow these exactly:\n` +
    `1. To modify an EXISTING file, ALWAYS use apply_patch with --- FIND --- / --- REPLACE --- blocks.\n` +
    `   NEVER use write_file on a file that already exists.\n` +
    `2. write_file is ONLY for creating brand-new files that do not exist yet.\n` +
    `3. When using apply_patch:\n` +
    `   - Read the file first with read_file, then copy the exact lines verbatim into FIND.\n` +
    `   - FIND must match exactly once in the file (include enough context to be unique).\n` +
    `   - REPLACE must contain EVERY line from FIND, plus your additions/changes.\n` +
    `   - If REPLACE has fewer lines than FIND, the patch is INVALID and will be rejected.\n` +
    `   - Keep FIND small (1-5 lines) â€” just the immediate anchor around your insertion point.\n` +
    `4. DO NOT remove or modify any code that the user did not ask to change.\n` +
    `   Preserve every existing line unless deletion was explicitly requested.\n` +
    `5. MINIMUM CHANGE PRINCIPLE â€” REPLACE must be the smallest possible diff:\n` +
    `   - For intent='add': REPLACE = every line from FIND verbatim, then your new line(s) appended.\n` +
    `     CORRECT: FIND has 3 lines â†’ REPLACE has those exact 3 lines + 1 new line = 4 lines total.\n` +
    `     WRONG: REPLACE contains lines that were NOT in FIND (copies of other code in the file).\n` +
    `   - For intent='modify': REPLACE = the edited version of FIND lines only. Do NOT pull in\n` +
    `     surrounding lines that are already in the file.\n` +
    `   - For intent='delete': REPLACE = only the lines you want to keep from FIND (can be empty).\n` +
    `     Use this when removing duplicate or incorrect code.\n` +
    `SCOPE PARAMETER â€” use sparingly, not by default:\n` +
    `- USE scope ONLY when ALL of the following are true:\n` +
    `  1. The FIND string appears multiple times in the file and you need to disambiguate.\n` +
    `  2. The target location is inside a NAMED function or class declaration.\n` +
    `- DO NOT use scope when the FIND string is a unique import statement, top-level export,\n` +
    `  or otherwise appears only once in the file.\n` +
    `- DO NOT use scope for arrow-function consts such as \`const handleClick = () => {}\`.\n` +
    `- DO NOT use scope for default exports like \`export default function Page()\`.\n` +
    `  Default exports register as \`__default__\`, not as the visible function name.\n` +
    `- DO NOT use scope for React components or callbacks whose "name" is just a variable binding.\n` +
    `- When in doubt, OMIT scope. A sufficiently unique FIND string is safer than guessing a symbol.\n\n` +
    `PRE-EXISTING BROKEN FILE â€” when apply_patch returns rejectionReason 'file_already_broken_pre_patch':\n` +
    `- The file had a syntax error BEFORE your patch ran. Your patch did not cause it.\n` +
    `- Do NOT retry the same patch â€” it will fail again.\n` +
    `- Do NOT keep incrementing your iteration count trying the same approach.\n` +
    `- Recovery steps:\n` +
    `  1. Call read_file on the broken file.\n` +
    `  2. Find the syntax error at the line/col shown in the rejection message.\n` +
    `  3. Write ONE apply_patch that fixes the pre-existing syntax error AND makes\n` +
    `     your intended change in the same FIND/REPLACE block.\n` +
    `  4. Pass scope: null â€” scope resolution cannot work on an unparseable file.\n` +
    `  5. After the patch succeeds, verify with run_command (e.g. tsc --noEmit or npm test).\n\n` +
    `TEST FAILURE RULES â€” follow these exactly:\n` +
    `6. When tests fail, DO NOT give up and summarise. Investigate first.\n` +
    `   - Use read_file on the file and line number mentioned in the error.\n` +
    `   - Determine: is the error caused by YOUR recent change, or is it pre-existing?\n` +
    `   - Pre-existing issue: fix it if it is simple and safe; otherwise note it as out-of-scope\n` +
    `     and respond with a summary that includes a warning about the pre-existing issue.\n` +
    `   - Your own mistake: fix it with apply_patch (use intent='modify' to edit lines,\n` +
    `     intent='delete' to remove duplicate/incorrect code), then re-run tests.\n` +
    `7. Only give up if self-correction has been attempted and the issue is too complex to fix\n` +
    `   without expanding the original task scope.\n\n` +
    `WORKFLOW for every patch task:\n` +
    `1. Start with the most likely target file. Use search_in_files to locate it by\n` +
    `   function/class name, then read_file to load the full content before editing.\n` +
    `1b. You do NOT need to re-read a file after a successful apply_patch â€” the patch\n` +
    `    has already been written to disk.\n` +
    `2. search_in_files to locate the target function, class, or code region.\n` +
    `2. read_file to view the full surrounding context before making any change.\n` +
    `3. apply_patch with the correct intent:\n` +
    `   - intent='add'     (default) -- inserting new lines; REPLACE = FIND + additions.\n` +
    `   - intent='modify'  -- editing existing lines; REPLACE = edited version of FIND.\n` +
    `   - intent='delete'  -- removing lines; REPLACE may be shorter than FIND.\n` +
    `   Use write_file ONLY for brand-new files that do not exist yet.\n` +
    `4. run_command to verify (run the test suite if one exists).\n` +
    `5. If tests fail: read_file at the error location, determine cause,\n` +
    `   apply targeted fix with intent='modify' or intent='delete', re-run tests.\n` +
    `6. When all checks pass (or no tests exist), respond with a concise plain-text summary.\n` +
    `Maximum iterations: ${input.baseMaxIterations} (already enforced -- do not stall).\n\n` +
    `OUTPUT ECONOMY:\n` +
    `- Final response: 60-80 words unless an error/warning needs more detail.\n` +
    `- Include changed files, verification result, and any remaining warning.\n` +
    `- Omit tables, decorative markdown, and per-file explanations already visible in the diff.\n` +
    `- Do not recap tool output or command logs unless they explain a failure.\n\n` +
    `TRUNCATED FILE SECTIONS: If you see a ZONE_CONTEXT_TRUNCATED marker in a file,\n` +
    `part of the file was omitted from the initial context to save space.\n` +
    `- DO NOT include the marker line in any apply_patch FIND block.\n` +
    `- Use read_file on the same path to fetch the hidden section (up to 150K chars).\n` +
    `- Only generate FIND blocks from lines you have fully read.\n\n` +
    `FINAL ASSESSMENT (required): When your work is complete, include exactly one of these\n` +
    `tags on its own line in your final response:\n` +
    `  [ZONE_VERIFICATION: tests_passed]           -- suite ran and all tests passed\n` +
    `  [ZONE_VERIFICATION: tests_skipped_no_infra] -- no test script/framework found\n` +
    `  [ZONE_VERIFICATION: tests_inconclusive]     -- infra issue prevented tests (wrong\n` +
    `    command, missing deps, port conflict, ENOENT, etc.) -- patch itself is likely correct\n` +
    `  [ZONE_VERIFICATION: tests_failed_unrelated] -- tests failed but failure is pre-existing,\n` +
    `    not caused by your patch\n` +
    `  [ZONE_VERIFICATION: tests_failed_by_patch]  -- tests failed because of your patch\n` +
    `    (you MUST attempt to fix it before marking complete)\n` +
    `Use tests_inconclusive for: 'missing script', 'command not found', 'ENOENT', port\n` +
    `conflicts, or any environment issue that prevented the suite from running at all.\n` +
    `Use tests_failed_by_patch ONLY when the error clearly points at code you changed.\n\n` +
    (input.hasFramework && input.canRunCommand
      ? `When running commands, use the correct package manager and commands above.\n`
      : "") +
    input.backgroundCommandBlock +
    `Repository path: ${input.repoPath}`
  );
}

export type IterationBudgetState = {
  maxIterationsForRun: number;
  escalationBonusGranted: boolean;
};

export function maybeGrantEscalationBonus(
  state: IterationBudgetState,
  escalatedFileCount: number,
  currentIter: number,
  onProgress: ((msg: string) => void) | undefined,
  baseMaxIterations = BASE_MAX_ITERATIONS
): IterationBudgetState {
  if (state.escalationBonusGranted || escalatedFileCount <= 0) {
    return state;
  }

  const nextState = {
    maxIterationsForRun: baseMaxIterations + ESCALATION_BONUS_ITERATIONS,
    escalationBonusGranted: true,
  };
  onProgress?.(JSON.stringify({
    event: "zone-agent-escalation-bonus-granted",
    newMaxIterations: nextState.maxIterationsForRun,
    escalatedFileCount,
    currentIter,
  }));
  return nextState;
}

function normalizePatchedPath(filePath: string): string {
  return String(filePath || "").replace(/\\/g, "/").trim();
}

// â”€â”€â”€ Self-correction routing (Phase Tier-2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type SelfCorrectTrigger =
  | "test_failed"
  | "apply_patch_find_not_found"
  | "apply_patch_multiple_matches"
  | "apply_patch_semantic_smell"
  | "apply_patch_syntax_broken_post_write"
  | "apply_patch_repeated_failure_same_file"
  | "apply_patch_pre_existing_broken"
  | "apply_patch_scope_not_found"
  | "apply_patch_replace_shorter_than_find"
  | "apply_patch_find_block_empty"
  | "apply_patch_marker_imbalance"
  | "apply_patch_no_read_first"
  | "tool_command_spawn_failure"
  | "tool_path_enoent"
  | "unknown";

const SYNTAX_BROKEN_POST_WRITE_COACHING_PROMPT =
  `Your last apply_patch was applied but it BROKE the file's syntax (parse error reported). The file has been reverted to its pre-patch state.\n\n` +
  `Do NOT submit the same REPLACE block again. The previous REPLACE almost certainly had one of these defects:\n` +
  `- Mismatched braces, parentheses, or brackets\n` +
  `- Missing semicolons, commas, or closing tags\n` +
  `- A truncated function body (you started a block but didn't finish it)\n` +
  `- A REPLACE block that omitted necessary trailing characters from FIND\n\n` +
  `REQUIRED steps before retrying:\n` +
  `1. Call read_file on the target file FIRST. The file has been reverted - re-read it.\n` +
  `2. Manually count braces/parens in your planned REPLACE block before submitting.\n` +
  `3. If your previous REPLACE was the entire function body, consider patching ONLY the changed line(s) instead of rewriting the whole body.\n\n` +
  `Next action: call read_file on the broken file, then produce a corrected apply_patch with a verified syntactically valid REPLACE block (different from the last one).`;

const PRE_EXISTING_BROKEN_COACHING_PROMPT =
  `The file you tried to patch is ALREADY syntactically broken at the reported line - this breakage existed BEFORE your patch. Your patch was rejected because patching a syntactically invalid file is unsafe.\n\n` +
  `Do NOT retry the same patch. The pre-existing breakage must be repaired in the SAME apply_patch as your feature change. A second apply_patch attempt with the same FIND/REPLACE will be rejected for the same reason.\n\n` +
  `REQUIRED steps before retrying:\n` +
  `1. Call read_file on the target file FIRST.\n` +
  `2. Locate the breakage near the reported line number (look 5-10 lines above and below for missing braces, broken JSX, partial function declarations, etc.).\n` +
  `3. Construct ONE apply_patch whose FIND block is large enough to cover BOTH the breakage region AND the area you originally wanted to change, and whose REPLACE block fixes both.\n\n` +
  `Next action: read the file, then submit one combined repair-plus-feature apply_patch.`;

// Provider-agnostic hardening: appended to test_failed and
// apply_patch_syntax_broken_post_write coaching to block three failure modes
// observed in OpenAI gpt-4o smoke runs (run bddcd8d3):
//   1. Comment-out as fix (line preserved with "// " prefix)
//   2. Duplicate imports/declarations in REPLACE blocks
//   3. "Pre-existing/unrelated" verdicts without any investigation
// Sonnet 4.5 already complies with all three rules; the directives are
// imperative-form so they don't regress Sonnet but force OpenAI compliance.
const PROVIDER_AGNOSTIC_HARDENING =
  `\n\n**REMOVING CODE MEANS DELETING IT**\n\n` +
  `If a line of code is causing an error and the fix is to remove it:\n` +
  `- DELETE the line entirely (omit it from REPLACE block)\n` +
  `- DO NOT prefix with "// " — that is not a fix, the line still exists\n` +
  `- "// import X" is preserved code, not removed code\n\n` +
  `CORRECT removal:\n` +
  `  --- FIND ---\n` +
  `  import { Bad } from "y";\n` +
  `  import { Good } from "z";\n` +
  `  --- REPLACE ---\n` +
  `  import { Good } from "z";\n\n` +
  `INCORRECT (comment-out is NOT a fix):\n` +
  `  --- FIND ---\n` +
  `  import { Bad } from "y";\n` +
  `  --- REPLACE ---\n` +
  `  // import { Bad } from "y";\n\n` +
  `**REPLACE ONLY SUBSTITUTES THE FIND BLOCK**\n\n` +
  `Lines BEFORE and AFTER the FIND block stay untouched. Do NOT include them in REPLACE.\n\n` +
  `If FIND is "import A;" and you put "import B;\\nimport A;" in REPLACE:\n` +
  `- The result is duplicate "import A;" in the file (one was already below)\n` +
  `- This causes "Identifier already declared" syntax errors\n\n` +
  `Before constructing REPLACE: re-read the surrounding lines. Only include in REPLACE the new content for the FIND region.\n\n` +
  `**BEFORE CLAIMING ANY ERROR IS PRE-EXISTING OR UNRELATED**\n\n` +
  `You MUST satisfy ALL of the following:\n` +
  `1. Read at least one file that could plausibly be the cause\n` +
  `2. Form a specific hypothesis about why the error occurs\n` +
  `3. Attempt at least one apply_patch implementing that hypothesis\n` +
  `4. Verify whether the patch resolved or worsened the error\n\n` +
  `"I cannot determine the cause" or "this seems unrelated" are NOT acceptable verdicts without evidence of investigation. The verification system will mark unrelated claims without patch attempts as failed assessment.\n\n` +
  `Acceptable verdict reasons after investigation:\n` +
  `- Patch attempted, error resolved → tests_passed\n` +
  `- Patch attempted, new error revealed → continue investigation OR tests_failed_by_patch\n` +
  `- Multiple patch attempts, root cause is architectural → state the architectural finding with specific file/line evidence`;

export type FailureRecord = {
  trigger: SelfCorrectTrigger | string;
  errorLine: number | null;
  patchHash: string;
  iter: number;
};

function parsePatchBlocks(patch: string): Array<{ find: string; replace: string }> {
  const blocks: Array<{ find: string; replace: string }> = [];
  const FIND_MARKER = "--- FIND ---";
  const REPLACE_MARKER = "--- REPLACE ---";
  let remaining = String(patch || "");
  while (remaining.includes(FIND_MARKER)) {
    const findIdx = remaining.indexOf(FIND_MARKER);
    const afterFind = remaining.slice(findIdx + FIND_MARKER.length);
    const repIdx = afterFind.indexOf(REPLACE_MARKER);
    if (repIdx === -1) break;
    const findContent = afterFind.slice(0, repIdx);
    const afterReplace = afterFind.slice(repIdx + REPLACE_MARKER.length);
    const nextFindIdx = afterReplace.indexOf(FIND_MARKER);
    const replaceContent =
      nextFindIdx === -1 ? afterReplace : afterReplace.slice(0, nextFindIdx);
    blocks.push({
      find: findContent.replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
      replace: replaceContent.replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
    });
    remaining = nextFindIdx === -1 ? "" : afterReplace.slice(nextFindIdx);
  }
  return blocks;
}

export function hashPatchBlocks(args: Record<string, unknown> | null | undefined): string {
  const patch = String(args?.patch ?? "");
  const blocks = parsePatchBlocks(patch);
  const concatenated = blocks.length > 0
    ? blocks.map((b) => `${b.find}\n--\n${b.replace}`).join("\n===\n")
    : patch;
  return createHash("sha256").update(concatenated).digest("hex").slice(0, 12);
}

export function extractErrorLine(output: string): number | null {
  const match = String(output || "").match(/\bline\s+(\d+)\b/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function detectRepeatedFailure(
  failureHistory: Map<string, FailureRecord[]>,
  targetFilePath: string | null
): { filePath: string; reason: string } | null {
  if (!targetFilePath) return null;
  const records = failureHistory.get(targetFilePath);
  if (!records || records.length < 2) return null;

  const last = records[records.length - 1]!;
  const prev = records[records.length - 2]!;

  if (last.trigger === prev.trigger && last.patchHash === prev.patchHash) {
    return { filePath: targetFilePath, reason: "identical_patch_retried" };
  }

  if (
    last.trigger === prev.trigger &&
    last.errorLine !== null &&
    last.errorLine === prev.errorLine
  ) {
    return { filePath: targetFilePath, reason: "same_root_cause_different_patch" };
  }

  if (last.trigger === prev.trigger) {
    return { filePath: targetFilePath, reason: "same_trigger_repeated_2x" };
  }

  const sameTriggerCount = records.filter((r) => r.trigger === last.trigger).length;
  if (sameTriggerCount >= 3) {
    return { filePath: targetFilePath, reason: "trigger_repeated_3x" };
  }
  return null;
}

function extractSemanticSmellName(errorPreview: string): string {
  const match = String(errorPreview || "").match(/smell detected was:\s*([a-z_]+)/i);
  return match?.[1]?.toLowerCase() ?? "unknown";
}

function getSemanticSmellSpecificGuidance(smellName: string): string {
  switch (smellName) {
    case "broken_template_expression":
      return "You wrote `$ {expr}` somewhere â€” remove the space, it must be `${expr}`.";
    case "duplicate_jsx_attribute":
      return "The JSX element has the same attribute defined twice. Remove the old attribute when adding the new one.";
    case "duplicate_import_statement":
      return "Two import statements target the same module path. Merge them into one import.";
    case "duplicate_adjacent_jsdoc":
      return "You added two identical /** */ JSDoc blocks back-to-back above the same declaration. Remove the duplicate — keep only one comment.";
    case "inline_style_pseudo_class":
      return "Inline React style does not support pseudo-classes like `:hover`. Use a CSS class instead.";
    default:
      return "Remove the conflicting old code and re-issue the patch with one clean replacement.";
  }
}

/** Classify a tool failure into a coaching trigger. */
export function classifyFailure(
  toolName: string,
  output: string,
  error: string | undefined
): SelfCorrectTrigger {
  const text = `${output ?? ""} ${error ?? ""}`.toLowerCase();
  if (toolName === "apply_patch") {
    if (/no_read_first|haven't read this file yet|haven.t read this file yet/i.test(text)) {
      return "apply_patch_no_read_first";
    }
    if (/marker imbalance|--- find ---.*marker.*but.*--- replace ---.*marker/i.test(text)) {
      return "apply_patch_marker_imbalance";
    }
    // Pre-existing broken file: output says "NOT caused by your patch" or "already syntactically broken".
    // The literal rejectionReason "file_already_broken_pre_patch" is a separate field, not in output text.
    if (/file_already_broken_pre_patch|not caused by your patch|already syntactically broken/i.test(text))
      return "apply_patch_pre_existing_broken";
    if (/semantic_smell_post_write|semantically broken output|smell detected was:/i.test(text))
      return "apply_patch_semantic_smell";
    if (/syntax_broken_post_write|broke file syntax/i.test(text))
      return "apply_patch_syntax_broken_post_write";
    if (/find content not found|find_not_found/i.test(text)) return "apply_patch_find_not_found";
    // "matches K locations ... must be unique" is the actual wording from toolExecutor (find_multiple_matches).
    if (/multiple matches|multi-?match|has \d+ occurrences|matches \d+ locations|must be unique/i.test(text))
      return "apply_patch_multiple_matches";
    if (/scope symbol .* not found|rejected_not_found/i.test(text))
      return "apply_patch_scope_not_found";
    // "REPLACE has N lines but FIND has N lines" â€” the replace-shorter-than-find rejection.
    if (/replace has \d+ lines but find has \d+ lines/i.test(text))
      return "apply_patch_replace_shorter_than_find";
    // "FIND block is empty" â€” the find-block-empty rejection.
    if (/find block is empty/i.test(text))
      return "apply_patch_find_block_empty";
  }
  if (toolName === "run_command") {
    if (/spawn .* enoent/i.test(text)) return "tool_command_spawn_failure";
    if (/missing script|command not found|is not recognized/i.test(text))
      return "tool_command_spawn_failure";
    if (/test_failed|tests? failed|failed assertion|expect\(/i.test(text)) return "test_failed";
    return "test_failed"; // generic command failure during test phase
  }
  if (/enoent.*no such file/i.test(text)) return "tool_path_enoent";
  return "unknown";
}

/** Return a focused, actionable coaching string for the given trigger. */
export function buildCoachingPrompt(
  trigger: SelfCorrectTrigger,
  errorPreview: string,
  _recentToolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }>,
  options?: {
    attemptCount?: number;
    filePath?: string;
    /** agent-persistence Tur: when true, the failing file lives under a
     *  framework-generated path (.next/, dist/, etc.). The coaching
     *  prompt switches to a hard-investigate variant that bans
     *  tests_failed_unrelated and requires reading candidate culprits. */
    generatedPathDetected?: boolean;
    /** Optional parsed failing path, surfaced inside the coaching text
     *  so the agent doesn't have to re-extract it from raw output. */
    parsedFailingFile?: string | null;
  }
): string {
  const attemptCount = options?.attemptCount ?? 2;
  const filePath = options?.filePath ?? "this file";
  switch (trigger) {
    case "apply_patch_no_read_first":
      return (
        "You tried to apply_patch a file you haven't read in this run. " +
        "Call read_file FIRST to see the exact lines, then write apply_patch with FIND " +
        "blocks that match verbatim (whitespace included). Don't guess from prior knowledge of similar projects."
      );
    case "apply_patch_find_not_found":
      return (
        `Your FIND block did not match any content in the file.\n` +
        `Common causes:\n` +
        `- The FIND block contains lines that don't exist verbatim (whitespace, line endings, or content drift).\n` +
        `- You assumed code from memory instead of reading the file fresh.\n` +
        `Re-read the target file with read_file FIRST, then copy the EXACT lines you want to replace into FIND.\n` +
        `If the section you want is large, narrow the FIND block to the smallest unique span (3-5 lines max).\n` +
        `Next action: call read_file on the target file before producing your next apply_patch.`
      );
    case "apply_patch_multiple_matches":
      return (
        `Your FIND block matched multiple locations. apply_patch refuses ambiguous edits.\n` +
        `Solutions, pick one:\n` +
        `1. Add the 'scope' parameter (symbolName + symbolKind) to bound the search to a single function/method/class.\n` +
        `2. Extend the FIND block with surrounding lines until it becomes unique in the file.\n` +
        `Next action: produce a new apply_patch with either scope OR a longer, unique FIND block.`
      );
    case "apply_patch_marker_imbalance":
      return (
        `Your last apply_patch had unbalanced --- FIND --- / --- REPLACE --- markers.\n\n` +
        `Required structure: each \`--- FIND ---\` MUST be followed by exactly one \`--- REPLACE ---\`. ` +
        `For multiple edits in one file, use multiple block pairs.\n\n` +
        `WRONG (one FIND, two REPLACE - what you submitted):\n` +
        `  --- FIND ---\n  <region A>\n  --- REPLACE ---\n  <new A>\n  <new B>\n  --- REPLACE ---\n  <new B alt>\n\n` +
        `RIGHT (two FIND, two REPLACE - multi-block):\n` +
        `  --- FIND ---\n  <region A>\n  --- REPLACE ---\n  <new A>\n  --- FIND ---\n  <region B>\n  --- REPLACE ---\n  <new B>\n\n` +
        `Next action: re-issue apply_patch with balanced markers. If only one edit is needed, use exactly one FIND/REPLACE pair.`
      );
    case "apply_patch_semantic_smell": {
      const smellName = extractSemanticSmellName(errorPreview);
      const smellSpecificGuidance = getSemanticSmellSpecificGuidance(smellName);
      return (
        `Your last apply_patch was applied but it produced semantically broken output. The file has been reverted.\n\n` +
        `The smell detected was: ${smellName}\n` +
        `${smellSpecificGuidance}\n\n` +
        `Common causes:\n` +
        `- Forgot to delete the OLD code when inserting NEW code (resulting in duplicate JSX attributes, duplicate imports, or two function definitions)\n` +
        `- Wrote \${expression} as $ {expression} â€” template expressions cannot have whitespace between $ and {\n` +
        `- Used React inline style with pseudo-classes like :hover â€” these do not work; use a CSS class instead\n\n` +
        `Next action: re-read the target file, then produce a corrected apply_patch that removes the conflicting old code and uses correct syntax.`
      );
    }
    case "apply_patch_syntax_broken_post_write":
      return SYNTAX_BROKEN_POST_WRITE_COACHING_PROMPT + PROVIDER_AGNOSTIC_HARDENING;
      return (
        `Your patch was applied but produced invalid syntax â€” the file was reverted to its pre-patch state.\n` +
        `This means your REPLACE block has a bug: missing brace, semicolon, paren, comma, or malformed statement.\n` +
        `Do NOT just retry the same patch. Re-examine your REPLACE block character by character.\n` +
        `If you're unsure where the syntax broke, narrow the change to the smallest possible REPLACE that still accomplishes the task.\n` +
        `Next action: produce a corrected apply_patch with a verified syntactically valid REPLACE block.`
      );
    case "apply_patch_repeated_failure_same_file":
      return (
        `Tool change required for ONE file: "${filePath}".\n\n` +
        `You've failed ${attemptCount} times on "${filePath}" with the same root cause. ` +
        `apply_patch is now blocked for THIS FILE ONLY. Other files in this task are unaffected - ` +
        `keep using apply_patch for them as normal.\n\n` +
        `For "${filePath}" specifically, switch tools:\n` +
        `1. Call read_file on "${filePath}" to see the current state.\n` +
        `2. Mentally compute the FULL corrected file content (every line, top to bottom).\n` +
        `3. Call write_file with filePath="${filePath}" and content=<the entire corrected file>.\n\n` +
        `write_file replaces the whole file atomically. The validator will still check syntax/semantics, ` +
        `but you don't have to reason about FIND/REPLACE matching, indentation, or surrounding lines.\n\n` +
        `Important - task continuation:\n` +
        `Switching tools for "${filePath}" is a LOCAL fix, not a signal to pause the rest of the task. ` +
        `If your task involves other files (cross-file refactor, multi-file rename, etc.), continue working on ` +
        `those files with apply_patch as you were. Handle "${filePath}" with write_file when you reach it; ` +
        `do not let this escalation reorder the remaining work.\n\n` +
        `Note: write_file is normally restricted, but the shrink-guard has been bypassed for "${filePath}" ` +
        `because of the escalation. Use it for this file.`
      );
    case "apply_patch_pre_existing_broken":
      return PRE_EXISTING_BROKEN_COACHING_PROMPT;
      return (
        `The target file was already syntactically broken BEFORE your patch â€” this is not your fault but you must repair it.\n` +
        `Read the file at the reported error line, identify the breakage, and produce ONE apply_patch whose FIND/REPLACE block:\n` +
        `1. Includes the broken region in FIND.\n` +
        `2. Restores valid syntax in REPLACE while ALSO making your intended change.\n` +
        `Omit 'scope' for this call â€” the AST locator cannot parse a broken file.\n` +
        `Next action: read the file, then submit one combined repair-plus-feature apply_patch.`
      );
    case "apply_patch_scope_not_found":
      return (
        `Your apply_patch failed because the scope symbol you specified does not exist in the file. ` +
        `Common causes:\n` +
        `- The target is inside an arrow-function const (e.g., 'const handler = () => {}'). Scope only finds NAMED declarations.\n` +
        `- The target is inside 'export default function X()'. Default exports register as '__default__', not as 'X'.\n` +
        `- The symbol exists with a different kind (e.g., 'class' vs 'function').\n` +
        `Action: REMOVE the scope parameter and re-issue the patch. If the FIND string is unique in the file, scope is unnecessary. ` +
        `Do not guess another symbol name — that wastes iterations.`
      );
    case "tool_command_spawn_failure":
      return (
        `The shell command failed to spawn. On Windows, common causes:\n` +
        `- Bare 'npm test' may fail if npm is not on PATH for the spawn â€” try chained: 'cd <path> && npm test'.\n` +
        `- Wrong cwd â€” pass the absolute repo path or use 'cd <abs-path> && <command>'.\n` +
        `- Wrong script name â€” open package.json to confirm the actual script ('test' vs 'test:e2e' vs 'test:unit').\n` +
        `- Tools like 'npx playwright test' may need to run in a specific subfolder.\n` +
        `Next action: read package.json to confirm the test script name, then re-run with a chained 'cd <repo-path> && <correct-script>' command.`
      );
    case "tool_path_enoent":
      return (
        `A file path failed with ENOENT. Most common cause in Zone: passing an absolute path got concatenated to the cwd.\n` +
        `Solutions:\n` +
        `- Use a path RELATIVE to the repo root (e.g. 'server/controllers/foo.js' not 'C:\\Users\\...\\foo.js').\n` +
        `- If you must use absolute, double-check the executor isn't prepending cwd.\n` +
        `Next action: re-issue the call with a repo-relative path.`
      );
    case "test_failed":
      if (options?.generatedPathDetected) {
        // agent-persistence Tur: hard investigator path. Generated paths
        // (.next/, dist/, build/, out/, .svelte-kit/, .nuxt/) are NEVER the
        // user's direct fault — they are downstream of user-source bugs.
        // We ban tests_failed_unrelated for this case and require the agent
        // to read candidate culprits before any verdict.
        const failingFileRef = options.parsedFailingFile
          ? `\`${options.parsedFailingFile}\``
          : "the framework-generated path shown in the diagnostic above";
        return (
          `Build/test failed and the failing file is in a framework-generated path ` +
          `(${failingFileRef}). Generated paths are downstream of user-source bugs ` +
          `— the real cause lives in YOUR \`app/\`, \`components/\`, \`lib/\` etc.\n\n` +
          `MANDATORY investigation steps before any verdict:\n` +
          `1. Read at least 2 candidate culprit files from the diagnostic above ` +
          `(layout files, providers, recently-modified user files).\n` +
          `2. Look specifically for: missing \`"use client";\` directive, server/client mismatch, ` +
          `broken imports, hooks called from server components.\n` +
          `3. Form a SPECIFIC hypothesis: which file + which line + what change.\n` +
          `4. Apply the fix via apply_patch (or write_file when prepending a single directive).\n` +
          `5. Re-run the failing command to verify the fix.\n\n` +
          `You MUST NOT emit [ZONE_VERIFICATION: tests_failed_unrelated] in this case. ` +
          `Generated paths are never "unrelated" — they reflect user-source state.\n\n` +
          `Permitted verdicts after investigation:\n` +
          `- [ZONE_VERIFICATION: tests_passed] â€” fix applied and verified.\n` +
          `- [ZONE_VERIFICATION: tests_failed_by_patch] â€” fix attempt didn't resolve it; surface what you tried.\n` +
          `- [ZONE_VERIFICATION: tests_inconclusive] â€” investigated thoroughly but couldn't isolate cause; ` +
          `cite which files you read and what you ruled out.\n\n` +
          `Next action: read the candidate files now, then form a hypothesis.` +
          PROVIDER_AGNOSTIC_HARDENING
        );
      }
      return (
        `Tests reported failure or warnings. Determine: is the failure RELATED to your change, ` +
        `or pre-existing/infrastructure noise (deprecation warnings, missing optional deps, env issues)?\n` +
        `Before claiming unrelated, you MUST cite evidence:\n` +
        `- Quote the failing test file path or assertion location from the output.\n` +
        `- Confirm that file is NOT among the files you modified.\n` +
        `- If you cannot extract a failing file path, do NOT claim unrelated â€” emit ` +
        `[ZONE_VERIFICATION: tests_inconclusive] instead.\n` +
        `Verdict rules:\n` +
        `- Unrelated: emit [ZONE_VERIFICATION: tests_failed_unrelated] AND in the same message ` +
        `state the failing file path and confirm it is not in your edits.\n` +
        `- Related: read the assertion/stack trace pointing to your change and produce a corrective apply_patch.\n` +
        `- Cannot tell: emit [ZONE_VERIFICATION: tests_inconclusive].\n` +
        `Avoid blindly re-running the same test command; that consumes attempts without progress.\n` +
        `Next action: classify with evidence; if related, produce a corrective patch.` +
        PROVIDER_AGNOSTIC_HARDENING
      );
    case "apply_patch_replace_shorter_than_find":
      return (
        `Your REPLACE block has FEWER lines than your FIND block, which apply_patch rejects to protect against accidental deletion.\n` +
        `Rules:\n` +
        `- For intent='modify': REPLACE must contain the FULL edited version of every line in FIND.\n` +
        `- For intent='add': REPLACE = every FIND line verbatim, then your new lines appended.\n` +
        `- For intent='delete': REPLACE may be shorter (or empty), but you must set intent='delete'.\n` +
        `Next action: re-read the file, reconstruct the FIND block, and ensure REPLACE has at least as many lines as FIND.`
      );
    case "apply_patch_find_block_empty":
      return (
        `Your FIND block is empty â€” apply_patch requires at least one line in FIND to locate the insertion point.\n` +
        `If you want to append to a file, use FIND to anchor on the last existing line and REPLACE to include it plus your additions.\n` +
        `Next action: re-read the file and add a non-empty FIND anchor around where you want to make changes.`
      );
    case "unknown":
    default:
      return (
        `Something went wrong but the failure mode wasn't recognized automatically.\n` +
        `Re-read the most recent tool error carefully. If the error says "not found", it is likely a path or naming issue. ` +
        `If it mentions syntax, check your REPLACE blocks. If it mentions multiple matches, narrow your FIND.\n` +
        `Next action: do not repeat the previous attempt verbatim â€” change ONE specific thing; keep any note concise.`
      );
  }
}

/** Chat Completions API: `response.choices[0].message.tool_calls`. */
function extractFunctionCallItems(
  response: unknown
): ChatCompletionMessageFunctionToolCall[] {
  const choices = (response as { choices?: unknown[] } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const message = (choices[0] as { message?: { tool_calls?: unknown[] } } | null)
    ?.message;
  const toolCalls = message?.tool_calls;
  if (!Array.isArray(toolCalls)) return [];
  const calls: ChatCompletionMessageFunctionToolCall[] = [];
  for (const item of toolCalls) {
    const t = item as Partial<ChatCompletionMessageFunctionToolCall> | null;
    if (
      t &&
      t.type === "function" &&
      typeof t.id === "string" &&
      t.function &&
      typeof t.function.name === "string" &&
      typeof t.function.arguments === "string"
    ) {
      calls.push(item as ChatCompletionMessageFunctionToolCall);
    }
  }
  return calls;
}

/** Parse a [ZONE_VERIFICATION: <reason>] tag from text. */
function parseVerificationTag(text: string): VerificationReason | null {
  const m = String(text || "").match(/\[ZONE_VERIFICATION:\s*([\w_]+)\]/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const valid: VerificationReason[] = [
    'tests_passed', 'tests_skipped_no_infra', 'tests_inconclusive',
    'tests_failed_unrelated', 'tests_failed_by_patch', 'no_verification_attempted',
    'verification_failed_staged',
    'no_changes_made',
  ];
  return (valid as string[]).includes(raw) ? (raw as VerificationReason) : null;
}

/** Remove any [ZONE_VERIFICATION: <reason>] tag (and the whitespace/newlines around it) from text. */
export function stripVerificationTag(text: string): string {
  return String(text || "")
    .replace(/\s*\[ZONE_VERIFICATION:\s*[\w_]+\]\s*/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function didApplyPatch(
  log: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>
): boolean {
  return log.some(
    (e) =>
      (e.tool === "apply_patch" || e.tool === "write_file") &&
      !String(e.result || "").toLowerCase().includes("error") &&
      !String(e.result || "").toLowerCase().includes("not found") &&
      !String(e.result || "").toLowerCase().includes("fail")
  );
}

/** Check whether the agent has read or written this file earlier in the current run.
 * A subsequent successful apply_patch/write_file on the same file does NOT invalidate
 * the read — the agent emitted that change so the context is still fresh. */
function wasFileReadOrWritten(
  log: Array<{ tool: string; args: Record<string, unknown>; success?: boolean }>,
  filePath: string
): boolean {
  const target = String(filePath || "").trim();
  if (!target) return false;
  for (const entry of log) {
    const entryPath =
      typeof entry.args?.filePath === "string"
        ? String(entry.args.filePath)
        : null;
    if (entryPath !== target) continue;
    if (entry.tool === "read_file" && entry.success !== false) return true;
    if (entry.tool === "write_file" && entry.success !== false) return true;
    if (entry.tool === "apply_patch" && entry.success === true) return true;
  }
  return false;
}

export function applyNoInfraVerificationOverride(input: {
  verificationReason: VerificationReason;
  framework?: { hasTests: boolean; testFilesDetected: boolean };
  patchApplied: boolean;
  triggeredBy: "natural_completion" | "max_iterations";
}): VerificationReason {
  if (
    input.framework &&
    !input.framework.hasTests &&
    input.patchApplied &&
    (input.verificationReason === "tests_inconclusive" ||
      input.verificationReason === "no_verification_attempted")
  ) {
    debugLog("[zone-agent-no-infra-override]", JSON.stringify({
      triggeredBy: input.triggeredBy,
      originalVerdict: input.verificationReason,
      overriddenTo: "tests_skipped_no_infra",
      reason: "framework has no runnable tests; downgraded inconclusive/no-verification to skipped",
      hasTests: false,
      testFilesDetected: input.framework.testFilesDetected,
      patchApplied: true,
    }));
    return "tests_skipped_no_infra";
  }

  return input.verificationReason;
}

const execAsync_verify = promisify(exec);

export function selectVerificationCommand(
  framework: { language?: string; testCommand?: string } | undefined
): { command: string; timeoutMs: number; label: string } | null {
  if (!framework) return null;
  if (framework.language === "typescript") {
    return { command: "npx tsc --noEmit", timeoutMs: 60000, label: "tsc" };
  }
  if (framework.language === "javascript" && framework.testCommand) {
    return { command: framework.testCommand, timeoutMs: 90000, label: "test" };
  }
  return null;
}

export async function runStagingVerification(input: {
  stagingFiles: Map<string, string>;
  repoPath: string;
  framework: { language?: string; testCommand?: string } | undefined;
  withStagingTempFlush: <T>(
    staging: Map<string, string>,
    body: () => Promise<T>
  ) => Promise<T>;
}): Promise<
  | { status: "pass"; label: string; durationMs: number }
  | { status: "fail"; label: string; durationMs: number; errorPreview: string }
  | { status: "skipped"; reason: string }
> {
  if (input.stagingFiles.size === 0) {
    return { status: "skipped", reason: "no_staged_files" };
  }
  const choice = selectVerificationCommand(input.framework);
  if (!choice) {
    return { status: "skipped", reason: "no_command_for_framework" };
  }

  const start = Date.now();
  try {
    const result = await input.withStagingTempFlush(input.stagingFiles, async () => {
      return await execAsync_verify(choice.command, {
        cwd: input.repoPath,
        timeout: choice.timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: sanitizeVerificationEnv(),
      });
    });
    void result;
    console.log(
      `[zone-verify] cmd="${choice.command.slice(0, 80)}" cwd="${input.repoPath}" exitCode=0 stripped_env_keys=${JSON.stringify(strippedEnvKeys())}`
    );
    return { status: "pass", label: choice.label, durationMs: Date.now() - start };
  } catch (err) {
    const code = Number((err as { code?: unknown }).code);
    const exitCode = Number.isFinite(code) ? code : 1;
    console.log(
      `[zone-verify] cmd="${choice.command.slice(0, 80)}" cwd="${input.repoPath}" exitCode=${exitCode} stripped_env_keys=${JSON.stringify(strippedEnvKeys())}`
    );
    const stdout = String((err as { stdout?: unknown }).stdout ?? "");
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    const combined = (stdout + "\n" + stderr).trim();
    const preview = combined.split("\n").slice(0, 30).join("\n").slice(0, 2000);
    return {
      status: "fail",
      label: choice.label,
      durationMs: Date.now() - start,
      errorPreview: preview || String((err as Error).message ?? err),
    };
  }
}

export async function finalizeStaging(input: {
  stagingFiles: Map<string, string>;
  repoPath: string;
  framework: { language?: string; testCommand?: string } | undefined;
  withStagingTempFlush: <T>(
    staging: Map<string, string>,
    body: () => Promise<T>
  ) => Promise<T>;
}): Promise<{
  flushed: boolean;
  verification:
    | { status: "pass"; label: string; durationMs: number }
    | { status: "fail"; label: string; durationMs: number; errorPreview: string }
    | { status: "skipped"; reason: string };
  filesFlushed: number;
  flushFailures: number;
}> {
  const verification = await runStagingVerification({
    stagingFiles: input.stagingFiles,
    repoPath: input.repoPath,
    framework: input.framework,
    withStagingTempFlush: input.withStagingTempFlush,
  });

  debugLog("[zone-staging-verification]", JSON.stringify({
    status: verification.status,
    label: "label" in verification ? verification.label : null,
    durationMs: "durationMs" in verification ? verification.durationMs : null,
    reason: "reason" in verification ? verification.reason : null,
    errorPreviewLen:
      verification.status === "fail" ? verification.errorPreview.length : 0,
  }));

  if (verification.status === "fail") {
    const discardedCount = input.stagingFiles.size;
    input.stagingFiles.clear();
    debugLog("[zone-staging-discard]", JSON.stringify({
      reason: "verification_failed",
      discardedCount,
    }));
    return { flushed: false, verification, filesFlushed: 0, flushFailures: 0 };
  }

  let allUnchanged = true;
  let comparedCount = 0;
  for (const [abs, content] of input.stagingFiles) {
    comparedCount++;
    let diskContent: string | null = null;
    try {
      diskContent = fs.readFileSync(abs, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        diskContent = null;
        allUnchanged = false;
        break;
      }
      allUnchanged = false;
      break;
    }
    if (diskContent !== content) {
      allUnchanged = false;
      break;
    }
  }

  if (allUnchanged && comparedCount > 0) {
    debugLog("[zone-staging-noop]", JSON.stringify({
      stagedCount: input.stagingFiles.size,
      comparedCount,
    }));
    return {
      flushed: false,
      verification: { status: "skipped", reason: "no_changes_made" },
      filesFlushed: 0,
      flushFailures: 0,
    };
  }

  // staging-flush-bug Tur: filesFlushed previously incremented immediately
  // after fs.writeFileSync regardless of whether disk actually persisted the
  // content. The smoke for run 71133d8f saw [zone-staging-flush] report 2
  // files written but on-disk mtime was unchanged — the log was lying. The
  // counter now reflects VERIFIED writes (re-read disk content matches
  // staging). Per-file [zone-staging-flush-write] logs surface mtime
  // before/after and content-match status to catch any future regression.
  let filesFlushed = 0;
  let flushFailures = 0;
  for (const [abs, content] of input.stagingFiles) {
    let mtimeBefore: number | null = null;
    try {
      mtimeBefore = fs.statSync(abs).mtimeMs;
    } catch {
      mtimeBefore = null;
    }
    try {
      fs.writeFileSync(abs, content, "utf8");
      let mtimeAfter: number | null = null;
      try {
        mtimeAfter = fs.statSync(abs).mtimeMs;
      } catch {
        mtimeAfter = null;
      }
      let diskContentMatches = false;
      try {
        diskContentMatches = fs.readFileSync(abs, "utf8") === content;
      } catch {
        diskContentMatches = false;
      }
      debugLog("[zone-staging-flush-write]", JSON.stringify({
        filePath: abs,
        bytesWritten: content.length,
        mtimeBefore,
        mtimeAfter,
        changed: mtimeBefore !== mtimeAfter,
        diskContentMatches,
      }));
      if (diskContentMatches) {
        filesFlushed++;
      } else {
        flushFailures++;
        errorLog("[zone-staging-flush-error]", {
          filePath: abs,
          error: "post_write_content_mismatch",
          bytesExpected: content.length,
        });
      }
    } catch (err) {
      flushFailures++;
      errorLog("[zone-staging-flush-error]", {
        filePath: abs,
        error: String((err as Error).message ?? err),
      });
    }
  }
  // Final integrity sweep: re-read all files at the moment we emit the
  // [zone-staging-flush] log. If a downstream restore overwrites any of our
  // writes between the per-file write and this point, postFlushMismatches
  // will be > 0 and surface the bug visibly.
  let postFlushMismatches = 0;
  for (const [abs, content] of input.stagingFiles) {
    try {
      if (fs.readFileSync(abs, "utf8") !== content) postFlushMismatches++;
    } catch {
      postFlushMismatches++;
    }
  }
  debugLog("[zone-staging-flush]", JSON.stringify({
    filesFlushed,
    failures: flushFailures,
    totalStaged: input.stagingFiles.size,
    postFlushMismatches,
  }));
  return { flushed: true, verification, filesFlushed, flushFailures };
}

/** Infer verification reason from the tool call log when the agent gave no tag. */
export function inferVerificationFromLog(
  log: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>,
  framework?: { hasTests: boolean; testFilesDetected: boolean }
): VerificationReason {
  const patchApplied = didApplyPatch(log);
  if (framework && !framework.hasTests && patchApplied) {
    debugLog("[zone-agent-no-infra-verdict]", JSON.stringify({
      reason: "tests_skipped_no_infra",
      hasTests: false,
      testFilesDetected: framework.testFilesDetected,
      patchApplied: true,
    }));
    return "tests_skipped_no_infra";
  }
  const hasInfraError = log.some(
    (e) =>
      e.tool === "run_command" &&
      /spawn.*enoent|enoent.*cmd\.exe|missing script|command not found|cannot find/i.test(
        String(e.result || "")
      )
  );
  const testsRan = log.some(
    (e) => e.tool === "run_command" && /\bpassed\b|\b\d+ pass/i.test(String(e.result || ""))
  );
  if (patchApplied && testsRan) return "tests_passed";
  if (patchApplied && hasInfraError) return "tests_inconclusive";
  if (!patchApplied) return "tests_failed_by_patch";
  return "no_verification_attempted";
}

export function validateUnrelatedClaim(input: {
  log: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>;
  patchedFilePaths: string[];
  framework?: { hasTests: boolean };
}): { accept: boolean; demoteTo?: VerificationReason; reason: string } {
  const noInfraDemote: VerificationReason =
    input.framework && !input.framework.hasTests
      ? "tests_skipped_no_infra"
      : "tests_inconclusive";
  const anyRunCommand = input.log.some((entry) => entry.tool === "run_command");
  const looksLikePassingRunCommand = (output: string): boolean => {
    const text = String(output || "");
    return (
      /\ball tests passed\b/i.test(text) ||
      /\b0 failed\b/i.test(text) ||
      /\b\d+\s+passed\b.*\b0\s+failed\b/i.test(text)
    );
  };
  const isRunCommandFailure = (entry: {
    tool: string;
    result: string;
    success?: boolean;
  }): boolean => {
    if (entry.tool !== "run_command") return false;
    return entry.success === false;
  };
  const failingRunCommand = [...input.log]
    .reverse()
    .find(
      (entry) =>
        isRunCommandFailure(entry) &&
        !looksLikePassingRunCommand(String(entry.result || ""))
    );

  // Bug 44: stale-failure resolution check.
  // If a failing run_command was followed by a successful run_command,
  // the failure was resolved by a subsequent patch+retry. The agent's
  // `tests_failed_unrelated` claim might still be technically wrong (the
  // failure was related to their patch path), but it should not be demoted
  // to `tests_failed_by_patch` because the file is no longer failing.
  // This handles the canonical "agent encountered a build error, fixed it,
  // re-ran build, build passed" sequence.
  if (failingRunCommand) {
    const failingIdx = input.log.indexOf(failingRunCommand);
    const succeededAfter = input.log.slice(failingIdx + 1).some(
      (entry) => entry.tool === "run_command" && entry.success === true
    );
    if (succeededAfter) {
      return {
        accept: true,
        reason:
          "failing run_command was resolved by a later successful run_command — verification effectively passed",
      };
    }
  }

  if (!anyRunCommand) {
    return {
      accept: false,
      demoteTo: noInfraDemote,
      reason:
        "no run_command in log â€” agent claimed test failure without ever running tests",
    };
  }

  if (!failingRunCommand) {
    return {
      accept: true,
      reason:
        "run_command(s) executed but none look like failure â€” accepting agent classification",
    };
  }

  const verificationError = parseVerificationError(
    String(failingRunCommand.result || ""),
    input.patchedFilePaths
  );
  const failingOutput = String(failingRunCommand.result || "");
  const normalizedPatched = input.patchedFilePaths.map(normalizePatchedPath);
  const failingFile = normalizePatchedPath(verificationError.failingFile ?? "");
  const failingFileIsPatched =
    !!failingFile &&
    normalizedPatched.some(
      (patchedFilePath) =>
        patchedFilePath === failingFile || failingFile.endsWith(patchedFilePath)
    );

  if (verificationError.isPreExisting === true) {
    return {
      accept: true,
      reason: "parser confirms pre-existing/tooling",
    };
  }

  if (
    !failingFile &&
    /npm warn|deprecated|warning:/i.test(failingOutput) &&
    !/command failed:/i.test(failingOutput)
  ) {
    return {
      accept: true,
      reason: "warning-only output without a failing file path is treated as tooling noise",
    };
  }

  if (failingFileIsPatched) {
    return {
      accept: false,
      demoteTo: "tests_failed_by_patch",
      reason:
        "failing file is in patchedFilePaths â€” agent's unrelated claim rejected",
    };
  }

  if (failingFile) {
    return {
      accept: true,
      reason: "parser extracted failing file outside patchedFilePaths",
    };
  }

  return {
    accept: false,
    demoteTo: noInfraDemote,
    reason:
      "cannot verify unrelated claim â€” no failing file extracted or evidence ambiguous",
  };
}

export function validatePassedClaim(
  toolCallLog: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>,
  framework?: { hasTests: boolean }
): { accept: boolean; demoteTo?: VerificationReason; reason: string } {
  const noInfraDemote: VerificationReason =
    framework && !framework.hasTests
      ? "tests_skipped_no_infra"
      : "tests_inconclusive";
  const runCommands = toolCallLog.filter((entry) => entry.tool === "run_command");

  if (runCommands.length === 0) {
    return {
      accept: false,
      demoteTo: framework && !framework.hasTests
        ? "tests_skipped_no_infra"
        : "no_verification_attempted",
      reason: "agent claimed tests passed without ever running tests",
    };
  }

  const hasSuccessPattern = runCommands.some((entry) => {
    const output = String(entry.result || "");
    return (
      /\b\d+\s+pass(?:ed|ing)\b/i.test(output) ||
      /\bTests:\s+.*passed/i.test(output) ||
      /\bOK\s*\(\d+\s+tests?\)/i.test(output) ||
      /(?:✓|✔)\s+\d+\s+tests?\s+passed/i.test(output) ||
      /===\s+\d+\s+passed/i.test(output) ||
      /All tests passed/i.test(output)
    );
  });

  if (!hasSuccessPattern) {
    const anyFailed = runCommands.some((entry) => entry.success === false);
    if (anyFailed) {
      return {
        accept: false,
        demoteTo: noInfraDemote,
        reason:
          "agent claimed passed but at least one run_command failed and no success pattern matched",
      };
    }

    return {
      accept: false,
      demoteTo: noInfraDemote,
      reason:
        "agent claimed passed but no test-success pattern detected in any run_command output",
    };
  }

  return {
    accept: true,
    reason: "test success pattern detected in run_command output",
  };
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const scopedContext: Parameters<typeof withRequestContext>[0] = {};
  if (typeof input.userId === "string" && input.userId.trim()) {
    scopedContext.userId = input.userId.trim();
  }
  if (typeof input.runId === "string" && input.runId.trim()) {
    scopedContext.runId = input.runId.trim();
  }
  if (input.subagent) {
    scopedContext.subagentId = input.subagent.id;
    scopedContext.subagentType = input.subagent.type;
    scopedContext.parentRunId = input.subagent.parentRunId;
  }
  try {
    return await withRequestContext(scopedContext, () => runAgentLoopScoped(input));
  } finally {
    if (!input.subagent && input.runId) {
      resetSubagentCallCount(input.runId);
    }
  }
}

async function runAgentLoopScoped(input: AgentLoopInput): Promise<AgentLoopResult> {
  const baseMaxIterations =
    typeof input.maxIterationsOverride === "number"
      ? input.maxIterationsOverride
      : typeof input.maxIterations === "number"
        ? input.maxIterations
        : BASE_MAX_ITERATIONS;
  const escalationEnabled = typeof input.maxIterationsOverride !== "number";
  let iterationBudget: IterationBudgetState = {
    maxIterationsForRun: baseMaxIterations,
    escalationBonusGranted: false,
  };
  const toolsForLLM = sortToolsForPromptCache(
    input.allowedTools
      ? ZONE_TOOLS.filter((t) => input.allowedTools!.has(getZoneToolName(t)))
      : ZONE_TOOLS
  );
  if (input.allowedTools && toolsForLLM.length === 0) {
    throw new Error("AgentLoopInput.allowedTools resolved to zero tools — aborting.");
  }
  const toolCallLog: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }> = [];
  const filesModified = new Set<string>();
  let selfCorrectionAttempts = 0;
  const failureHistory = new Map<string, FailureRecord[]>();
  const escalatedFiles = new Set<string>();
  // Tur 1: in-memory staging. Writes go here instead of disk during the loop;
  // reads fall back to staging first, disk second. Top-level loops own flushing;
  // subagents share the parent map and must not flush independently.
  // run_command stays disk-bound — it sees the OLD disk state until flush. (Tur 2)
  const ownsStagingFiles = input.parentStagingFiles === undefined;
  const stagingFiles = input.parentStagingFiles ?? new Map<string, string>();

  // Diagnostic: confirm agent loop entry and tool inventory
  debugLog("[zone-agent-loop-entry]", JSON.stringify({
    task: input.task.slice(0, 200),
    repoPath: input.repoPath,
    maxIterations: iterationBudget.maxIterationsForRun,
    toolsAvailable: toolsForLLM.map(
      (t) => getZoneToolName(t) || "unknown"
    ),
    hasRunId: !!(input.runId && input.runId.trim()),
  }));

  const fw = input.framework;
  const fwLines: string[] = fw
    ? [
        `## Project framework`,
        `- Framework: ${fw.framework} (${fw.language})`,
        `- Package manager: ${fw.packageManager}`,
        `- Build command: ${fw.buildCommand || "none"}`,
        `- Dev command: ${fw.devCommand || "none"}`,
        `- Test command: ${fw.testCommand || "none"}`,
        `- Test framework: ${fw.testFramework}`,
        `- Has runnable tests: ${fw.hasTests}`,
        `- Test files detected: ${fw.testFilesDetected}`,
      ]
    : [];
  if (fw) {
    if (fw.hasTests && fw.testFilesDetected) {
      fwLines.push(
        ``,
        `**Test execution policy:**`,
        `- Use exactly: \`${fw.testCommand}\``,
        `- Do not substitute alternative test commands. If this command fails, investigate the failure - do not try other runners.`
      );
    } else if (fw.hasTests && !fw.testFilesDetected) {
      fwLines.push(
        ``,
        `**Test execution policy:**`,
        `- Runner is installed (${fw.testFramework}) but no test files were detected.`,
        `- Use exactly: \`${fw.testCommand}\` if you need to verify.`,
        `- Do not invent test commands.`
      );
    } else if (!fw.hasTests && fw.testFilesDetected) {
      fwLines.push(
        ``,
        `**Test execution policy:**`,
        `- Test files exist but no runner is installed. Report this as a finding in the verdict.`,
        `- Do NOT attempt to run tests. Do NOT install a runner.`,
        `- Verification: disk-write inspection + ${fw.buildCommand ? `\`${fw.buildCommand}\`` : "build skipped (no build command)"}.`
      );
    } else {
      fwLines.push(
        ``,
        `**Test execution policy:**`,
        `- This repository has no test infrastructure (no runner, no test files).`,
        `- Do NOT attempt \`npm test\`, \`npm run test\`, \`eslint\`, or any test/lint command as a verification proxy. Lint is not test.`,
        `- Verification: disk-write inspection + ${fw.buildCommand ? `\`${fw.buildCommand}\`` : "build skipped (no build command)"}.`
      );
    }

    if (fw.subProjects?.length) {
      fwLines.push(``, `- Sub-projects: ${fw.subProjects.map((s) => s.framework).join(", ")}`);
    }
  }
  // Project memory: <repo>/.zone/memory.md, populated via the update_memory tool.
  // Best-effort read — a missing/corrupt file just returns no entries.
  let projectMemoryBlock = "";
  try {
    const memoryEntries = await readMemory(input.repoPath);
    projectMemoryBlock = formatMemoryForPrompt(memoryEntries);
    if (memoryEntries.length > 0) {
      debugLog(
        `[zone-memory] injected ${memoryEntries.length} entries into agent system prompt`
      );
    }
  } catch (err) {
    debugLog("[zone-memory] read failed", err);
  }

  const subagentKind = input.subagent?.type;
  const agentIntro =
    subagentKind === "explore"
      ? `You are an EXPLORE subagent in Zone. Your job is to INVESTIGATE and REPORT — not to make changes.\n\n` +
        `You have been given a read-only investigation task by a parent agent. Find the relevant code,\n` +
        `understand it, and return a compact findings summary so the parent can act on it without\n` +
        `reading every file themselves.\n\n` +
        `Constraints:\n` +
        `- READ-ONLY. You have access to read_file, list_files, search_in_files, find_references only.\n` +
        `- You CANNOT modify files, run commands, delegate further, or update memory.\n` +
        `- Keep findings concise: file:line + one-sentence note per entry. Do NOT dump raw file contents.\n` +
        `- Iteration budget is limited (8 iterations). Be targeted — search first, read selectively.\n` +
        `- If the task requires modifications, return STATUS: failed with an explanation in SUMMARY.\n\n` +
        `When you have finished investigating, respond with the following structured block as your\n` +
        `final message — and nothing else:\n\n` +
        `FINDINGS:\n` +
        `- <path>:<line> — <one-sentence relevance note>\n` +
        `- <path>:<line> — <one-sentence relevance note>\n` +
        `(repeat for each finding; omit line number if not applicable)\n\n` +
        `SUMMARY: <2-4 sentences explaining what you found and why it matters>\n` +
        `STATUS: <completed | partial | failed>`
      : subagentKind === "worker"
        ? `You are a Worker subagent in Zone. You have been delegated a single,\n` +
          `specific subtask by a parent agent. Your job is to complete this subtask\n` +
          `efficiently and return a structured summary.\n\n` +
          `Constraints:\n` +
          `- You have a restricted tool set. Only use the tools available to you.\n` +
          `- You CANNOT delegate further (no nested subagents).\n` +
          `- You CANNOT update project memory or run shell commands.\n` +
          `- Stay focused on the delegated subtask. Do not expand scope.\n` +
          `- Iteration budget is limited (12 iterations). Be decisive.\n\n` +
          `When the subtask is done (or you determine it cannot be completed), respond\n` +
          `with the following structured summary as your final message — and nothing else:\n\n` +
          `SUMMARY: <one short paragraph, 2-4 sentences>\n` +
          `FILES_MODIFIED: <comma-separated relative paths, or "none">\n` +
          `STATUS: <success | failed | partial>\n` +
          `NOTES: <optional; one sentence only if there are caveats>\n\n` +
          `Do not include any other text after the structured summary block.`
        : `You are Zone, an AI code agent${fw?.framework ? ` working on a ${fw.framework} project` : ""}.`;
  const canRunCommand = toolsForLLM.some((t) => getZoneToolName(t) === "run_command");
  const backgroundCommandBlock = canRunCommand
    ? `\n## Background commands\n` +
      `For long-running commands (dev servers, watchers, anything that doesn't exit on its own), use \`run_command_background\` instead of \`run_command\`. ` +
      `This returns a handle immediately so you can keep working. Read the output later with \`read_background_output\` (passing the previous \`new_offset\` to get only new bytes). ` +
      `Kill with \`kill_background\` when done — processes are also auto-killed when the run ends.\n\n` +
      `Heuristic:\n` +
      `- Long-lived (npm run dev, vite, next dev, pytest --watch, tail -f) → \`run_command_background\`\n` +
      `- One-shot (npm run build, npm test, eslint, tsc --noEmit) → \`run_command\`\n\n` +
      `Poll sparingly. Calling \`read_background_output\` every iteration wastes tokens. Read once after a few iterations of other work, or right before you need the result.\n\n` +
      `Example:\n` +
      `1. \`run_command_background\` → handle "bg_a3k7q2"\n` +
      `2. read_file / apply_patch / etc. (a few iterations)\n` +
      `3. \`read_background_output { handle: "bg_a3k7q2", since_offset: null, max_bytes: 4096 }\`\n` +
      `4. If output looks done → \`kill_background\`. Else iterate.\n\n`
    : "";

  const systemContent = assembleAgentSystemPrompt({
    agentIntro,
    frameworkLines: fwLines,
    hasFramework: !!fw,
    projectMemoryBlock,
    importContextSummary: input.importContextSummary,
    baseMaxIterations,
    canRunCommand,
    backgroundCommandBlock,
    repoPath: input.repoPath,
  });

  // Chat Completions messages (system + user kickoff).
  const responseInput: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: systemContent,
    },
    {
      role: "user",
      content: input.task,
    },
  ];

  const client = createLLMClient({ apiKey: input.userApiKey });
  const requestCtx = getRequestContext();
  let iterCostAccumulator: IterCostAccumulator = emptyIterCostAccumulator();
  // Usage recording is centralized in RecordingLLMClient (src/llm/recordingClient.ts):
  // every chat completion across the codebase appends one JSONL record. agentLoop
  // used to accumulate-then-record-on-exit, but that double-counted with the wrapper
  // and missed every other LLM call site (planner, intent, final report, etc.).

  const throwIfAborted = (stage: string): void => {
    if (input.abortSignal?.aborted) {
      debugLog("[zone-agent-aborted]", {
        runId: input.runId,
        stage,
        timestamp: new Date().toISOString(),
      });
      throw new DOMException("Run aborted", "AbortError");
    }
  };

  for (let iter = 0; iter < iterationBudget.maxIterationsForRun; iter += 1) {
    debugLog("[zone-agent-iter-start]", {
      runId: input.runId,
      iter,
      abortSignal: !!input.abortSignal,
      abortAlready: input.abortSignal?.aborted ?? false,
      timestamp: new Date().toISOString(),
    });
    throwIfAborted("iter_start");
    input.onProgress?.(
      `[agent_loop] Iteration ${iter + 1}/${iterationBudget.maxIterationsForRun}`
    );

    debugLog("[zone-agent-llm-pre]", {
      runId: input.runId,
      iter,
      abortAlready: input.abortSignal?.aborted ?? false,
    });
    const promptCacheKey =
      client.provider === "openai" ? buildOpenAIPromptCacheKey(input.runId) : undefined;
    const modelName = getModelName("high", client.provider, requestCtx?.modelOverride);
    const response = await client.createChatCompletion(
      {
        model: modelName,
        messages: responseInput,
        tools: toolsForLLM,
        tool_choice: "auto",
        ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
      },
      { signal: input.abortSignal }
    );
    debugLog("[zone-agent-llm-post]", {
      runId: input.runId,
      iter,
      abortAlready: input.abortSignal?.aborted ?? false,
    });
    try {
      const usage = extractUsage((response as { usage?: unknown }).usage);
      const runId = typeof input.runId === "string" ? input.runId.trim() : "";
      if (usage && runId) {
        const update = buildIterCostUpdate({
          runId,
          iter: iter + 1,
          totalIter: iterationBudget.maxIterationsForRun,
          provider: client.provider,
          model: response.model || modelName,
          current: usage,
          previous: iterCostAccumulator,
        });
        iterCostAccumulator = update.accumulator;
        input.onStructuredEvent?.(update.payload);
      }
    } catch (err) {
      debugLog("[zone-iter-cost-update-failed]", err);
    }
    // Persistence happens in RecordingLLMClient — this block is debug-only.
    try {
      const u = (response as { usage?: Record<string, unknown> }).usage;
      const promptTokenDetails =
        u?.prompt_tokens_details && typeof u.prompt_tokens_details === "object"
          ? (u.prompt_tokens_details as Record<string, unknown>)
          : null;
      const write = Number(u?.cache_creation_input_tokens ?? 0) || 0;
      const read = Number(promptTokenDetails?.cached_tokens ?? u?.cache_read_input_tokens ?? 0) || 0;
      const input = Number(u?.prompt_tokens ?? 0) || 0;
      const output = Number(u?.completion_tokens ?? u?.output_tokens ?? 0) || 0;
      if (write > 0 || read > 0) {
        const ratio = read + write > 0 ? (read / (read + write + input)).toFixed(2) : "0.00";
        debugLog(
          `[zone-cache] iter=${iter + 1} write=${write} read=${read} input_uncached=${input} output=${output} hit_ratio=${ratio}`
        );
      }
    } catch {}
    throwIfAborted("after_llm");

    const toolCalls = extractFunctionCallItems(response);
    if (toolCalls.length > 0) {
      // Push the assistant message with all tool_calls ONCE before processing them.
      // Chat-completions protocol requires the assistant message with tool_calls to
      // precede every role:"tool" message that references those call ids.
      const assistantContent = response.choices[0]?.message?.content ?? null;
      responseInput.push({
        role: "assistant",
        content: assistantContent,
        tool_calls: toolCalls,
      });
      let failureDetected = false;
      let failedToolName = "";
      let failedToolOutput = "";
      let failedToolError = "";
      let failedToolFilePath: string | null = null;
      const failedFilesThisIter = new Set<string>();

      for (const call of toolCalls) {
        const name = call.function.name;
        const callId = call.id;
        const argsString = call.function.arguments ?? "";
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = argsString
            ? (JSON.parse(argsString) as Record<string, unknown>)
            : {};
        } catch {
          parsedArgs = {};
        }

        input.onToolCall?.(name, parsedArgs);

        // Diagnostic: log every tool call before execution
        debugLog("[zone-agent-tool-call]", JSON.stringify({
          iter: iter + 1,
          tool: name,
          filePath: parsedArgs.filePath ?? null,
          patchPreview:
            typeof parsedArgs.patch === "string"
              ? parsedArgs.patch.slice(0, 400)
              : null,
          contentLength:
            typeof parsedArgs.content === "string"
              ? parsedArgs.content.length
              : null,
          command: parsedArgs.command ?? null,
        }));

        if (name === "apply_patch") {
          const targetFilePath =
            typeof parsedArgs.filePath === "string" ? parsedArgs.filePath : null;
          if (targetFilePath && !wasFileReadOrWritten(toolCallLog, targetFilePath)) {
            debugLog("[zone-apply-patch-no-read-first]", JSON.stringify({
              filePath: targetFilePath,
              iter: iter + 1,
              blocked: true,
            }));
            const syntheticOutput =
              `Block 1: You haven't read this file yet in this run. ` +
              `Call read_file on ${targetFilePath} first to see the exact current content, ` +
              `then issue apply_patch with FIND lines that match the file verbatim.`;
            toolCallLog.push({
              tool: name,
              args: parsedArgs,
              result: syntheticOutput,
              success: false,
            });
            // Chat Completions protocol: assistant tool_call already pushed above.
            // Each tool_call needs exactly one matching role:"tool" reply.
            responseInput.push({
              role: "tool",
              tool_call_id: callId,
              content: syntheticOutput,
            });
            failureDetected = true;
            failedToolName = name;
            failedToolOutput = syntheticOutput;
            failedToolError = "apply_patch_no_read_first";
            failedToolFilePath = targetFilePath;
            // Mirror the same failure tracking that real apply_patch failures get.
            // Without this, backup sweep / repeat detection never sees the blocked file
            // and the agent can drift to other files without returning.
            failedFilesThisIter.add(targetFilePath);
            const noReadTrigger = classifyFailure(
              name,
              syntheticOutput,
              "apply_patch_no_read_first"
            );
            const noReadPatchHash = hashPatchBlocks(parsedArgs);
            const noReadList = failureHistory.get(targetFilePath) ?? [];
            noReadList.push({
              trigger: noReadTrigger,
              errorLine: null,
              patchHash: noReadPatchHash,
              iter: iter + 1,
            });
            failureHistory.set(targetFilePath, noReadList);
            continue;
          }
        }

        const rid = String(input.runId || "").trim();
        debugLog("[zone-agent-tool-pre]", {
          runId: input.runId,
          iter,
          tool: name,
          abortAlready: input.abortSignal?.aborted ?? false,
        });
        throwIfAborted("before_tool");
        const result = await executeTool(name, parsedArgs, input.repoPath, input.onProgress, {
          runId: rid || undefined,
          onApprovalRequired: async (command, runId) => {
            const { requestCommandApproval } = await import("../api/commandApprovals.js");
            const approval = await requestCommandApproval({
              runId,
              command,
              emit: (evt) => input.onStructuredEvent?.(evt),
              abortSignal: input.abortSignal,
            });
            return !!approval.approved;
          },
          escalatedFiles,
          allowWriteFileOverwritePaths: escalatedFiles,
          stagingFiles,
          abortSignal: input.abortSignal,
          executionPlan: input.executionPlan ?? null,
          allowedTools: input.allowedTools,
          userId: input.userId,
          framework: input.framework,
          subagent: input.subagent,
          onToolCall: input.onToolCall,
          onToolResult: input.onToolResult,
          onStructuredEvent: input.onStructuredEvent,
        });
        debugLog("[zone-agent-tool-post]", {
          runId: input.runId,
          iter,
          tool: name,
          abortAlready: input.abortSignal?.aborted ?? false,
        });
        throwIfAborted("after_tool");
        input.onToolResult?.(name, result);

        // Diagnostic: log every tool result after execution
        debugLog("[zone-agent-tool-result]", JSON.stringify({
          iter: iter + 1,
          tool: name,
          success: result.success,
          outputPreview: result.output.slice(0, 300),
          error: result.error ?? null,
        }));

        // Detect failures from any tool â€” feeds coaching-prompt router.
        // All tools: failure iff result.success === false (exit code for run_command,
        // explicit success bool for others). Output-content heuristics removed â€”
        // they produced false positives on passing Next.js builds whose stderr
        // contains tokens like "_global-error" or "FAIL".
        const toolFailed = !result.success;
        if (toolFailed) {
          failureDetected = true;
          failedToolName = name;
          failedToolOutput = result.output;
          failedToolError = result.error ?? "";
          failedToolFilePath =
            typeof parsedArgs.filePath === "string" ? parsedArgs.filePath : null;
        }

        toolCallLog.push({
          tool: name,
          args: parsedArgs,
          result: result.output.slice(0, 4000),
          success: result.success,
        });

        if (name === "apply_patch" && !result.success) {
          const parsedFilePath =
            typeof parsedArgs.filePath === "string" ? parsedArgs.filePath : null;
          if (parsedFilePath) failedFilesThisIter.add(parsedFilePath);
          const filePath = parsedFilePath ?? "unknown";
          const classifiedTrigger = classifyFailure(name, result.output, result.error);
          const trigger =
            classifiedTrigger === "apply_patch_semantic_smell"
              ? extractSemanticSmellName(result.output)
              : classifiedTrigger;
          const errorLine = extractErrorLine(result.output);
          const patchHash = hashPatchBlocks(parsedArgs);
          const list = failureHistory.get(filePath) ?? [];
          list.push({ trigger, errorLine, patchHash, iter: iter + 1 });
          failureHistory.set(filePath, list);
        }

        if (
          (name === "write_file" || name === "apply_patch") &&
          parsedArgs.filePath != null
        ) {
          filesModified.add(String(parsedArgs.filePath));
        }
        if (name === "Task" && result.success) {
          try {
            const parsed = JSON.parse(result.output) as { filesModified?: unknown };
            if (Array.isArray(parsed.filesModified)) {
              for (const filePath of parsed.filesModified) {
                if (typeof filePath === "string" && filePath.trim()) {
                  filesModified.add(filePath.trim());
                }
              }
            }
          } catch {
            // Best-effort only. Task summaries are user-visible tool content,
            // but modified-file aggregation should not make the loop fail.
          }
        }

        // Chat Completions: each tool_call gets one matching role:"tool" reply.
        // The assistant message with tool_calls was pushed before the loop.
        responseInput.push({
          role: "tool",
          tool_call_id: callId,
          content: result.output,
        });
      }

      // â”€â”€ Self-correction: failure detected â†’ route to coaching prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Each self-correction attempt consumes one iteration toward maxIterations.
      // The selfCorrectionAttempts counter is a SUBSET of total iterations â€”
      // it limits how many times we inject coaching, not how many total iterations run.
      // This way a long but successful run won't hit the coaching budget.
      let repeatPattern: { filePath: string; reason: string } | null = null;
      if (failureDetected && failedToolName === "apply_patch") {
        repeatPattern = detectRepeatedFailure(failureHistory, failedToolFilePath);
        if (!repeatPattern) {
          for (const filePath of failedFilesThisIter) {
            if (filePath === failedToolFilePath) continue;
            const candidate = detectRepeatedFailure(failureHistory, filePath);
            if (candidate) {
              repeatPattern = candidate;
              break;
            }
          }
        }
      }
      const failedFilePath = failedToolName === "apply_patch" ? failedToolFilePath : null;
      const pickedFromBackupSweep =
        repeatPattern !== null && repeatPattern.filePath !== failedToolFilePath;
      if (failureDetected && selfCorrectionAttempts < MAX_SELF_CORRECTION_ATTEMPTS) {
        selfCorrectionAttempts += 1;
        let routedTrigger: SelfCorrectTrigger;
        if (repeatPattern) {
          routedTrigger = "apply_patch_repeated_failure_same_file";
          escalatedFiles.add(repeatPattern.filePath);
          input.onProgress?.(JSON.stringify({
            event: "zone-agent-repeat-detected",
            filePath: repeatPattern.filePath,
            reason: repeatPattern.reason,
            attempts: failureHistory.get(repeatPattern.filePath)?.length ?? 0,
          }));
          if (escalationEnabled) {
            iterationBudget = maybeGrantEscalationBonus(
              iterationBudget,
              escalatedFiles.size,
              iter,
              input.onProgress,
              baseMaxIterations
            );
          }
        } else {
          routedTrigger = classifyFailure(failedToolName, failedToolOutput, failedToolError);
        }
        const routedFilePath = repeatPattern?.filePath ?? failedFilePath;
        const perFileAttempt = routedFilePath
          ? failureHistory.get(routedFilePath)?.length ?? 0
          : 0;
        // agent-persistence Tur: build a structured diagnostic prelude
        // (parsed failingFile/line/errorType + generated-path indicator +
        // candidate culprits) and inject it ABOVE the coaching directives.
        // Generated-path detection also flips the test_failed coaching into
        // its mandatory-investigation variant inside buildCoachingPrompt.
        const diagnostic = buildVerifyDiagnostic({
          failedToolOutput,
          filesModified: Array.from(filesModified),
          filesInRepo: Array.isArray(input.repoFilePaths) ? input.repoFilePaths : [],
          framework: input.framework
            ? { framework: input.framework.framework, language: input.framework.language }
            : null,
          attemptCount: selfCorrectionAttempts,
        });
        // scope-expansion Tur: when the diagnostic parser pinned a concrete
        // user-source failing file, expand the plan's covered set so the
        // agent's next apply_patch can land. Mutates plan in-place; persists
        // for the rest of this run (and across orchestrator step boundaries
        // because the plan reference is shared).
        const scopeExpansion = maybeExpandScopeForVerifyDiagnostic(
          input.executionPlan ?? null,
          diagnostic,
          input.repoPath
        );
        let diagnosticText = diagnostic.text;
        if (scopeExpansion.expanded && scopeExpansion.addedFile) {
          diagnosticText +=
            `\n\n**Scope expanded**: \`${scopeExpansion.addedFile}\` has been added to the writable scope ` +
            `for this run because the verification parser pinned it as the failing file. Apply your patch directly.`;
          debugLog("[zone-scope-expanded]", JSON.stringify({
            runId: input.runId ?? null,
            addedFile: scopeExpansion.addedFile,
            reason: scopeExpansion.reason,
            parsedFailingFile: diagnostic.parsed?.failingFile ?? null,
            parsedErrorType: diagnostic.parsed?.errorType ?? null,
            attempt: selfCorrectionAttempts,
          }));
        }
        const coachingText = buildCoachingPrompt(
          routedTrigger,
          failedToolOutput,
          toolCallLog,
          {
            attemptCount: perFileAttempt || selfCorrectionAttempts,
            filePath: routedFilePath ?? undefined,
            generatedPathDetected: diagnostic.generatedPathDetected,
            parsedFailingFile: diagnostic.parsed?.failingFile ?? null,
          }
        );
        const remaining = MAX_SELF_CORRECTION_ATTEMPTS - selfCorrectionAttempts;
        debugLog("[zone-agent-self-correct]", JSON.stringify({
          iter: iter + 1,
          trigger: failedToolName === "run_command" ? "test_failed" : failedToolName,
          routedTrigger,
          selfCorrectionAttempt: selfCorrectionAttempts,
          maxAttempts: MAX_SELF_CORRECTION_ATTEMPTS,
          filePath: routedFilePath,
          perFileAttempt,
          detectedRepeatedFailure: repeatPattern !== null,
          repeatReason: repeatPattern?.reason ?? null,
          iterationCap: iterationBudget.maxIterationsForRun,
          failedFilesThisIterCount: failedFilesThisIter.size,
          pickedFromBackupSweep,
          errorPreview: failedToolOutput.slice(0, 200),
          willRetry: true,
          reason: "routed_coaching_prompt_injected",
        }));
        debugLog("[zone-agent-diagnostic]", JSON.stringify({
          attempt: selfCorrectionAttempts,
          failingFile: diagnostic.parsed?.failingFile ?? null,
          failingLine: diagnostic.parsed?.failingLine ?? null,
          errorType: diagnostic.parsed?.errorType ?? null,
          generatedPathDetected: diagnostic.generatedPathDetected,
          candidateCount: diagnostic.candidates.length,
          candidatesPreview: diagnostic.candidates.slice(0, 5),
        }));
        input.onProgress?.(
          `[agent_loop] Failure detected (${routedTrigger}) â€” self-correction attempt ${selfCorrectionAttempts}/${MAX_SELF_CORRECTION_ATTEMPTS}`
        );
        responseInput.push({
          role: "user",
          content:
            `[Zone coaching â€” attempt ${selfCorrectionAttempts} of ${MAX_SELF_CORRECTION_ATTEMPTS}]\n` +
            diagnosticText + `\n\n` +
            coachingText +
            `\n\nRecent failure context:\n` +
            `- Tool: ${failedToolName}\n` +
            `- Error preview (first 300 chars): ${failedToolOutput.slice(0, 300)}\n` +
            `You have ${remaining} retry attempt${remaining === 1 ? "" : "s"} remaining. ` +
            `After that the run will halt with the current state.`,
        });
      } else if (failureDetected) {
        // Budget exhausted â€” log and let the model produce its final summary naturally.
        const routedTrigger = repeatPattern
          ? "apply_patch_repeated_failure_same_file"
          : classifyFailure(failedToolName, failedToolOutput, failedToolError);
        const routedFilePath = repeatPattern?.filePath ?? failedFilePath;
        const perFileAttempt = routedFilePath
          ? failureHistory.get(routedFilePath)?.length ?? 0
          : 0;
        debugLog("[zone-agent-self-correct]", JSON.stringify({
          iter: iter + 1,
          trigger: failedToolName === "run_command" ? "test_failed" : failedToolName,
          routedTrigger,
          selfCorrectionAttempt: selfCorrectionAttempts,
          maxAttempts: MAX_SELF_CORRECTION_ATTEMPTS,
          filePath: routedFilePath,
          perFileAttempt,
          detectedRepeatedFailure: repeatPattern !== null,
          repeatReason: repeatPattern?.reason ?? null,
          iterationCap: iterationBudget.maxIterationsForRun,
          failedFilesThisIterCount: failedFilesThisIter.size,
          pickedFromBackupSweep,
          errorPreview: failedToolOutput.slice(0, 200),
          willRetry: false,
          reason: "self-correction budget exhausted â€” allowing model to summarise",
        }));
      }

      continue;
    }

    const extracted = extractResponsesApiOutputText(response);
    if (extracted.ok && extracted.text.trim()) {
      const finalText = extracted.text.trim();
      const vrMatch = finalText.match(/\[ZONE_VERIFICATION:\s*([\w_]+)\]/i);
      const vrRaw = vrMatch ? vrMatch[1].toLowerCase() : 'no_verification_attempted';
      const validReasons: VerificationReason[] = [
        'tests_passed', 'tests_skipped_no_infra', 'tests_inconclusive',
        'tests_failed_unrelated', 'tests_failed_by_patch', 'no_verification_attempted',
        'verification_failed_staged',
        'no_changes_made',
      ];
      let verificationReason: VerificationReason =
        (validReasons as string[]).includes(vrRaw)
          ? (vrRaw as VerificationReason)
          : 'no_verification_attempted';
      if (verificationReason === "tests_passed") {
        const passedValidation = validatePassedClaim(
          toolCallLog,
          input.framework ? { hasTests: input.framework.hasTests } : undefined
        );
        if (!passedValidation.accept) {
          verificationReason = passedValidation.demoteTo ?? "tests_inconclusive";
          input.onProgress?.(JSON.stringify({
            event: "zone-agent-verdict-override",
            triggeredBy: "natural_completion",
            originalVerdict: "tests_passed",
            overriddenTo: verificationReason,
            reason: passedValidation.reason,
          }));
          debugLog("[zone-agent-verdict-override]", JSON.stringify({
            triggeredBy: "natural_completion",
            originalVerdict: "tests_passed",
            overriddenTo: verificationReason,
            reason: passedValidation.reason,
          }));
        }
      }
      if (verificationReason === "tests_failed_unrelated") {
        const verdictValidation = validateUnrelatedClaim({
          log: toolCallLog,
          patchedFilePaths: Array.from(filesModified),
          framework: input.framework
            ? { hasTests: input.framework.hasTests }
            : undefined,
        });
        if (!verdictValidation.accept) {
          verificationReason = verdictValidation.demoteTo ?? "tests_inconclusive";
          debugLog("[zone-agent-verdict-override]", JSON.stringify({
            triggeredBy: "natural_completion",
            originalVerdict: "tests_failed_unrelated",
            overriddenTo: verdictValidation.demoteTo,
            reason: verdictValidation.reason,
          }));
        } else if (
          verdictValidation.reason &&
          /resolved by a later successful run_command/i.test(verdictValidation.reason)
        ) {
          // Bug 44b: failure was demonstrably resolved by a later successful
          // run_command. Promote the verdict from `tests_failed_unrelated` to
          // `tests_passed` so the UI doesn't render a "tests failed" chip
          // alongside a "safe to apply" badge.
          verificationReason = "tests_passed";
          debugLog("[zone-agent-verdict-promote]", JSON.stringify({
            triggeredBy: "natural_completion",
            originalVerdict: "tests_failed_unrelated",
            promotedTo: "tests_passed",
            reason: verdictValidation.reason,
          }));
        }
      }
      verificationReason = applyNoInfraVerificationOverride({
        verificationReason,
        framework: input.framework
          ? {
              hasTests: input.framework.hasTests,
              testFilesDetected: input.framework.testFilesDetected,
            }
          : undefined,
        patchApplied: didApplyPatch(toolCallLog),
        triggeredBy: "natural_completion",
      });
      let patchValidatedByAgent =
        verificationReason === 'tests_passed' ||
        verificationReason === 'tests_skipped_no_infra' ||
        verificationReason === 'tests_failed_unrelated';
      debugLog("[zone-staging-state]", JSON.stringify({
        stagedFileCount: stagingFiles.size,
        stagedFiles: Array.from(stagingFiles.keys()).map((abs) => path.basename(abs)),
        // staging-flush-bug diag: full absolute paths surface symlink/realpath drift
        stagedAbsPaths: Array.from(stagingFiles.keys()),
      }));
      log("[zone-agent-final-assessment]", JSON.stringify({
        triggeredBy: "natural_completion",
        verificationReason,
        patchValidatedByAgent,
        inferredFrom: vrMatch ? "tag" : "heuristic",
        summaryPreview: finalText.slice(0, 200),
      }));
      const finalizeResult = ownsStagingFiles
        ? await finalizeStaging({
            stagingFiles,
            repoPath: input.repoPath,
            framework: input.framework,
            withStagingTempFlush,
          })
        : {
            flushed: false,
            verification: {
              status: "skipped" as const,
              reason: "subagent_deferred_to_parent",
            },
            filesFlushed: 0,
            flushFailures: 0,
          };
      let summaryAppendix = "";
      if (finalizeResult.verification.status === "fail") {
        verificationReason = "verification_failed_staged";
        patchValidatedByAgent = false;
        summaryAppendix =
          "\n\n**Verification failed (" + finalizeResult.verification.label +
          ", " + finalizeResult.verification.durationMs + "ms).** " +
          "Changes were NOT applied to disk.\n\n```\n" +
          finalizeResult.verification.errorPreview +
          "\n```";
      } else if (
        finalizeResult.verification.status === "skipped" &&
        "reason" in finalizeResult.verification &&
        finalizeResult.verification.reason === "no_changes_made"
      ) {
        verificationReason = "no_changes_made";
        patchValidatedByAgent = false;
      }
      return {
        success: true,
        summary: finalText + summaryAppendix,
        toolCallLog,
        filesModified: Array.from(filesModified),
        patchValidatedByAgent,
        verificationReason,
      };
    }

    // If we got neither tool calls nor text, keep looping (rare).
  }

  // Max iterations hit â€” request one final no-tool assessment call
  input.onProgress?.("[agent_loop] Max iterations reached â€” requesting final assessment");
  let finalVerificationReason: VerificationReason = inferVerificationFromLog(
    toolCallLog,
    input.framework
      ? {
          hasTests: input.framework.hasTests,
          testFilesDetected: input.framework.testFilesDetected,
        }
      : undefined
  );
  let inferredFrom: "tag" | "heuristic" = "heuristic";
  let finalSummary = "Max iterations reached";
  const grantedBonus = iterationBudget.escalationBonusGranted
    ? ` (including ${ESCALATION_BONUS_ITERATIONS} bonus iterations granted after escalation)`
    : "";
  const fwHint = (() => {
    const fw = input.framework;
    if (!fw) return "";
    if (!fw.hasTests) {
      return (
        `\n\nThis project has NO runnable test infrastructure ` +
        `(testCommand: "${fw.testCommand || "none"}", testFramework: "${fw.testFramework}"). ` +
        `If your patch was applied successfully, the correct verdict is ` +
        `[ZONE_VERIFICATION: tests_skipped_no_infra]. ` +
        `Do NOT use tests_inconclusive - there was no test attempt to be inconclusive about. ` +
        `Do NOT use no_verification_attempted - skipping is the correct behavior here.`
      );
    }
    return "";
  })();
  try {
    const assessmentResponse = await client.createChatCompletion({
      model: getModelName("high", client.provider, requestCtx?.modelOverride),
      messages: [
        ...responseInput,
        {
          role: "user",
          content:
            `You have reached the maximum number of iterations${grantedBonus}. ` +
            // P3: output reduction - cap the fallback assessment summary too.
            "Provide a 60-80 word final summary and include exactly one " +
            "[ZONE_VERIFICATION: <reason>] tag. " +
            "Do not use tables or recap details already visible in the diff. " +
            "Choose: tests_passed, tests_skipped_no_infra, tests_inconclusive, " +
            "tests_failed_unrelated, tests_failed_by_patch, or no_verification_attempted. " +
            "Use tests_inconclusive if tests failed due to environment issues " +
            "(spawn errors, ENOENT, missing script, missing deps). " +
            "Use tests_failed_by_patch ONLY if your patch caused the failure." +
            fwHint,
        },
      ],
    }, { signal: input.abortSignal });
    const ae = extractResponsesApiOutputText(assessmentResponse);
      if (ae.ok && ae.text.trim()) {
        finalSummary = ae.text.trim();
        const tagged = parseVerificationTag(finalSummary);
        if (tagged) {
          // Strip the tag from the text so downstream consumers (CLI, web UI) don't display it.
          finalSummary = stripVerificationTag(finalSummary);
          finalVerificationReason = tagged;
          inferredFrom = "tag";
          if (finalVerificationReason === "tests_passed") {
            const passedValidation = validatePassedClaim(
              toolCallLog,
              input.framework ? { hasTests: input.framework.hasTests } : undefined
            );
            if (!passedValidation.accept) {
              finalVerificationReason =
                passedValidation.demoteTo ?? "tests_inconclusive";
              input.onProgress?.(JSON.stringify({
                event: "zone-agent-verdict-override",
                triggeredBy: "max_iterations",
                originalVerdict: "tests_passed",
                overriddenTo: finalVerificationReason,
                reason: passedValidation.reason,
              }));
              debugLog("[zone-agent-verdict-override]", JSON.stringify({
                triggeredBy: "max_iterations",
                originalVerdict: "tests_passed",
                overriddenTo: finalVerificationReason,
                reason: passedValidation.reason,
              }));
            }
          }
          if (finalVerificationReason === "tests_failed_unrelated") {
            const verdictValidation = validateUnrelatedClaim({
              log: toolCallLog,
              patchedFilePaths: Array.from(filesModified),
              framework: input.framework
                ? { hasTests: input.framework.hasTests }
                : undefined,
            });
            if (!verdictValidation.accept) {
              finalVerificationReason =
                verdictValidation.demoteTo ?? "tests_inconclusive";
              debugLog("[zone-agent-verdict-override]", JSON.stringify({
                triggeredBy: "max_iterations",
                originalVerdict: "tests_failed_unrelated",
                overriddenTo: verdictValidation.demoteTo,
                reason: verdictValidation.reason,
              }));
            } else if (
              verdictValidation.reason &&
              /resolved by a later successful run_command/i.test(verdictValidation.reason)
            ) {
              // Bug 44b: see natural_completion site for rationale.
              finalVerificationReason = "tests_passed";
              debugLog("[zone-agent-verdict-promote]", JSON.stringify({
                triggeredBy: "max_iterations",
                originalVerdict: "tests_failed_unrelated",
                promotedTo: "tests_passed",
                reason: verdictValidation.reason,
              }));
            }
          }
        }
        finalVerificationReason = applyNoInfraVerificationOverride({
          verificationReason: finalVerificationReason,
          framework: input.framework
            ? {
                hasTests: input.framework.hasTests,
                testFilesDetected: input.framework.testFilesDetected,
              }
            : undefined,
          patchApplied: didApplyPatch(toolCallLog),
          triggeredBy: "max_iterations",
        });
      }
  } catch {
    // Best-effort â€” fall through with heuristic
  }

  let patchValidatedByAgent =
    finalVerificationReason === "tests_passed" ||
    finalVerificationReason === "tests_skipped_no_infra" ||
    finalVerificationReason === "tests_failed_unrelated";

  debugLog("[zone-staging-state]", JSON.stringify({
    stagedFileCount: stagingFiles.size,
    stagedFiles: Array.from(stagingFiles.keys()).map((abs) => path.basename(abs)),
  }));
  log("[zone-agent-final-assessment]", JSON.stringify({
    triggeredBy: "max_iterations",
    finalVerificationReason,
    inferredFrom,
    patchValidatedByAgent,
  }));

  const finalizeResult = ownsStagingFiles
    ? await finalizeStaging({
        stagingFiles,
        repoPath: input.repoPath,
        framework: input.framework,
        withStagingTempFlush,
      })
    : {
        flushed: false,
        verification: {
          status: "skipped" as const,
          reason: "subagent_deferred_to_parent",
        },
        filesFlushed: 0,
        flushFailures: 0,
      };
  if (finalizeResult.verification.status === "fail") {
    finalVerificationReason = "verification_failed_staged";
    patchValidatedByAgent = false;
    finalSummary =
      finalSummary +
      "\n\n**Verification failed (" + finalizeResult.verification.label +
      ", " + finalizeResult.verification.durationMs + "ms).** " +
      "Changes were NOT applied to disk.\n\n```\n" +
      finalizeResult.verification.errorPreview +
      "\n```";
  } else if (
    finalizeResult.verification.status === "skipped" &&
    "reason" in finalizeResult.verification &&
    finalizeResult.verification.reason === "no_changes_made"
  ) {
    finalVerificationReason = "no_changes_made";
    patchValidatedByAgent = false;
  }

  return {
    success: false,
    summary: finalSummary,
    toolCallLog,
    filesModified: [...filesModified],
    patchValidatedByAgent,
    verificationReason: finalVerificationReason,
  };
}
