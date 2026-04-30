import {
  createOpenAIClient,
  extractResponsesApiOutputText,
  getModelName,
} from "./openaiClient.js";
import { parseVerificationError } from "../core/parseVerificationError.js";
import { ZONE_TOOLS } from "../tools/toolDefinitions.js";
import { executeTool, type ToolResult } from "../tools/toolExecutor.js";
import type { ProjectFramework } from "../repo/detectFramework.js";
import type {
  ResponseFunctionToolCall,
  ResponseInput,
} from "openai/resources/responses/responses";

export interface AgentLoopInput {
  task: string;
  repoPath: string;
  runId?: string;
  framework?: ProjectFramework;
  maxIterations?: number; // default: 10
  onProgress?: (msg: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: ToolResult) => void;
  onStructuredEvent?: (evt: unknown) => void;
  abortSignal?: AbortSignal;
  /** Optional import-ecosystem context block built by buildImportContextSummary. Injected by runLlmPatchFlow. */
  importContextSummary?: string;
  /**
   * BYOK: user-supplied OpenAI API key (sent from the browser via X-User-OpenAI-Key header).
   * Takes priority over process.env.OPENAI_API_KEY when present.
   * Never logged â€” only the source ("user" vs "env") is logged.
   */
  userApiKey?: string;
}

export type VerificationReason =
  | 'tests_passed'
  | 'tests_skipped_no_infra'
  | 'tests_inconclusive'
  | 'tests_failed_unrelated'
  | 'tests_failed_by_patch'
  | 'no_verification_attempted';

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

/** True when a run_command output looks like a test/build failure. */
function looksLikeCommandFailure(output: string): boolean {
  const t = String(output || "");
  return (
    /SyntaxError|ReferenceError|TypeError|RangeError/i.test(t) ||
    /\bFAIL\b|\bFAILED\b|\bfailing\b/i.test(t) ||
    /error TS\d+|tsc.*error/i.test(t) ||
    /exit code[:\s]+[1-9]\d*|exited with code [1-9]/i.test(t) ||
    /\bERROR\b.*\n|\berror:\s/im.test(t) ||
    /\d+ (test|spec|suite)s? failed/i.test(t) ||
    /npm ERR!|yarn error/i.test(t)
  );
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
  | "apply_patch_pre_existing_broken"
  | "apply_patch_scope_not_found"
  | "apply_patch_replace_shorter_than_find"
  | "apply_patch_find_block_empty"
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
  _recentToolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }>
): string {
  switch (trigger) {
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
      return SYNTAX_BROKEN_POST_WRITE_COACHING_PROMPT;
      return (
        `Your patch was applied but produced invalid syntax â€” the file was reverted to its pre-patch state.\n` +
        `This means your REPLACE block has a bug: missing brace, semicolon, paren, comma, or malformed statement.\n` +
        `Do NOT just retry the same patch. Re-examine your REPLACE block character by character.\n` +
        `If you're unsure where the syntax broke, narrow the change to the smallest possible REPLACE that still accomplishes the task.\n` +
        `Next action: produce a corrected apply_patch with a verified syntactically valid REPLACE block.`
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
        `Next action: classify with evidence; if related, produce a corrective patch.`
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
        `Next action: do not repeat the previous attempt verbatim â€” change ONE specific thing and explain what you changed.`
      );
  }
}

/** Responses API: `response.output` items with `type === "function_call"`. */
function extractFunctionCallItems(response: unknown): ResponseFunctionToolCall[] {
  const outputItems = (response as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(outputItems)) return [];
  const calls: ResponseFunctionToolCall[] = [];
  for (const item of outputItems) {
    const t = item as Partial<ResponseFunctionToolCall> | null;
    if (
      t &&
      t.type === "function_call" &&
      typeof t.name === "string" &&
      typeof t.arguments === "string" &&
      typeof t.call_id === "string"
    ) {
      calls.push(item as ResponseFunctionToolCall);
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
  ];
  return (valid as string[]).includes(raw) ? (raw as VerificationReason) : null;
}

/** Infer verification reason from the tool call log when the agent gave no tag. */
function inferVerificationFromLog(
  log: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }>
): VerificationReason {
  const patchApplied = log.some(
    (e) =>
      (e.tool === "apply_patch" || e.tool === "write_file") &&
      !String(e.result || "").toLowerCase().includes("error") &&
      !String(e.result || "").toLowerCase().includes("not found") &&
      !String(e.result || "").toLowerCase().includes("fail")
  );
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
}): { accept: boolean; demoteTo?: VerificationReason; reason: string } {
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
    if (entry.success === false) return true;
    return looksLikeCommandFailure(String(entry.result || ""));
  };
  const failingRunCommand = [...input.log]
    .reverse()
    .find(
      (entry) =>
        isRunCommandFailure(entry) &&
        !looksLikePassingRunCommand(String(entry.result || ""))
    );

  if (!anyRunCommand) {
    return {
      accept: false,
      demoteTo: "tests_inconclusive",
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
    demoteTo: "tests_inconclusive",
    reason:
      "cannot verify unrelated claim â€” no failing file extracted or evidence ambiguous",
  };
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const maxIterations = typeof input.maxIterations === "number" ? input.maxIterations : 10;
  const toolCallLog: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
    success?: boolean;
  }> = [];
  const filesModified = new Set<string>();
  let selfCorrectionAttempts = 0;

  // Diagnostic: confirm agent loop entry and tool inventory
  console.log("[zone-agent-loop-entry]", JSON.stringify({
    task: input.task.slice(0, 200),
    repoPath: input.repoPath,
    maxIterations,
    toolsAvailable: ZONE_TOOLS.map((t) => (t as { name?: string }).name ?? "unknown"),
    hasRunId: !!(input.runId && input.runId.trim()),
  }));

  const fw = input.framework;
  const systemContent =
    `You are Zone, an AI code agent${fw?.framework ? ` working on a ${fw.framework} project` : ""}.\n\n` +
    (fw
      ? `Project info:\n` +
        `- Language: ${fw.language}\n` +
        `- Framework: ${fw.framework}\n` +
        `- Test command: ${fw.testCommand || "none"}\n` +
        `- Build command: ${fw.buildCommand || "none"}\n` +
        `- Dev command: ${fw.devCommand || "none"}\n` +
        `- Package manager: ${fw.packageManager || "unknown"}\n` +
        `- Has tests: ${fw.hasTests}\n` +
        (fw.subProjects?.length
          ? `- Sub-projects: ${fw.subProjects.map((s) => s.framework).join(", ")}\n`
          : "") +
        `\n`
      : "") +
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
    `6. When all checks pass (or no tests exist), respond with a plain-text summary.\n` +
    `Maximum iterations: 10 (already enforced -- do not stall).\n\n` +
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
    (fw ? `When running commands, use the correct package manager and commands above.\n` : "") +
    `Repository path: ${input.repoPath}`;

  // Responses API input (same pattern as planFullPatch.ts: role + type "message").
  const responseInput: ResponseInput = [
    {
      role: "system",
      type: "message",
      content: systemContent,
    },
    {
      role: "user",
      type: "message",
      content: input.task,
    },
  ];

  const client = createOpenAIClient(input.userApiKey);

  for (let iter = 0; iter < maxIterations; iter += 1) {
    input.onProgress?.(`[agent_loop] Iteration ${iter + 1}/${maxIterations}`);

    const response = await client.responses.create({
      model: getModelName("high"),
      input: responseInput,
      tools: ZONE_TOOLS,
      tool_choice: "auto" as any,
    });

    const toolCalls = extractFunctionCallItems(response);
    if (toolCalls.length > 0) {
      let failureDetected = false;
      let failedToolName = "";
      let failedToolOutput = "";
      let failedToolError = "";

      for (const call of toolCalls) {
        const name = call.name;
        const callId = call.call_id;
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = call.arguments
            ? (JSON.parse(call.arguments) as Record<string, unknown>)
            : {};
        } catch {
          parsedArgs = {};
        }

        input.onToolCall?.(name, parsedArgs);

        // Diagnostic: log every tool call before execution
        console.log("[zone-agent-tool-call]", JSON.stringify({
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

        const rid = String(input.runId || "").trim();
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
        });
        input.onToolResult?.(name, result);

        // Diagnostic: log every tool result after execution
        console.log("[zone-agent-tool-result]", JSON.stringify({
          iter: iter + 1,
          tool: name,
          success: result.success,
          outputPreview: result.output.slice(0, 300),
          error: result.error ?? null,
        }));

        // Detect failures from any tool â€” feeds coaching-prompt router.
        // apply_patch / write_file: failure if result.success === false.
        // run_command: failure if output looks like a test/build error.
        // Other tools: failure if result.success === false.
        const toolFailed =
          (name === "run_command" && looksLikeCommandFailure(result.output)) ||
          (!result.success && name !== "run_command");
        if (toolFailed) {
          failureDetected = true;
          failedToolName = name;
          failedToolOutput = result.output;
          failedToolError = result.error ?? "";
        }

        toolCallLog.push({
          tool: name,
          args: parsedArgs,
          result: result.output.slice(0, 4000),
          success: result.success,
        });

        if (
          (name === "write_file" || name === "apply_patch") &&
          parsedArgs.filePath != null
        ) {
          filesModified.add(String(parsedArgs.filePath));
        }

        // Mirror Responses API: assistant tool call + tool output (not chat role:"tool").
        responseInput.push(call);
        responseInput.push({
          type: "function_call_output",
          call_id: callId,
          output: result.output,
        });
      }

      // â”€â”€ Self-correction: failure detected â†’ route to coaching prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Each self-correction attempt consumes one iteration toward maxIterations.
      // The selfCorrectionAttempts counter is a SUBSET of total iterations â€”
      // it limits how many times we inject coaching, not how many total iterations run.
      // This way a long but successful run won't hit the coaching budget.
      if (failureDetected && selfCorrectionAttempts < MAX_SELF_CORRECTION_ATTEMPTS) {
        selfCorrectionAttempts += 1;
        const routedTrigger = classifyFailure(failedToolName, failedToolOutput, failedToolError);
        const coachingText = buildCoachingPrompt(routedTrigger, failedToolOutput, toolCallLog);
        const remaining = MAX_SELF_CORRECTION_ATTEMPTS - selfCorrectionAttempts;
        console.log("[zone-agent-self-correct]", JSON.stringify({
          iter: iter + 1,
          trigger: failedToolName === "run_command" ? "test_failed" : failedToolName,
          routedTrigger,
          selfCorrectionAttempt: selfCorrectionAttempts,
          maxAttempts: MAX_SELF_CORRECTION_ATTEMPTS,
          errorPreview: failedToolOutput.slice(0, 200),
          willRetry: true,
          reason: "routed_coaching_prompt_injected",
        }));
        input.onProgress?.(
          `[agent_loop] Failure detected (${routedTrigger}) â€” self-correction attempt ${selfCorrectionAttempts}/${MAX_SELF_CORRECTION_ATTEMPTS}`
        );
        responseInput.push({
          role: "user",
          type: "message",
          content:
            `[Zone coaching â€” attempt ${selfCorrectionAttempts} of ${MAX_SELF_CORRECTION_ATTEMPTS}]\n` +
            coachingText +
            `\n\nRecent failure context:\n` +
            `- Tool: ${failedToolName}\n` +
            `- Error preview (first 300 chars): ${failedToolOutput.slice(0, 300)}\n` +
            `You have ${remaining} retry attempt${remaining === 1 ? "" : "s"} remaining. ` +
            `After that the run will halt with the current state.`,
        });
      } else if (failureDetected) {
        // Budget exhausted â€” log and let the model produce its final summary naturally.
        const routedTrigger = classifyFailure(failedToolName, failedToolOutput, failedToolError);
        console.log("[zone-agent-self-correct]", JSON.stringify({
          iter: iter + 1,
          trigger: failedToolName === "run_command" ? "test_failed" : failedToolName,
          routedTrigger,
          selfCorrectionAttempt: selfCorrectionAttempts,
          maxAttempts: MAX_SELF_CORRECTION_ATTEMPTS,
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
      ];
      let verificationReason: VerificationReason =
        (validReasons as string[]).includes(vrRaw)
          ? (vrRaw as VerificationReason)
          : 'no_verification_attempted';
      if (verificationReason === "tests_failed_unrelated") {
        const verdictValidation = validateUnrelatedClaim({
          log: toolCallLog,
          patchedFilePaths: Array.from(filesModified),
        });
        if (!verdictValidation.accept) {
          verificationReason = verdictValidation.demoteTo ?? "tests_inconclusive";
          console.log("[zone-agent-verdict-override]", JSON.stringify({
            triggeredBy: "natural_completion",
            originalVerdict: "tests_failed_unrelated",
            overriddenTo: verdictValidation.demoteTo,
            reason: verdictValidation.reason,
          }));
        }
      }
      const patchValidatedByAgent =
        verificationReason === 'tests_passed' ||
        verificationReason === 'tests_skipped_no_infra' ||
        verificationReason === 'tests_failed_unrelated';
      console.log("[zone-agent-final-assessment]", JSON.stringify({
        triggeredBy: "natural_completion",
        verificationReason,
        patchValidatedByAgent,
        inferredFrom: vrMatch ? "tag" : "heuristic",
        summaryPreview: finalText.slice(0, 200),
      }));
      return {
        success: true,
        summary: finalText,
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
  let finalVerificationReason: VerificationReason = inferVerificationFromLog(toolCallLog);
  let inferredFrom: "tag" | "heuristic" = "heuristic";
  let finalSummary = "Max iterations reached";
  try {
    const assessmentResponse = await client.responses.create({
      model: getModelName("high"),
      input: [
        ...responseInput,
        {
          role: "user" as const,
          type: "message" as const,
          content:
            "You have reached the maximum number of iterations. " +
            "Provide a brief final summary of what you did and include exactly one " +
            "[ZONE_VERIFICATION: <reason>] tag. " +
            "Choose: tests_passed, tests_skipped_no_infra, tests_inconclusive, " +
            "tests_failed_unrelated, tests_failed_by_patch, or no_verification_attempted. " +
            "Use tests_inconclusive if tests failed due to environment issues " +
            "(spawn errors, ENOENT, missing script, missing deps). " +
            "Use tests_failed_by_patch ONLY if your patch caused the failure.",
        },
      ],
    });
    const ae = extractResponsesApiOutputText(assessmentResponse);
      if (ae.ok && ae.text.trim()) {
        finalSummary = ae.text.trim();
        const tagged = parseVerificationTag(finalSummary);
        if (tagged) {
          finalVerificationReason = tagged;
          inferredFrom = "tag";
          if (finalVerificationReason === "tests_failed_unrelated") {
            const verdictValidation = validateUnrelatedClaim({
              log: toolCallLog,
              patchedFilePaths: Array.from(filesModified),
            });
            if (!verdictValidation.accept) {
              finalVerificationReason =
                verdictValidation.demoteTo ?? "tests_inconclusive";
              console.log("[zone-agent-verdict-override]", JSON.stringify({
                triggeredBy: "max_iterations",
                originalVerdict: "tests_failed_unrelated",
                overriddenTo: verdictValidation.demoteTo,
                reason: verdictValidation.reason,
              }));
            }
          }
        }
      }
  } catch {
    // Best-effort â€” fall through with heuristic
  }

  const patchValidatedByAgent =
    finalVerificationReason === "tests_passed" ||
    finalVerificationReason === "tests_skipped_no_infra" ||
    finalVerificationReason === "tests_failed_unrelated";

  console.log("[zone-agent-final-assessment]", JSON.stringify({
    triggeredBy: "max_iterations",
    finalVerificationReason,
    inferredFrom,
    patchValidatedByAgent,
  }));

  return {
    success: false,
    summary: finalSummary,
    toolCallLog,
    filesModified: [...filesModified],
    patchValidatedByAgent,
    verificationReason: finalVerificationReason,
  };
}
