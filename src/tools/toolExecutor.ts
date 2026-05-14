import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import { debugLog, errorLog, log } from "../utils/logger.js";
import {
  extractDeclaredSymbols,
  locateSymbol,
  type SymbolKind,
} from "../ast/astSymbolLocator.js";
import {
  checkSemanticSmells,
  validateSyntax,
} from "../ast/astSyntaxValidator.js";
import { checkWriteScope } from "./scopeGuard.js";
import { sanitizeVerificationEnv, strippedEnvKeys } from "../core/buildEnv.js";
import type { ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";
import type { ProjectFramework } from "../repo/detectFramework.js";
import { generateFileOutline } from "./fileOutline.js";
import { getDevServerConfig, probeDevServer } from "../visual/devServerProbe.js";
import { runVerifyVisual, type VerifyVisualInput } from "./verifyVisual.js";

const execAsync = promisify(exec);

// Phase V Commit 2: Unicode curly-quote → ASCII normalization for FIND/REPLACE blocks.
const SMART_QUOTE_MAP: Record<string, string> = {
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
};
function normalizeSmartQuotes(s: string): { text: string; count: number } {
  let count = 0;
  const text = s.replace(/[“”‘’]/g, (ch) => {
    count++;
    return SMART_QUOTE_MAP[ch] ?? ch;
  });
  return { text, count };
}

export type ResolveCwdResult =
  | { ok: true; cwd: string }
  | { ok: false; error: string };

// ─── Regression guard ────────────────────────────────────────────────────────
// Every tool name defined in toolDefinitions.ts must have a dispatch branch in
// executeTool().  This set is checked at module load so a missing entry causes
// a hard startup failure instead of a silent "Unknown tool" at runtime.
const DISPATCHED_TOOLS = new Set([
  "run_command",
  "read_file",
  "list_files",
  "apply_patch",
  "write_file",
  "search_in_files",
  "verify_visual",
  "find_references",
  "Task",
  "run_command_background",
  "read_background_output",
  "kill_background",
  "list_background",
  "update_memory",
  // TodoWrite is intercepted in the agent loop (no I/O), but must be listed here
  // so the IIFE startup guard at :51-75 doesn't fail-fast on its presence in
  // ZONE_TOOLS.
  "TodoWrite",
]);

// Import the definitions lazily to keep the check co-located with the executor.
// We do a synchronous inline require so the guard runs before any server code.
(function verifyToolDispatch() {
  // Dynamically import the definitions at runtime to avoid a circular reference
  // at compile time.  If the module isn't compiled yet this is a no-op.
  let defs: Array<{ function: { name: string } }>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    defs = (
      require("./toolDefinitions.js") as {
        ZONE_TOOLS: Array<{ function: { name: string } }>;
      }
    ).ZONE_TOOLS;
  } catch {
    // dist/ not built yet — skip guard during source-only runs
    return;
  }
  for (const tool of defs) {
    const name = tool.function?.name;
    if (!DISPATCHED_TOOLS.has(name)) {
      throw new Error(
        `FATAL: Tool '${name}' is defined in toolDefinitions but has no executor dispatch. ` +
          `Add a 'if (toolName === "${name}") { ... }' branch to executeTool().`
      );
    }
  }
})();

export interface ToolResult {
  success: boolean;
  /** Phase Q.5: authoritative exit code for run_command results.
   *  success === (exitCode === 0); both are set together. Absent for
   *  non-shell tools. */
  exitCode?: number;
  output: string;
  error?: string;
  truncated?: boolean;
  rejectionReason?: string;
  contentLength?: number;
  metadata?: Record<string, unknown>;
}

function truncateText(
  text: string,
  maxChars: number
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + "... [truncated]", truncated: true };
}

// Phase Q.4: head/tail line truncation for run_command output.
// Agent context is capped at HEAD_LINES + TAIL_LINES so noisy test output
// (hundreds of failures) doesn't consume 50-150K tokens. Full output is
// preserved in the debugLog for post-run analysis.
export const COMMAND_OUTPUT_HEAD_LINES = 100;
export const COMMAND_OUTPUT_TAIL_LINES = 50;

export function truncateCommandOutput(output: string): {
  truncated: string;
  wasTruncated: boolean;
  originalLineCount: number;
} {
  const lines = output.split("\n");
  const total = lines.length;
  if (total <= COMMAND_OUTPUT_HEAD_LINES + COMMAND_OUTPUT_TAIL_LINES) {
    return { truncated: output, wasTruncated: false, originalLineCount: total };
  }
  const head = lines.slice(0, COMMAND_OUTPUT_HEAD_LINES);
  const tail = lines.slice(-COMMAND_OUTPUT_TAIL_LINES);
  const elidedCount = total - COMMAND_OUTPUT_HEAD_LINES - COMMAND_OUTPUT_TAIL_LINES;
  const truncated = [
    ...head,
    "",
    `[... ${elidedCount} lines truncated for context budget ...]`,
    "",
    ...tail,
  ].join("\n");
  return { truncated, wasTruncated: true, originalLineCount: total };
}

function safeRelPath(rel: string): string {
  return String(rel || "").replace(/^[\\/]+/, "");
}

/**
 * path-duplication Tur: agents sometimes pass absolute paths that already
 * include the repoPath prefix (e.g. "/home/bedo/zone-landing/app/global-error.tsx"
 * when repoPath is "/home/bedo/zone-landing"). The previous safeRelPath only
 * stripped leading slashes, so path.join(repoPath, ...) duplicated the prefix.
 *
 * Behavior:
 *   - relative input ("components/Foo.tsx")  → returns it unchanged
 *   - leading-slashed relative ("/foo/bar")  → strips the slash (legacy)
 *   - absolute matching repoPath             → returns the trailing relative form
 *   - absolute outside repoPath              → falls back to leading-slash strip;
 *                                              downstream scope guard / FS catches it
 *
 * Always emits [zone-tool-path-resolve] when the input was absolute, so the
 * smoke can prove no duplication happens after the fix.
 */
export function resolveAgentPath(
  rawPath: string,
  repoPath: string,
  toolName?: string
): string {
  const raw = String(rawPath || "").trim();
  if (!raw) return "";
  const wasAbsolute = path.isAbsolute(raw);
  let resolved: string;
  let strippedRepoPrefix = false;

  if (wasAbsolute) {
    const repoAbs = path.resolve(repoPath);
    const inputAbs = path.normalize(raw);
    if (inputAbs === repoAbs) {
      resolved = "";
      strippedRepoPrefix = true;
    } else if (inputAbs.startsWith(repoAbs + path.sep)) {
      resolved = inputAbs.slice(repoAbs.length + 1);
      strippedRepoPrefix = true;
    } else {
      // Absolute path that doesn't share the repo prefix.
      // Legacy safeRelPath behavior: strip leading separators.
      resolved = raw.replace(/^[\\/]+/, "");
    }
    debugLog("[zone-tool-path-resolve]", JSON.stringify({
      tool: toolName ?? null,
      agentInput: raw,
      isAbsolute: true,
      repoPath,
      resolved,
      strippedRepoPrefix,
    }));
  } else {
    resolved = raw.replace(/^[\\/]+/, "");
  }
  return resolved;
}

function isBlockedCommand(command: string): boolean {
  const c = String(command || "");
  const patterns = ["rm -rf /", "format", "del /f /s", "DROP TABLE", "DROP DATABASE"];
  const upper = c.toUpperCase();
  return patterns.some((p) => upper.includes(p.toUpperCase()));
}

function detectLineEnding(
  s: string
): "crlf" | "lf" | "mixed" | "none" {
  const crlfCount = (String(s || "").match(/\r\n/g) || []).length;
  const lfOnlyCount = (String(s || "").match(/(?<!\r)\n/g) || []).length;
  if (crlfCount > 0 && lfOnlyCount > 0) return "mixed";
  if (crlfCount > 0) return "crlf";
  if (lfOnlyCount > 0) return "lf";
  return "none";
}

function analyzeLineEnding(s: string): {
  detected: "crlf" | "lf" | "mixed" | "none";
  dominant: "crlf" | "lf";
  crlfCount: number;
  lfOnlyCount: number;
} {
  const text = String(s || "");
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const lfOnlyCount = (text.match(/(?<!\r)\n/g) || []).length;
  const detected = detectLineEnding(text);
  if (detected === "crlf") {
    return { detected, dominant: "crlf", crlfCount, lfOnlyCount };
  }
  if (detected === "lf") {
    return { detected, dominant: "lf", crlfCount, lfOnlyCount };
  }
  if (detected === "mixed") {
    return {
      detected,
      dominant: crlfCount >= lfOnlyCount ? "crlf" : "lf",
      crlfCount,
      lfOnlyCount,
    };
  }
  return { detected, dominant: "lf", crlfCount, lfOnlyCount };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let fromIndex = 0;
  while (true) {
    const idx = haystack.indexOf(needle, fromIndex);
    if (idx === -1) break;
    count += 1;
    fromIndex = idx + needle.length;
  }
  return count;
}

function visibleEolPreview(s: string, maxChars = 200): string {
  return String(s || "")
    .slice(0, maxChars)
    .replace(/\r/g, "<CR>")
    .replace(/\n/g, "<LF>\n");
}

function hasTrailingNewline(s: string): boolean {
  return /\r?\n$/.test(String(s || ""));
}

export function resolveRunCommandCwd(
  rawCwd: unknown,
  repoPath: string
): ResolveCwdResult {
  let candidate: string;

  if (
    rawCwd === null ||
    rawCwd === undefined ||
    (typeof rawCwd === "string" && rawCwd.trim() === "")
  ) {
    candidate = repoPath;
  } else if (typeof rawCwd === "string") {
    candidate = path.isAbsolute(rawCwd)
      ? path.normalize(rawCwd)
      : path.resolve(repoPath, rawCwd);
  } else {
    return {
      ok: false,
      error: `Invalid cwd type: expected string or null, got ${typeof rawCwd}`,
    };
  }

  try {
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: `cwd is not a directory: ${candidate}`,
      };
    }
  } catch {
    return {
      ok: false,
      error:
        `cwd does not exist: ${candidate}. If you intended a path inside the repo, ` +
        `pass it relative to repoPath (e.g., "client") — Zone will resolve it against ${repoPath}.`,
    };
  }

  return { ok: true, cwd: candidate };
}

/**
 * Count the number of CRLF (\r\n) sequences that appear strictly before
 * `offset` in `s`.  Used to convert original-content char offsets (returned
 * by Babel, which operates on the raw CRLF text) into normalized (LF-only)
 * char offsets.
 *
 * Each \r\n counted here reduces the normalized offset by 1 because
 * `.replace(/\r\n/g, "\n")` removes exactly one character per pair.
 */
function countCrlfsBefore(s: string, offset: number): number {
  let count = 0;
  const limit = Math.min(offset, s.length - 1);
  for (let i = 0; i < limit; i++) {
    if (s[i] === "\r" && s[i + 1] === "\n") {
      count++;
    }
  }
  return count;
}

function stagedRead(
  staging: Map<string, string> | undefined,
  abs: string
): string | null {
  if (!staging) return null;
  const key = path.resolve(abs);
  return staging.has(key) ? staging.get(key)! : null;
}

function formatSearchContextBlock(
  filePath: string,
  lines: string[],
  matchLines: number[],
  contextWindow = 3
): string[] {
  const sortedMatches = [...new Set(matchLines)]
    .filter((line) => Number.isFinite(line) && line >= 1)
    .sort((a, b) => a - b);
  const blocks: Array<{ start: number; end: number; matches: Set<number> }> = [];

  for (const matchLine of sortedMatches) {
    const start = Math.max(1, matchLine - contextWindow);
    const end = Math.min(lines.length, matchLine + contextWindow);
    const prev = blocks[blocks.length - 1];
    if (prev && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end);
      prev.matches.add(matchLine);
    } else {
      blocks.push({ start, end, matches: new Set([matchLine]) });
    }
  }

  return blocks.map((block) => {
    const blockMatchLines = [...block.matches].sort((a, b) => a - b);
    const header =
      block.matches.size === 1
        ? `${filePath}:${blockMatchLines[0]}`
        : `${filePath}:${blockMatchLines[0]}-${blockMatchLines[blockMatchLines.length - 1]} (${blockMatchLines.length} matches)`;
    const context = [];
    for (let i = block.start; i <= block.end; i += 1) {
      const marker = block.matches.has(i) ? ">" : " ";
      context.push(`${marker} ${String(i).padStart(4)}: ${lines[i - 1] ?? ""}`);
    }
    return `${header}\n${context.join("\n")}`;
  });
}

function prefixLineNumbers(lines: string[], startLine: number): string {
  return lines
    .map((line, i) => `${String(startLine + i).padStart(6)}\t${line}`)
    .join("\n");
}

// Strip the cat-n style prefix (e.g. "     1\t") that read_file emits on outline/lineRange tiers.
// Only strips if ALL non-empty lines carry the prefix (all-or-nothing: avoids false positives on
// files that happen to start with spaces+digits+tab as real code).
function stripReadFilePrefix(find: string): string {
  const lines = find.split("\n");
  const nonEmpty = lines.filter((l) => l !== "");
  if (nonEmpty.length === 0) return find;
  if (!nonEmpty.every((l) => /^\s*\d+\t/.test(l))) return find;
  return lines.map((l) => l.replace(/^\s*\d+\t/, "")).join("\n");
}

// Module-level cache for ripgrep detection (undefined = not yet checked)
let _rgPath: string | null | undefined;

async function detectRipgrep(): Promise<string | null> {
  if (_rgPath !== undefined) return _rgPath;
  try {
    const { stdout } = await execAsync("which rg");
    _rgPath = stdout.trim() || null;
  } catch {
    _rgPath = null;
  }
  return _rgPath;
}

function parseRgJsonContent(
  stdout: string,
  maxMatches: number
): { success: boolean; output: string; truncated?: boolean } {
  interface RgData {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  }
  interface RgEvent {
    type: string;
    data: RgData;
  }

  type LineEntry = { lineNum: number; text: string; isMatch: boolean };
  const outputBlocks: string[] = [];
  let currentFile = "";
  let currentBlock: LineEntry[] = [];
  let totalMatches = 0;
  let capReached = false;
  const matchCountsByFile = new Map<string, number>();

  function flushBlock() {
    if (!currentBlock.length) return;
    const matchLineNums = currentBlock.filter((l) => l.isMatch).map((l) => l.lineNum);
    if (!matchLineNums.length) { currentBlock = []; return; }
    const header =
      matchLineNums.length === 1
        ? `${currentFile}:${matchLineNums[0]}`
        : `${currentFile}:${matchLineNums[0]}-${matchLineNums[matchLineNums.length - 1]} (${matchLineNums.length} matches)`;
    const formattedLines = currentBlock.map((l) => {
      const marker = l.isMatch ? ">" : " ";
      return `${marker} ${String(l.lineNum).padStart(4)}: ${l.text}`;
    });
    outputBlocks.push(`${header}\n${formattedLines.join("\n")}`);
    currentBlock = [];
  }

  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (capReached) break;
    let evt: RgEvent;
    try { evt = JSON.parse(line) as RgEvent; } catch { continue; }

    if (evt.type === "begin") {
      flushBlock();
      currentFile = evt.data.path?.text ?? "";
      currentBlock = [];
    } else if (evt.type === "match") {
      totalMatches++;
      if (totalMatches > maxMatches) { capReached = true; break; }
      matchCountsByFile.set(currentFile, (matchCountsByFile.get(currentFile) ?? 0) + 1);
      currentBlock.push({
        lineNum: evt.data.line_number ?? 0,
        text: (evt.data.lines?.text ?? "").replace(/[\r\n]+$/, ""),
        isMatch: true,
      });
    } else if (evt.type === "context") {
      currentBlock.push({
        lineNum: evt.data.line_number ?? 0,
        text: (evt.data.lines?.text ?? "").replace(/[\r\n]+$/, ""),
        isMatch: false,
      });
    } else if (evt.type === "end") {
      flushBlock();
    }
  }
  flushBlock();

  const matchedFileCount = matchCountsByFile.size;
  const topFiles = [...matchCountsByFile.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5);
  const summaryLines = [
    "---",
    `[search_in_files] Found ${totalMatches} matches across ${matchedFileCount} files.`,
    "Top files by match count:",
    ...(topFiles.length > 0
      ? topFiles.map(([f, c]) => `  - ${f}: ${c} matches`)
      : ["  (none)"]),
  ];
  if (capReached) {
    summaryLines.push(
      `WARNING: CAP REACHED at ${maxMatches} matches — there may be more results. ` +
        "Narrow your pattern or add a glob filter for completeness."
    );
  }
  const summaryBlock = summaryLines.join("\n");
  let matchSection = outputBlocks.length ? outputBlocks.join("\n") : "(no matches)";
  const summaryBudget = 4000 - summaryBlock.length - 2;
  if (summaryBudget > 0 && matchSection.length > summaryBudget) {
    matchSection = truncateText(matchSection, summaryBudget).text;
  }
  const out = `${matchSection}\n\n${summaryBlock}`;
  const t = truncateText(out, 4000);
  return { success: true, output: t.text, truncated: t.truncated };
}

function stagedWrite(
  staging: Map<string, string> | undefined,
  abs: string,
  content: string
): boolean {
  if (!staging) return false;
  const key = path.resolve(abs);
  staging.set(key, content);
  return true;
}

export async function withStagingTempFlush<T>(
  staging: Map<string, string> | undefined,
  body: () => Promise<T>
): Promise<T> {
  if (!staging || staging.size === 0) {
    return body();
  }

  const backup = new Map<string, string | null>();

  for (const [abs] of staging) {
    try {
      backup.set(abs, fs.readFileSync(abs, "utf8"));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        backup.set(abs, null);
      } else {
        throw err;
      }
    }
  }

  let filesFlushed = 0;
  for (const [abs, content] of staging) {
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      filesFlushed++;
    } catch (err) {
      errorLog("[zone-staging-temp-flush-error]", {
        filePath: abs,
        error: String((err as Error).message ?? err),
      });
    }
  }

  let restoreFailures = 0;

  try {
    return await body();
  } finally {
    let filesRestored = 0;
    for (const [abs, original] of backup) {
      try {
        if (original === null) {
          try {
            fs.unlinkSync(abs);
          } catch (unlinkErr) {
            const code = (unlinkErr as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") throw unlinkErr;
          }
        } else {
          fs.writeFileSync(abs, original, "utf8");
        }
        filesRestored++;
      } catch (err) {
        restoreFailures++;
        errorLog("[zone-staging-restore-error]", {
          filePath: abs,
          error: String((err as Error).message ?? err),
        });
      }
    }
    debugLog("[zone-staging-temp-flush]", JSON.stringify({
      filesFlushed,
      filesRestored,
      restoreFailures,
      totalStaged: staging.size,
    }));
  }
}

export async function executeTool(
  toolName: string,
  toolArgs: Record<string, unknown>,
  repoPath: string,
  onProgress?: (msg: string) => void,
  input?: {
    runId?: string;
    onApprovalRequired?: (
      command: string,
      runId: string,
      meta?: { kind?: "blocking" | "background"; label?: string | null }
    ) => Promise<boolean>;
    escalatedFiles?: Set<string>;
    allowWriteFileOverwritePaths?: Set<string>;
    stagingFiles?: Map<string, string>;
    abortSignal?: AbortSignal;
    /** Tur P2-scope: when present, write tools (apply_patch, write_file)
     *  reject paths outside the union of plan.steps[*].filesLikely. */
    executionPlan?: import("../llm/executionPlan.js").ExecutionPlan | null;
    allowedTools?: ReadonlySet<string>;
    userId?: string;
    framework?: ProjectFramework;
    subagent?: {
      id: string;
      type: "worker" | "explore" | "verifier";
      parentRunId: string;
    };
    onToolCall?: (name: string, args: Record<string, unknown>) => void;
    onToolResult?: (name: string, result: ToolResult) => void;
    onStructuredEvent?: (evt: unknown) => void;
    /** F1.4: forwarded to worker subagent's runAgentLoop so worker tool-
     *  input deltas reach the same SSE stream as the parent's. */
    onToolInputStream?: (event: {
      blockId: string;
      toolName: string;
      delta: string;
      isFirstDelta: boolean;
      iter: number;
      subagentId?: string | null;
    }) => void;
    visualScreenshotCount?: number;
    tokenBudgetBaseTokens?: number;
    /** L.2: tier-based subagent call cap override. Defaults to MAX_SUBAGENT_CALLS_PER_PARENT_RUN. */
    maxSubagentCallsOverride?: number;
    /** Phase V: set of filePaths successfully read_file'd this run. When present,
     *  apply_patch rejects if the target is not in the set. */
    filesReadThisRun?: ReadonlySet<string>;
    /** Phase V: mutable counters accumulated by self-validation hooks. Passed
     *  by reference so agentLoop can emit a summary at run end. */
    selfValidationCounts?: {
      readBeforePatchRejects: number;
      smartQuoteFixes: number;
      inlineTsRejects: number;
      inlineTsApproves: number;
      inlineTsSkips: number;
      totalLatencyMs: number;
    };
  }
): Promise<ToolResult> {
  const args = (toolArgs ?? {}) as Record<string, unknown>;

  try {
    if (toolName === "Task") {
      // nested subagent refused: Workers cannot dispatch Task.
      if (input?.subagent !== undefined) {
        return {
          success: false,
          output:
            "Nested subagents are not allowed. The Task tool can only be invoked from the top-level agent.",
        };
      }
      if (input?.allowedTools && !input.allowedTools.has(toolName)) {
        return {
          success: false,
          output: `Tool "${toolName}" is not in the allowed set for this run.`,
        };
      }

      const parentRunId = input?.runId;
      if (!parentRunId) {
        return {
          success: false,
          output: "Task tool requires a parent runId in execution context.",
        };
      }
      // TODO(PR 5+): relax this once subagent write-set prediction and
      // conflict handling can prove the Worker cannot overlap parent edits.
      if (input?.stagingFiles && input.stagingFiles.size > 0) {
        return {
          success: false,
          output:
            "Task dispatch is currently not allowed after the parent run has staged uncommitted writes. " +
            "The parent must flush or discard its current staging set before delegating to a Worker subagent. " +
            "Continue the work directly in this run.",
          error: "task_dispatch_blocked_parent_has_staged_writes",
          rejectionReason: "parent_staged_writes_present",
        };
      }

      const {
        incrementSubagentCallCount,
        getSubagentCallCount,
        MAX_SUBAGENT_CALLS_PER_PARENT_RUN,
        subagentTypeAllowedTools,
        subagentTypeMaxIterations,
        VALID_SUBAGENT_TYPES,
        formatSubagentToolResultForParent,
        formatExploreSubagentToolResultForParent,
      } = await import("../llm/subagents.js");

      const effectiveSubagentCap =
        typeof input?.maxSubagentCallsOverride === "number"
          ? input.maxSubagentCallsOverride
          : MAX_SUBAGENT_CALLS_PER_PARENT_RUN;
      if (getSubagentCallCount(parentRunId) >= effectiveSubagentCap) {
        return {
          success: false,
          output:
            `Subagent call budget exhausted (${effectiveSubagentCap} per parent run). ` +
            "Complete remaining work directly without delegation.",
        };
      }

      const subagentType = args.subagent_type;
      const description = args.description;
      if (!VALID_SUBAGENT_TYPES.includes(subagentType as "worker" | "explore")) {
        return {
          success: false,
          output: `Subagent type "${String(subagentType)}" is not supported. Valid types: ${VALID_SUBAGENT_TYPES.join(", ")}.`,
        };
      }
      const resolvedType = subagentType as "worker" | "explore";
      if (typeof description !== "string" || !description.trim()) {
        return {
          success: false,
          output: "Task description must be a non-empty string.",
        };
      }

      const subagentId = randomUUID();
      incrementSubagentCallCount(parentRunId);

      input?.onStructuredEvent?.({
        type: "subagent_started",
        title: description.trim().slice(0, 80),
        status: "active",
        subagentId,
        subagentType: resolvedType,
        parentRunId,
      } satisfies Partial<ZoneStructuredProgressEvent>);

      const { runAgentLoop } = await import("../llm/agentLoop.js");
      const { withRequestContext, getRequestContext } = await import("../llm/openaiContext.js");
      const { getModelForRole } = await import("../llm/modelRouting.js");
      const _requestCtx = getRequestContext();
      const _provider = _requestCtx?.provider ?? "openai";
      // Preset plumbing: if parent has a modelOverride.standard (e.g. quality preset sends
      // standard=sonnet), the worker inherits that. Otherwise falls back to role default (Haiku).
      const _parentStandard = _requestCtx?.modelOverride?.standard;
      const workerModel =
        resolvedType === "worker"
          ? (_parentStandard ?? getModelForRole("worker", _provider))
          : undefined;
      const subagentResult = await withRequestContext(
        {
          subagentId,
          subagentType: resolvedType,
          parentRunId,
          ...(workerModel
            ? { modelOverride: { high: workerModel, standard: workerModel } }
            : {}),
        },
        () =>
          runAgentLoop({
            task: description.trim(),
            repoPath: repoPath || process.cwd(),
            runId: parentRunId,
            userId: input?.userId,
            framework: input?.framework,
            maxIterationsOverride: subagentTypeMaxIterations(resolvedType),
            allowedTools: subagentTypeAllowedTools(resolvedType),
            subagent: { id: subagentId, type: resolvedType, parentRunId },
            parentStagingFiles: resolvedType === "worker" ? input?.stagingFiles : undefined,
            abortSignal: input?.abortSignal,
            onProgress,
            onToolCall: input?.onToolCall,
            onToolResult: input?.onToolResult,
            onStructuredEvent: input?.onStructuredEvent,
            // F1.4: hand the streaming callback to the worker subagent.
            // The worker's agentLoop tags each delta with its subagentId
            // so the UI can render "↳ worker N is writing..." in the slot.
            onToolInputStream: input?.onToolInputStream,
            tokenBudgetBaseTokens: input?.tokenBudgetBaseTokens,
          })
      );

      const result =
        resolvedType === "explore"
          ? formatExploreSubagentToolResultForParent(subagentResult, subagentId, parentRunId)
          : formatSubagentToolResultForParent(subagentResult, subagentId, parentRunId);
      let subagentStatus: "completed" | "partial" | "failed" = subagentResult.success
        ? "completed"
        : "failed";
      const defaultTitle = resolvedType === "explore" ? "Explore completed" : "Worker completed";
      let title = subagentResult.summary || defaultTitle;
      try {
        const parsed = JSON.parse(result.output) as {
          status?: "completed" | "partial" | "failed";
          summary?: string;
        };
        if (
          parsed.status === "completed" ||
          parsed.status === "partial" ||
          parsed.status === "failed"
        ) {
          subagentStatus = parsed.status;
        }
        if (typeof parsed.summary === "string" && parsed.summary.trim()) {
          title = parsed.summary.trim();
        }
      } catch {
        // Keep lifecycle reporting best-effort; the tool result still carries the raw summary.
      }
      input?.onStructuredEvent?.({
        type: "subagent_completed",
        title: title.slice(0, 120),
        status:
          subagentStatus === "completed"
            ? "success"
            : subagentStatus === "partial"
              ? "warning"
              : "error",
        subagentStatus,
        subagentId,
        subagentType: resolvedType,
        parentRunId,
      } satisfies Partial<ZoneStructuredProgressEvent>);

      return result;
    }

    if (input?.allowedTools && !input.allowedTools.has(toolName)) {
      return {
        success: false,
        output: `Tool "${toolName}" is not in the allowed set for this run.`,
      };
    }

    if (toolName === "run_command") {
      const command = String(args.command ?? "");
      const resolved = resolveRunCommandCwd(args.cwd, repoPath);
      if (!resolved.ok) {
        debugLog("[zone-tool-runcmd-cwd-error]", {
          rawCwd: args.cwd,
          repoPath,
          error: resolved.error,
        });
        return { success: false, output: resolved.error };
      }
      const cwd = resolved.cwd;

      if (isBlockedCommand(command)) {
        return { success: false, output: "Command blocked for safety" };
      }

      if (input?.runId && input?.onApprovalRequired) {
        const approved = await input.onApprovalRequired(command, input.runId);
        if (!approved) {
          return {
            success: false,
            output: `User rejected the command: ${command}. Do not retry it.`,
          };
        }
      }

      onProgress?.(`[tool] Running: ${command}`);

      const execOptions: {
        cwd: string;
        timeout: number;
        windowsHide: boolean;
        maxBuffer: number;
        shell?: string;
        signal?: AbortSignal;
        env: NodeJS.ProcessEnv;
      } = {
        cwd,
        timeout: 30000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        // Build/test commands run by the agent must execute under a clean NODE_ENV.
        env: sanitizeVerificationEnv(),
      };

      if (process.platform === "win32") {
        execOptions.shell = process.env.ComSpec ?? "cmd.exe";
      } else {
        execOptions.shell = "/bin/sh";
      }
      if (input?.abortSignal) {
        execOptions.signal = input.abortSignal;
      }

      debugLog("[zone-tool-runcmd-debug]", {
        command: command.slice(0, 100),
        cwd,
        platform: process.platform,
        shellOption: execOptions.shell || "default",
        hasAbortSignal: !!input?.abortSignal,
      });

      let stdout = "";
      let stderr = "";
      let commandExitCode = 0;
      try {
        const result = await withStagingTempFlush(input?.stagingFiles, async () => {
          return await execAsync(command, execOptions);
        });
        stdout = result.stdout;
        stderr = result.stderr;
        console.log(
          `[zone-verify] cmd="${command.slice(0, 80)}" cwd="${cwd}" exitCode=0 stripped_env_keys=${JSON.stringify(strippedEnvKeys())}`
        );
      } catch (err) {
        const code = Number((err as { code?: unknown }).code);
        commandExitCode = Number.isFinite(code) && code !== 0 ? code : 1;
        console.log(
          `[zone-verify] cmd="${command.slice(0, 80)}" cwd="${cwd}" exitCode=${commandExitCode} stripped_env_keys=${JSON.stringify(strippedEnvKeys())}`
        );
        // Capture stdout/stderr from the exec error so the agent sees actual
        // command output rather than just the Node error message.
        stdout = String((err as { stdout?: unknown }).stdout ?? "");
        stderr = String((err as { stderr?: unknown }).stderr ?? "");
      }

      const combined = [stdout, stderr].filter(Boolean).join("\n") || "(no output)";

      // Phase Q.4: line-based head/tail truncation. Full output preserved in
      // debugLog so post-run analysis can retrieve it.
      const ct = truncateCommandOutput(combined);
      if (ct.wasTruncated) {
        debugLog("[zone-runcmd-truncated]", JSON.stringify({
          command: command.slice(0, 100),
          originalLineCount: ct.originalLineCount,
          headLines: COMMAND_OUTPUT_HEAD_LINES,
          tailLines: COMMAND_OUTPUT_TAIL_LINES,
        }));
      }

      // Phase Q.5: prepend exit_code header so the agent sees it as the
      // first token — combats retry loops triggered by output content alone.
      const commandSuccess = commandExitCode === 0;
      // Q.5b (partial): when exitCode=0 but output mentions test failures,
      // augment the header to pre-empt the agent's retry logic. Full baseline-
      // comparison-based tests_failed_unrelated detection is deferred:
      // TODO Q.5b: surface tests_failed_unrelated tag to agent runtime once
      // the baseline comparison from runStagingVerification is available pre-
      // result-delivery (currently only available post-run).
      const hasTestFailureContent = commandSuccess &&
        /\b(Tests?:?\s+\d+\s+failed|FAILED\s+tests?|test result: FAILED|Test Suites?:.*failed)\b/i
          .test(combined);
      const exitHeader = commandSuccess
        ? hasTestFailureContent
          ? `[exit_code=0 — command succeeded. Test failures visible in output are likely pre-existing and unrelated to your patch. Do not retry.]\n`
          : `[exit_code=0 — command succeeded; output below is informational]\n`
        : `[exit_code=${commandExitCode} — command failed]\n`;
      return {
        success: commandSuccess,
        exitCode: commandExitCode,
        output: exitHeader + ct.truncated,
        truncated: ct.wasTruncated,
      };
    }

    if (toolName === "run_command_background") {
      const command = String(args.command ?? "");
      const resolved = resolveRunCommandCwd(args.cwd, repoPath);
      if (!resolved.ok) {
        return { success: false, output: resolved.error };
      }
      if (isBlockedCommand(command)) {
        return { success: false, output: "Command blocked for safety" };
      }
      const runId = String(input?.runId ?? "");
      if (!runId) {
        return { success: false, output: "background commands require a runId" };
      }
      const label = typeof args.label === "string" && args.label.length > 0 ? args.label : null;
      if (input?.onApprovalRequired) {
        const approved = await input.onApprovalRequired(command, runId, {
          kind: "background",
          label,
        });
        if (!approved) {
          return {
            success: false,
            output: `User rejected the background command: ${command}. Do not retry it.`,
          };
        }
      }
      onProgress?.(`[tool] Spawning background: ${command}`);
      const { start: startBg } = await import("./backgroundProcessRegistry.js");
      const env = (() => {
        const { NODE_ENV: _drop, ...rest } = process.env;
        return rest;
      })();
      const r = startBg({ runId, command, cwd: resolved.cwd, label, env });
      debugLog(
        "[zone-bg-start]",
        JSON.stringify({
          runId,
          handle: r.success ? r.handle : null,
          ok: r.success,
          command: command.slice(0, 100),
          cwd: resolved.cwd,
          label,
        })
      );
      if (!r.success) {
        return { success: false, output: r.error };
      }
      return {
        success: true,
        output: JSON.stringify({
          handle: r.handle,
          pid: r.pid,
          message: r.message,
        }),
      };
    }

    if (toolName === "read_background_output") {
      const runId = String(input?.runId ?? "");
      if (!runId) {
        return { success: false, output: "background reads require a runId" };
      }
      const handle = String(args.handle ?? "");
      const sinceOffsetRaw = args.since_offset;
      const sinceOffset =
        typeof sinceOffsetRaw === "number" ? sinceOffsetRaw : null;
      const maxBytesRaw = args.max_bytes;
      const maxBytes =
        typeof maxBytesRaw === "number" ? maxBytesRaw : null;
      const { read: readBg } = await import("./backgroundProcessRegistry.js");
      const r = readBg({ runId, handle, sinceOffset, maxBytes });
      debugLog(
        "[zone-bg-read]",
        JSON.stringify({
          runId,
          handle,
          ok: r.success,
          bytes: r.success ? r.output.length : 0,
          eof: r.success ? r.eof : null,
        })
      );
      if (!r.success) {
        return { success: false, output: r.error };
      }
      return {
        success: true,
        output: JSON.stringify({
          output: r.output,
          new_offset: r.newOffset,
          eof: r.eof,
          exit_code: r.exitCode,
          truncated: r.truncated,
        }),
      };
    }

    if (toolName === "kill_background") {
      const runId = String(input?.runId ?? "");
      if (!runId) {
        return { success: false, output: "background kill requires a runId" };
      }
      const handle = String(args.handle ?? "");
      const sigRaw = args.signal;
      const signal =
        sigRaw === "SIGTERM" || sigRaw === "SIGKILL" ? sigRaw : null;
      const { kill: killBg } = await import("./backgroundProcessRegistry.js");
      const r = await killBg({ runId, handle, signal });
      debugLog(
        "[zone-bg-kill]",
        JSON.stringify({
          runId,
          handle,
          ok: r.success,
          signal,
          exitCode: r.success ? r.exitCode : null,
        })
      );
      if (!r.success) {
        return { success: false, output: r.error };
      }
      return {
        success: true,
        output: JSON.stringify({
          exit_code: r.exitCode,
          message: r.message,
        }),
      };
    }

    if (toolName === "list_background") {
      const runId = String(input?.runId ?? "");
      if (!runId) {
        return { success: false, output: "background list requires a runId" };
      }
      const { list: listBg } = await import("./backgroundProcessRegistry.js");
      const r = listBg({ runId });
      debugLog(
        "[zone-bg-list]",
        JSON.stringify({ runId, count: r.processes.length })
      );
      return {
        success: true,
        output: JSON.stringify({ processes: r.processes }),
      };
    }

    if (toolName === "read_file") {
      const filePath = resolveAgentPath(String(args.filePath || ""), repoPath, "read_file");
      onProgress?.(`[tool] Reading: ${filePath}`);
      const abs = path.join(repoPath, filePath);
      const staged = stagedRead(input?.stagingFiles, abs);
      const fullContent = staged !== null ? staged : fs.readFileSync(abs, "utf8");
      const charCount = fullContent.length;
      const lineRange = args.lineRange;

      if (lineRange != null && (!Array.isArray(lineRange) || lineRange.length !== 2)) {
        return {
          success: false,
          output: "lineRange must be [startLine, endLine] both integers",
        };
      }

      if (Array.isArray(lineRange)) {
        const [startRaw, endRaw] = lineRange.map((n) => Number(n));
        if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) {
          return {
            success: false,
            output: "lineRange must be [startLine, endLine] both integers",
          };
        }
        const lines = fullContent.split("\n");
        const start = Math.max(1, Math.floor(startRaw));
        const end = Math.min(lines.length, Math.floor(endRaw));
        if (start > end) {
          return {
            success: false,
            output: `Invalid lineRange [${start}, ${end}]: start > end`,
          };
        }
        const slicedLines = lines.slice(start - 1, end);
        const numberedSlice = prefixLineNumbers(slicedLines, start);
        debugLog("[zone-tool-readfile-smart]", JSON.stringify({
          mode: "lineRange",
          filePath,
          lineRange: [start, end],
          totalLines: lines.length,
          fullSize: charCount,
          returnedChars: numberedSlice.length,
        }));
        return {
          success: true,
          output: `[lineRange ${start}-${end} of ${lines.length} total lines from ${filePath}]\n\n${numberedSlice}`,
          contentLength: numberedSlice.length,
        };
      }

      if (charCount <= 10_000) {
        debugLog("[zone-tool-readfile-smart]", JSON.stringify({
          mode: "full-small",
          filePath,
          fullSize: charCount,
          returnedChars: charCount,
        }));
        return { success: true, output: fullContent, contentLength: charCount };
      }

      // Files >10K: head + outline + tail with line-number prefixes
      const lines = fullContent.split("\n");
      const headCount = Math.min(100, lines.length);
      const headLines = lines.slice(0, headCount);
      const tailStartIdx = Math.max(headCount, lines.length - 50);
      const tailLines = lines.slice(tailStartIdx);
      const tailStartLine = tailStartIdx + 1;
      const elidedCount = Math.max(tailStartIdx - headCount, 0);
      const outline = generateFileOutline(fullContent, filePath);
      const numberedHead = prefixLineNumbers(headLines, 1);

      const summaryParts = [
        `[FILE OUTLINE — ${filePath} is ${lines.length} lines, ${charCount} chars.]`,
        `[Use read_file({ filePath, lineRange: [start, end] }) to read specific sections.]`,
        "",
        outline || "[no top-level symbols detected]",
        "",
        `─── HEAD: lines 1-${headCount} ───`,
        numberedHead,
      ];

      if (elidedCount > 0) {
        summaryParts.push("", `─── ${elidedCount} lines elided (use lineRange) ───`);
      }

      if (tailLines.length > 0) {
        summaryParts.push(
          "",
          `─── TAIL: lines ${tailStartLine}-${lines.length} ───`,
          prefixLineNumbers(tailLines, tailStartLine)
        );
      }

      const summary = summaryParts.join("\n");

      debugLog(
        "[zone-tool-readfile-smart]",
        `[FILE OUTLINE — ${filePath}] ` + JSON.stringify({
          mode: "outline",
          filePath,
          fullSize: charCount,
          lineCount: lines.length,
          returnedChars: summary.length,
          elidedLines: elidedCount,
        })
      );
      return { success: true, output: summary, contentLength: summary.length };
    }

    if (toolName === "list_files") {
      const dirPath = resolveAgentPath(String(args.dirPath || ""), repoPath, "list_files");
      const patternRaw = args.pattern;
      const pattern =
        patternRaw === null ||
        patternRaw === undefined ||
        (typeof patternRaw === "string" && patternRaw.trim() === "")
          ? "**/*"
          : String(patternRaw);
      onProgress?.(`[tool] Listing: ${dirPath}`);
      const absDir = path.join(repoPath, dirPath);
      const entries = await fg(pattern, {
        cwd: absDir,
        dot: false,
        onlyFiles: true,
        unique: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
      });
      const limited = entries.slice(0, 100);
      const output = limited.length ? limited.join("\n") : "(no files)";
      const t = truncateText(output, 4000);
      return { success: true, output: t.text, truncated: t.truncated };
    }

    if (toolName === "apply_patch") {
      const filePath = resolveAgentPath(String(args.filePath || ""), repoPath, "apply_patch");
      const patch = String(args.patch ?? "");
      const intentRaw = String(args.intent ?? "add").toLowerCase().trim();
      const intent = intentRaw === "delete" || intentRaw === "modify" ? intentRaw : "add";
      const allowShrink = intent === "delete" || intent === "modify";
      const abs = path.join(repoPath, filePath);

      // Phase V Commit 1: read-before-patch enforcement
      if (input?.filesReadThisRun !== undefined) {
        if (!input.filesReadThisRun.has(filePath)) {
          if (input.selfValidationCounts) input.selfValidationCounts.readBeforePatchRejects += 1;
          log("[zone-self-validation]", JSON.stringify({
            rule: "read_before_patch",
            decision: "rejected",
            filePath,
            runId: input.runId ?? null,
          }));
          return {
            success: false,
            output:
              `READ_REQUIRED: You must call read_file on ${filePath} before patching. ` +
              `The file may have changed or you may be assuming the wrong content.`,
            error: "apply_patch_no_read_first",
          };
        }
        log("[zone-self-validation]", JSON.stringify({
          rule: "read_before_patch",
          decision: "approved",
          filePath,
          runId: input.runId ?? null,
        }));
      }

      // Tur P2-scope: hard-block writes that fall outside the active plan's
      // filesLikely union. Independent of the per-file escalation gate below.
      {
        const scopeError = checkWriteScope(filePath, input?.executionPlan ?? null, repoPath);
        if (scopeError) {
          onProgress?.(JSON.stringify({
            event: "zone-scope-block",
            tool: "apply_patch",
            filePath,
            reason: "out_of_plan_scope",
          }));
          debugLog("[zone-scope-block]", JSON.stringify({
            tool: "apply_patch",
            filePath,
            reason: "out_of_plan_scope",
          }));
          return {
            success: false,
            output: scopeError,
            error: "apply_patch_blocked_out_of_plan_scope",
            rejectionReason: "out_of_plan_scope",
          };
        }
      }

      if (input?.escalatedFiles?.has(filePath)) {
        const errorMsg =
          `BLOCKED: apply_patch is no longer allowed for "${filePath}". ` +
          `This file has been ESCALATED because previous apply_patch attempts failed repeatedly with the same root cause. ` +
          `You MUST use write_file with the FULL corrected file content for this file. ` +
          `Steps:\n` +
          `1. Call read_file on "${filePath}" to see the current state.\n` +
          `2. Mentally compute the FULL corrected file (every line top to bottom).\n` +
          `3. Call write_file with filePath="${filePath}" and content=<the entire corrected file>.\n` +
          `Do NOT call apply_patch on "${filePath}" again - it will be blocked.`;
        onProgress?.(JSON.stringify({
          event: "zone-tool-apply-patch-blocked-escalated",
          filePath,
          reason: "previously_escalated_after_repeated_failure",
        }));
        return {
          success: false,
          output: errorMsg,
          error: "apply_patch_blocked_escalated",
          rejectionReason: "blocked_escalated_file",
        };
      }

      onProgress?.(`[tool] Patching: ${filePath}`);

      let original: string;
      try {
        const stagedOrig = stagedRead(input?.stagingFiles, abs);
        original = stagedOrig !== null ? stagedOrig : fs.readFileSync(abs, "utf8");
      } catch {
        return {
          success: false,
          output: `File not found: ${filePath}. Use write_file to create new files.`,
        };
      }

      const fileHadBOM = original.startsWith("\uFEFF");
      const originalWithoutBom = fileHadBOM ? original.slice(1) : original;
      const fileEndedWithNewline = hasTrailingNewline(originalWithoutBom);
      const fileEolAnalysis = analyzeLineEnding(originalWithoutBom);
      const originalEol = fileEolAnalysis.detected;
      const reEncodedTo = fileEolAnalysis.dominant;

      // ─── Phase 2C: Pre-flight syntax check ──────────────────────────────────
      {
        const preflightValidation = validateSyntax(originalWithoutBom, abs);
        const scopeRequested =
          (args.scope as { symbolName?: string } | null | undefined) != null;
        if (!preflightValidation.ok && preflightValidation.reason === "parse_error") {
          debugLog(
            "[zone-apply-patch-preflight]",
            JSON.stringify({
              filePath,
              preflightOk: false,
              reason: "parse_error",
              errorLine: preflightValidation.errorLine ?? null,
              errorColumn: preflightValidation.errorColumn ?? null,
              scopeRequested,
              decision: "rejected_pre_existing_breakage",
            })
          );
          const locationHint = `line ${preflightValidation.errorLine ?? "?"}, col ${preflightValidation.errorColumn ?? "?"}`;
          const baseMsg =
            `The file is already syntactically broken at ${locationHint}: ${preflightValidation.errorMessage ?? "parse error"}.\n` +
            `This is NOT caused by your patch — the file was in this state before you started.`;
          const recoveryMsg = scopeRequested
            ? `\nTo proceed:\n` +
              `1. Read the file again with read_file.\n` +
              `2. Identify the pre-existing breakage near line ${preflightValidation.errorLine ?? "?"}.\n` +
              `3. Produce an apply_patch whose FIND block INCLUDES the broken lines and whose REPLACE block FIXES BOTH the pre-existing breakage AND your intended change.\n` +
              `4. Omit scope on this call, since scope cannot resolve symbols in an unparseable file.`
            : `\nTo proceed: read the file, locate the breakage at line ${preflightValidation.errorLine ?? "?"}, and produce a patch whose FIND/REPLACE blocks ALSO repair the broken region as part of your edit.`;
          return {
            success: false,
            output: baseMsg + recoveryMsg,
            rejectionReason: "file_already_broken_pre_patch",
          };
        }
        debugLog(
          "[zone-apply-patch-preflight]",
          JSON.stringify({
            filePath,
            preflightOk: true,
            reason: preflightValidation.reason ?? null,
            errorLine: null,
            errorColumn: null,
            scopeRequested,
            decision: "proceed",
          })
        );
      }

      debugLog(
        "[zone-apply-patch-file-preview]",
        JSON.stringify({
          filePath,
          fileContentPreviewVisibleEol: visibleEolPreview(originalWithoutBom, 200),
        })
      );

      interface FindReplaceBlock {
        find: string;
        replace: string;
      }

      const blocks: FindReplaceBlock[] = [];
      const FIND_MARKER = "--- FIND ---";
      const REPLACE_MARKER = "--- REPLACE ---";
      const findMarkerCount = (patch.match(/--- FIND ---/g) || []).length;
      const replaceMarkerCount = (patch.match(/--- REPLACE ---/g) || []).length;

      if (findMarkerCount !== replaceMarkerCount) {
        const errorMessage =
          `Your patch has ${findMarkerCount} \`${FIND_MARKER}\` marker(s) but ${replaceMarkerCount} \`${REPLACE_MARKER}\` marker(s). ` +
          `Markers must be balanced: every \`${FIND_MARKER}\` must be paired with exactly one \`${REPLACE_MARKER}\`.\n\n` +
          `If you intended to make multiple edits in this file, use the multi-block syntax:\n\n` +
          `--- FIND ---\n` +
          `<first region from file>\n` +
          `--- REPLACE ---\n` +
          `<replacement for first region>\n` +
          `--- FIND ---\n` +
          `<second region from file>\n` +
          `--- REPLACE ---\n` +
          `<replacement for second region>\n\n` +
          `Each block does ONE local substitution. Do not collapse two unrelated edits into one block.`;

        debugLog("[zone-apply-patch-marker-imbalance]", JSON.stringify({
          filePath,
          findMarkerCount,
          replaceMarkerCount,
          rejected: true,
        }));

        return {
          success: false,
          output: errorMessage,
          error: "apply_patch_marker_imbalance",
          rejectionReason: "marker_imbalance",
        };
      }

      let remaining = patch;
      let sqFindTotal = 0;
      let sqReplaceTotal = 0;
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

        // Phase V Commit 2: normalize Unicode curly quotes before FIND matching
        const { text: normalizedFind, count: sqFind } = normalizeSmartQuotes(
          findContent.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
        );
        const { text: normalizedReplace, count: sqReplace } = normalizeSmartQuotes(
          replaceContent.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
        );
        sqFindTotal += sqFind;
        sqReplaceTotal += sqReplace;

        blocks.push({
          find: normalizedFind,
          replace: normalizedReplace,
        });
        remaining = nextFindIdx === -1 ? "" : afterReplace.slice(nextFindIdx);
      }

      if (blocks.length === 0) {
        return {
          success: false,
          output:
            "No valid --- FIND --- / --- REPLACE --- blocks found in patch. " +
            "Format: --- FIND ---\n<exact code>\n--- REPLACE ---\n<code with additions>",
        };
      }

      if (sqFindTotal + sqReplaceTotal > 0) {
        if (input?.selfValidationCounts) {
          input.selfValidationCounts.smartQuoteFixes += sqFindTotal + sqReplaceTotal;
        }
        log("[zone-self-validation]", JSON.stringify({
          rule: "smart_quote_autofix",
          filePath,
          findOccurrences: sqFindTotal,
          replaceOccurrences: sqReplaceTotal,
          runId: input?.runId ?? null,
        }));
      }

      let currentNormalized = originalWithoutBom.replace(/\r\n/g, "\n");

      // ─── Step 3.5: Scope resolution (only when scope is present) ────────────
      interface ScopeArg {
        symbolName: string;
        symbolKind?: string | null;
        className?: string | null;
      }
      const scopeArg = (args.scope as ScopeArg | null | undefined) ?? null;

      type ScopeInfo = {
        normalizedStartChar: number;
        normalizedEndChar: number;
        startLine: number;
        endLine: number;
      };
      let activeScopeInfo: ScopeInfo | null = null;

      if (scopeArg !== null) {
        const kindRaw = scopeArg.symbolKind;
        const descriptor = {
          name: scopeArg.symbolName,
          kind: (kindRaw != null && kindRaw !== "" ? kindRaw : "any") as SymbolKind,
          className: scopeArg.className ?? undefined,
        };

        const locateResult = locateSymbol(originalWithoutBom, abs, descriptor);

        if (!locateResult.ok && locateResult.reason === "unsupported_extension") {
          debugLog(
            "[zone-apply-patch-scope]",
            JSON.stringify({
              filePath,
              symbolName: scopeArg.symbolName,
              symbolKind: descriptor.kind,
              className: scopeArg.className ?? null,
              scopeFound: false,
              scopeMatchCount: 0,
              scopeStartLine: null,
              scopeEndLine: null,
              decision: "fallback_unsupported_ext",
            })
          );
          // Unsupported extension — fall through to normal whole-file matching.
        } else if (!locateResult.ok && locateResult.reason === "parse_error") {
          debugLog(
            "[zone-apply-patch-scope]",
            JSON.stringify({
              filePath,
              symbolName: scopeArg.symbolName,
              symbolKind: descriptor.kind,
              className: scopeArg.className ?? null,
              scopeFound: false,
              scopeMatchCount: 0,
              scopeStartLine: null,
              scopeEndLine: null,
              decision: "rejected_parse_error",
            })
          );
          return {
            success: false,
            output:
              `Could not parse file to apply scope-bounded patch: ` +
              `${locateResult.parseErrorMessage ?? "unknown parse error"}. ` +
              `Re-read the file and verify it's syntactically valid before patching.`,
          };
        } else if (!locateResult.ok && locateResult.reason === "not_found") {
          debugLog(
            "[zone-apply-patch-scope]",
            JSON.stringify({
              filePath,
              symbolName: scopeArg.symbolName,
              symbolKind: descriptor.kind,
              className: scopeArg.className ?? null,
              scopeFound: false,
              scopeMatchCount: 0,
              scopeStartLine: null,
              scopeEndLine: null,
              decision: "rejected_not_found",
            })
          );
          return {
            success: false,
            output:
              `Scope symbol '${scopeArg.symbolName}' (kind: ${descriptor.kind}) not found in ${filePath}. ` +
              `Verify the symbol exists or remove the scope parameter.`,
          };
        } else if (locateResult.ok && locateResult.matches.length > 1) {
          const lineRanges = locateResult.matches
            .map((m) => `${m.startLine}-${m.endLine}`)
            .join(", ");
          debugLog(
            "[zone-apply-patch-scope]",
            JSON.stringify({
              filePath,
              symbolName: scopeArg.symbolName,
              symbolKind: descriptor.kind,
              className: scopeArg.className ?? null,
              scopeFound: true,
              scopeMatchCount: locateResult.matches.length,
              scopeStartLine: null,
              scopeEndLine: null,
              decision: "rejected_multi_match",
            })
          );
          return {
            success: false,
            output:
              `Scope symbol '${scopeArg.symbolName}' has ${locateResult.matches.length} occurrences ` +
              `(lines: ${lineRanges}). Pass className to disambiguate, or use a more specific symbolKind.`,
          };
        } else if (locateResult.ok && locateResult.matches.length === 1) {
          const match = locateResult.matches[0]!;
          // Convert original-content char offsets → normalized (LF-only) offsets.
          // Each \r\n before the offset in the original gets collapsed to \n, losing 1 char.
          const normStart =
            match.startChar - countCrlfsBefore(originalWithoutBom, match.startChar);
          const normEnd =
            match.endChar - countCrlfsBefore(originalWithoutBom, match.endChar);
          activeScopeInfo = {
            normalizedStartChar: normStart,
            normalizedEndChar: normEnd,
            startLine: match.startLine,
            endLine: match.endLine,
          };
          debugLog(
            "[zone-apply-patch-scope]",
            JSON.stringify({
              filePath,
              symbolName: scopeArg.symbolName,
              symbolKind: descriptor.kind,
              className: scopeArg.className ?? null,
              scopeFound: true,
              scopeMatchCount: 1,
              scopeStartLine: match.startLine,
              scopeEndLine: match.endLine,
              decision: "used_scope",
            })
          );
        }
      }

      // Tracks the end of the scoped region in normalized space; adjusted per-block.
      let currentScopeStart = activeScopeInfo?.normalizedStartChar ?? 0;
      let currentScopeEnd = activeScopeInfo?.normalizedEndChar ?? 0;

      // ─── Block loop ─────────────────────────────────────────────────────────
      for (let bi = 0; bi < blocks.length; bi += 1) {
        const block = blocks[bi]!;
        debugLog(
          "[zone-apply-patch-find-preview]",
          JSON.stringify({
            filePath,
            block: bi + 1,
            findPreviewVisibleEol: visibleEolPreview(block.find, 200),
          })
        );

        const findHadCrOnly = /\r(?!\n)/.test(block.find);
        const replaceHadCrOnly = /\r(?!\n)/.test(block.replace);
        if (findHadCrOnly || replaceHadCrOnly) {
          debugLog(
            "[zone-apply-patch-eol-warn]",
            JSON.stringify({
              filePath,
              block: bi + 1,
              reason: "cr_only_detected",
              findHadCrOnly,
              replaceHadCrOnly,
            })
          );
        }

        const normalizedFind = stripReadFilePrefix(
          block.find.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
        );
        const normalizedReplace = block.replace
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n");
        const findLineCount = normalizedFind.split("\n").length;
        const replaceLineCount = normalizedReplace.split("\n").length;

        // When scope is active, restrict searching to the symbol's region only.
        const searchTarget =
          activeScopeInfo !== null
            ? currentNormalized.slice(currentScopeStart, currentScopeEnd)
            : currentNormalized;

        const normalizedOccurrences =
          normalizedFind.length === 0
            ? 0
            : countOccurrences(searchTarget, normalizedFind);

        debugLog(
          "[zone-apply-patch-eol]",
          JSON.stringify({
            filePath,
            originalEol,
            fileHadBOM,
            fileEndedWithNewline,
            findEolBefore: detectLineEnding(block.find),
            replaceEolBefore: detectLineEnding(block.replace),
            matchedAfterNormalize: normalizedOccurrences > 0,
            occurrencesAfterNormalize: normalizedOccurrences,
            reEncodedTo,
            scopeActive: activeScopeInfo !== null,
          })
        );

        const diagBase = {
          filePath,
          block: bi + 1,
          intent,
          allowShrink,
          findBlockLength: normalizedFind.length,
          replaceBlockLength: normalizedReplace.length,
          findLineCount,
          replaceLineCount,
          findPreview: normalizedFind.slice(0, 200),
          findMatchedExactly: normalizedOccurrences === 1,
          findOccurrences: normalizedOccurrences,
        };

        if (normalizedFind.length === 0) {
          debugLog(
            "[zone-apply-patch-debug]",
            JSON.stringify({
              ...diagBase,
              rejected: true,
              rejectionReason: "find_block_empty",
            })
          );
          return {
            success: false,
            output: `Block ${bi + 1}: FIND block is empty. Provide exact lines to locate the insertion point.`,
          };
        }

        if (normalizedReplace.length === 0) {
          debugLog(
            "[zone-apply-patch-debug]",
            JSON.stringify({
              ...diagBase,
              rejected: true,
              rejectionReason: "replace_block_empty",
            })
          );
          return {
            success: false,
            output:
              `Block ${bi + 1}: REPLACE block is empty. ` +
              `If you want to delete lines, the task must explicitly request deletion.`,
          };
        }

        if (normalizedOccurrences === 0) {
          debugLog(
            "[zone-apply-patch-debug]",
            JSON.stringify({
              ...diagBase,
              rejected: true,
              rejectionReason: "find_not_found",
            })
          );
          return {
            success: false,
            output:
              `Block ${bi + 1}: FIND content not found in file` +
              (activeScopeInfo !== null
                ? ` within scope '${scopeArg?.symbolName ?? "?"}' (lines ${activeScopeInfo.startLine}-${activeScopeInfo.endLine})`
                : "") +
              `. Re-read the file with read_file and copy the exact lines (whitespace matters).\n` +
              `FIND (first 300 chars):\n${block.find.slice(0, 300)}`,
          };
        }

        if (normalizedOccurrences > 1) {
          debugLog(
            "[zone-apply-patch-debug]",
            JSON.stringify({
              ...diagBase,
              rejected: true,
              rejectionReason: "find_multiple_matches",
            })
          );
          return {
            success: false,
            output:
              `Block ${bi + 1}: FIND content matches ${normalizedOccurrences} locations` +
              (activeScopeInfo !== null
                ? ` within scope '${scopeArg?.symbolName ?? "?"}'`
                : "") +
              ` and must be unique. Include more surrounding lines to make FIND unambiguous.`,
          };
        }

        if (!allowShrink && replaceLineCount < findLineCount) {
          debugLog(
            "[zone-apply-patch-debug]",
            JSON.stringify({
              ...diagBase,
              rejected: true,
              rejectionReason: "replace_shorter_than_find",
            })
          );
          return {
            success: false,
            output:
              `Block ${bi + 1}: REPLACE has ${replaceLineCount} lines but FIND has ${findLineCount} lines. ` +
              `REPLACE must contain every line from FIND plus your additions. ` +
              `To delete lines, set intent to 'delete'. To edit or replace lines, set intent to 'modify'.`,
          };
        }

        debugLog(
          "[zone-apply-patch-debug]",
          JSON.stringify({
            ...diagBase,
            rejected: false,
            rejectionReason: null,
          })
        );

        const findDecls = extractDeclaredSymbols(normalizedFind, abs);
        const replaceDecls = extractDeclaredSymbols(normalizedReplace, abs);
        const findNames = new Set(findDecls.map((decl) => decl.name));
        const replaceNames = new Set(replaceDecls.map((decl) => decl.name));
        const removed = [...findNames].filter((name) => !replaceNames.has(name));
        const added = [...replaceNames].filter((name) => !findNames.has(name));
        const hasIdentitySwap =
          findDecls.length > 0 &&
          replaceDecls.length > 0 &&
          removed.length > 0 &&
          added.length > 0 &&
          [...findNames].every((name) => !replaceNames.has(name));

        if (hasIdentitySwap) {
          const maxBlockLength = Math.max(normalizedFind.length, normalizedReplace.length);
          const sizeRatio =
            maxBlockLength > 0
              ? Math.min(normalizedFind.length, normalizedReplace.length) / maxBlockLength
              : 1;
          const lineDelta = Math.abs(findLineCount - replaceLineCount);
          const isLikelyRename = sizeRatio >= 0.8 && lineDelta <= 1;

          if (isLikelyRename) {
            onProgress?.(JSON.stringify({
              event: "zone-tool-apply-patch-identity-swap-allowed-as-rename",
              filePath,
              block: bi + 1,
              findDeclared: [...findNames],
              replaceDeclared: [...replaceNames],
              removed,
              added,
              sizeRatio,
              lineDelta,
            }));
          } else {
            onProgress?.(JSON.stringify({
              event: "zone-tool-apply-patch-identity-swap-blocked",
              filePath,
              block: bi + 1,
              findDeclared: [...findNames],
              replaceDeclared: [...replaceNames],
              removed,
              added,
              sizeRatio,
              lineDelta,
            }));
            return {
              success: false,
              output:
                `Block ${bi + 1}: FIND declares symbol(s) [${[...findNames].join(", ")}] ` +
                `but REPLACE declares completely different symbol(s) [${[...replaceNames].join(", ")}]. ` +
                `This would DELETE [${removed.join(", ")}] and ADD [${added.join(", ")}], ` +
                `which is likely an unintended out-of-scope change. ` +
                `If you intended to rename [${removed.join(", ")}] -> [${added.join(", ")}], ` +
                `make sure the REPLACE keeps the original function body and only changes the name. ` +
                `Otherwise, target the correct symbol.`,
              error: "apply_patch_identity_swap",
              rejectionReason: "declaration_identity_swap",
            };
          }
        }

        // Apply the replacement — scoped or whole-file.
        const updatedSearchTarget = searchTarget.replace(normalizedFind, normalizedReplace);
        if (activeScopeInfo !== null) {
          currentNormalized =
            currentNormalized.slice(0, currentScopeStart) +
            updatedSearchTarget +
            currentNormalized.slice(currentScopeEnd);
          // Track end-offset shift so subsequent blocks in the same patch stay aligned.
          currentScopeEnd += updatedSearchTarget.length - searchTarget.length;
        } else {
          currentNormalized = updatedSearchTarget;
        }
      }

      let outputContent =
        reEncodedTo === "crlf"
          ? currentNormalized.replace(/\n/g, "\r\n")
          : currentNormalized;

      if (fileEndedWithNewline) {
        if (!hasTrailingNewline(outputContent)) {
          outputContent += reEncodedTo === "crlf" ? "\r\n" : "\n";
        }
      } else {
        outputContent = outputContent.replace(/(?:\r\n|\n)+$/, "");
      }

      if (fileHadBOM) {
        outputContent = "\uFEFF" + outputContent;
      }

      if (originalEol === "mixed") {
        debugLog(
          "[zone-apply-patch-eol-warn]",
          JSON.stringify({
            filePath,
            reason: "mixed_file_line_endings_normalized_to_dominant",
            originalEol,
            reEncodedTo,
            crlfCount: fileEolAnalysis.crlfCount,
            lfOnlyCount: fileEolAnalysis.lfOnlyCount,
          })
        );
      }

      if (!stagedWrite(input?.stagingFiles, abs, outputContent)) {
        fs.writeFileSync(abs, outputContent, "utf8");
      }

      // Phase V Commit 3 (V.1 fix): inline TS syntax check pre-flush.
      // Always runs for TS files; writes outputContent to a temp file so the
      // check works in both staging (content in Map, abs is original on disk)
      // and non-staging (abs already updated) paths.
      {
        const tsExt = path.extname(abs).toLowerCase();
        const isTsFile = tsExt === ".ts" || tsExt === ".tsx" || tsExt === ".cts" || tsExt === ".mts";
        if (isTsFile) {
          const tscStart = Date.now();
          let tscDecision: "approved" | "rejected" = "approved";
          let tscErrorCodes: string[] = [];
          let tscOutputForAgent: string | null = null;
          const tempTsPath = path.join(os.tmpdir(), `zone-tsc-${randomUUID()}${tsExt}`);
          try {
            fs.writeFileSync(tempTsPath, outputContent, "utf8");
            await execAsync(
              `npx tsc --noEmit --moduleResolution bundler --target es2022 --skipLibCheck "${tempTsPath}"`,
              { timeout: 5000 }
            );
          } catch (tscErr: unknown) {
            const stdout = ((tscErr as { stdout?: string }).stdout) ?? "";
            const ts1Matches = stdout.match(/TS1\d{3}/g) ?? [];
            if (ts1Matches.length > 0) {
              tscDecision = "rejected";
              tscErrorCodes = [...new Set(ts1Matches)];
              tscOutputForAgent = stdout;
            }
            // TS2xxx-only or timeout/other → approve; single-file context can't resolve imports
          } finally {
            fs.rmSync(tempTsPath, { force: true });
          }
          const tscLatencyMs = Date.now() - tscStart;
          if (input?.selfValidationCounts) {
            input.selfValidationCounts.totalLatencyMs += tscLatencyMs;
            if (tscDecision === "approved") {
              input.selfValidationCounts.inlineTsApproves += 1;
            } else {
              input.selfValidationCounts.inlineTsRejects += 1;
            }
          }
          log("[zone-self-validation]", JSON.stringify({
            rule: "inline_ts_check",
            decision: tscDecision,
            filePath,
            fileType: tsExt,
            errorCodes: tscErrorCodes,
            latencyMs: tscLatencyMs,
            runId: input?.runId ?? null,
          }));
          if (tscDecision === "rejected") {
            if (!stagedWrite(input?.stagingFiles, abs, original)) {
              fs.writeFileSync(abs, original, "utf8");
            }
            const errorLines = (tscOutputForAgent ?? "")
              .split("\n")
              .filter((l) => /TS1\d{3}/.test(l))
              .slice(0, 5)
              .map((l) => {
                const m = l.match(/\((\d+),\d+\): error (TS1\d{3}): (.+)/);
                return m ? `  Line ${m[1]}: ${m[2]} — ${m[3]}` : `  ${l}`;
              })
              .join("\n");
            return {
              success: false,
              output:
                `SYNTAX_ERROR in ${filePath} (caught pre-flush):\n${errorLines}\n` +
                `Please correct the syntax and retry the patch.`,
              rejectionReason: "inline_ts_syntax_error",
            };
          }
        } else {
          if (input?.selfValidationCounts) input.selfValidationCounts.inlineTsSkips += 1;
          log("[zone-self-validation]", JSON.stringify({
            rule: "inline_ts_check",
            decision: "skipped",
            filePath,
            fileType: path.extname(abs).toLowerCase(),
            errorCodes: [],
            latencyMs: 0,
            runId: input?.runId ?? null,
          }));
        }
      }

      // ─── Post-write syntax validation ────────────────────────────────────────
      const validation = validateSyntax(outputContent, abs);
      const syntaxBroken = !validation.ok && validation.reason === "parse_error";
      const smellValidation =
        validation.ok && validation.reason !== "unsupported_extension"
          ? checkSemanticSmells(outputContent, abs, validation.ast, original)
          : { ok: true as const };
      const semanticSmellDetected = !smellValidation.ok;
      debugLog(
        "[zone-apply-patch-syntax-validation]",
        JSON.stringify({
          filePath,
          validationOk: validation.ok,
          reason: validation.reason ?? null,
          errorLine: validation.errorLine ?? null,
          errorColumn: validation.errorColumn ?? null,
          semanticSmell: smellValidation.ok ? null : smellValidation.reason,
          semanticSmellDetails: smellValidation.ok ? null : smellValidation.details ?? null,
          reverted: syntaxBroken || semanticSmellDetected,
        })
      );
      if (syntaxBroken) {
        // Roll back to the original file content.
        if (!stagedWrite(input?.stagingFiles, abs, original)) {
          fs.writeFileSync(abs, original, "utf8");
        }
        return {
          success: false,
          output:
            `Patch applied but broke file syntax ` +
            `(line ${validation.errorLine ?? "?"}, col ${validation.errorColumn ?? "?"}): ` +
            `${validation.errorMessage ?? "parse error"}. ` +
            `The file has been reverted. Re-read the file and produce a corrected patch.`,
          rejectionReason: "syntax_broken_post_write",
        };
      }
      if (semanticSmellDetected) {
        if (!stagedWrite(input?.stagingFiles, abs, original)) {
          fs.writeFileSync(abs, original, "utf8");
        }
        return {
          success: false,
          output:
            `Patch applied but produced semantically broken output. ` +
            `The smell detected was: ${smellValidation.reason}.\n` +
            `${smellValidation.details ?? "A semantic post-write validation smell was detected."}\n` +
            `The file has been reverted. Re-read the target file, remove the conflicting old code, and produce a corrected patch.`,
          rejectionReason: "semantic_smell_post_write",
        };
      }
      // validation.reason === 'unsupported_extension'  → no AST check, accept write
      // validation.ok === true                         → syntax valid, accept write

      return {
        success: true,
        output: `Patch applied: ${blocks.length} block(s) in ${filePath}`,
      };
    }

    if (toolName === "write_file") {
      const filePath = resolveAgentPath(String(args.filePath || ""), repoPath, "write_file");
      const content = String(args.content ?? "");
      const abs = path.join(repoPath, filePath);

      // Tur P2-scope: same plan-based guard as apply_patch. Note that
      // `allowWriteFileOverwritePaths` (escalated-file override) is NOT a
      // bypass — escalation lives in a different layer and only allows the
      // shrink-guard to be skipped for files already known to need a rewrite.
      {
        const scopeError = checkWriteScope(filePath, input?.executionPlan ?? null, repoPath);
        if (scopeError) {
          onProgress?.(JSON.stringify({
            event: "zone-scope-block",
            tool: "write_file",
            filePath,
            reason: "out_of_plan_scope",
          }));
          debugLog("[zone-scope-block]", JSON.stringify({
            tool: "write_file",
            filePath,
            reason: "out_of_plan_scope",
          }));
          return {
            success: false,
            output: scopeError,
            error: "write_file_blocked_out_of_plan_scope",
            rejectionReason: "out_of_plan_scope",
          };
        }
      }

      // Shrink guard: block write_file on existing files if new content < 70% of original
      let originalSize = 0;
      let fileExists = false;
      let originalContent = "";
      try {
        const stagedPrev = stagedRead(input?.stagingFiles, abs);
        originalContent = stagedPrev !== null ? stagedPrev : fs.readFileSync(abs, "utf8");
        originalSize = originalContent.length;
        fileExists = true;
      } catch {
        // New file — no guard needed
      }
      const newSize = content.length;
      const shrinkRatio = fileExists && originalSize > 0 ? newSize / originalSize : 1;
      const overwriteOverrideAllowed = input?.allowWriteFileOverwritePaths?.has(filePath) === true;
      const blocked = fileExists && shrinkRatio < 0.7 && !overwriteOverrideAllowed;

      debugLog(
        `[zone-agent-write-debug] ${JSON.stringify({
          tool: "write_file",
          filePath,
          originalSize,
          newSize,
                    delta: newSize - originalSize,
          blocked,
          overwriteOverrideAllowed,
          reason: blocked
            ? `new content is ${Math.round(shrinkRatio * 100)}% of original (threshold: 70%)`
            : null,
        })}`
      );

      if (blocked) {
        return {
          success: false,
          output:
            `write_file blocked: new content (${newSize} chars) is only ` +
            `${Math.round(shrinkRatio * 100)}% of the original file (${originalSize} chars). ` +
            `This would delete ${originalSize - newSize} chars of existing code. ` +
            `Use apply_patch with --- FIND --- / --- REPLACE --- blocks to make targeted changes.`,
        };
      }

      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (!stagedWrite(input?.stagingFiles, abs, content)) {
        fs.writeFileSync(abs, content, "utf8");
      }

      const validation = validateSyntax(content, abs);
      const syntaxBroken = !validation.ok && validation.reason === "parse_error";
      const smellValidation =
        validation.ok && validation.reason !== "unsupported_extension"
          ? checkSemanticSmells(
              content,
              abs,
              validation.ast,
              fileExists ? originalContent : undefined
            )
          : { ok: true as const };
      const semanticSmellDetected = !smellValidation.ok;
      debugLog(
        "[zone-write-file-validation]",
        JSON.stringify({
          filePath,
          fileExistedBeforeWrite: fileExists,
          validationOk: validation.ok,
          reason: validation.reason ?? null,
          errorLine: validation.errorLine ?? null,
          errorColumn: validation.errorColumn ?? null,
          semanticSmell: smellValidation.ok ? null : smellValidation.reason,
          semanticSmellDetails: smellValidation.ok ? null : smellValidation.details ?? null,
          reverted: syntaxBroken || semanticSmellDetected,
        })
      );

      if (syntaxBroken || semanticSmellDetected) {
        if (fileExists) {
          if (!stagedWrite(input?.stagingFiles, abs, originalContent)) {
            fs.writeFileSync(abs, originalContent, "utf8");
          }
        } else {
          try {
            fs.unlinkSync(abs);
          } catch {
            // Best-effort cleanup if the new file cannot be removed.
          }
        }

        if (syntaxBroken) {
          return {
            success: false,
            output:
              `Patch applied but broke file syntax ` +
              `(line ${validation.errorLine ?? "?"}, col ${validation.errorColumn ?? "?"}): ` +
              `${validation.errorMessage ?? "parse error"}. ` +
              `The file has been reverted. Re-read the file and produce a corrected patch.`,
            rejectionReason: "syntax_broken_post_write",
          };
        }

        return {
          success: false,
          output:
            `Patch applied but produced semantically broken output. ` +
            `The smell detected was: ${smellValidation.reason}.\n` +
            `${smellValidation.details ?? "A semantic post-write validation smell was detected."}\n` +
            `The file has been reverted. Re-read the target file, remove the conflicting old code, and produce a corrected patch.`,
          rejectionReason: "semantic_smell_post_write",
        };
      }

      return {
        success: true,
        output: `File written: ${filePath} (${content.length} chars)`,
      };
    }

    if (toolName === "search_in_files") {
      const pattern = String(args.pattern ?? "");
      const literal = args.literal === true;
      const caseInsensitive = args.case_insensitive === true;
      const multiline = args.multiline === true;
      const rawMode = args.output_mode;
      const outputMode: "content" | "files_with_matches" | "count" =
        rawMode === "files_with_matches" || rawMode === "count" ? rawMode : "content";
      const contextLines =
        typeof args.context_lines === "number"
          ? Math.max(0, Math.min(Math.floor(args.context_lines), 10))
          : 2;
      // backward compat: fileGlob (old field) or glob (new field)
      const rawGlob = args.glob ?? args.fileGlob;
      const fileGlob =
        rawGlob === null ||
        rawGlob === undefined ||
        (typeof rawGlob === "string" && rawGlob.trim() === "")
          ? null
          : String(rawGlob);

      onProgress?.(`[tool] Searching: ${pattern}`);

      const rgPath = await detectRipgrep();

      if (rgPath) {
        const rgArgs: string[] = ["--no-messages"];
        if (literal) rgArgs.push("--fixed-strings");
        if (caseInsensitive) rgArgs.push("--ignore-case");
        if (multiline) rgArgs.push("--multiline");
        if (fileGlob) rgArgs.push("--glob", fileGlob);
        rgArgs.push("--no-heading", "--color=never");

        if (outputMode === "files_with_matches") {
          rgArgs.push("--files-with-matches");
        } else if (outputMode === "count") {
          rgArgs.push("--count");
        } else {
          rgArgs.push("--json", `--context=${contextLines}`);
        }

        const escapedPattern = pattern.replace(/'/g, "'\\''");
        const escapedArgs = rgArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
        const cmd = `'${rgPath}' ${escapedArgs} -- '${escapedPattern}' .`;

        let stdout = "";
        try {
          const r = await execAsync(cmd, { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 });
          stdout = r.stdout;
        } catch (err: unknown) {
          const e = err as { code?: number; stdout?: string; stderr?: string };
          if (e.code === 1) {
            stdout = e.stdout ?? ""; // exit 1 = no matches
          } else if (e.code !== undefined) {
            return { success: false, output: `search_in_files (rg) error: ${e.stderr ?? String(err)}` };
          } else {
            return { success: false, output: `search_in_files error: ${String(err)}` };
          }
        }

        if (outputMode === "files_with_matches") {
          const files = stdout.trim() ? stdout.trim().split("\n").filter(Boolean) : [];
          const body = files.length === 0 ? "(no matches)" : files.join("\n");
          const summary = `\n---\n[search_in_files] ${files.length} file(s) matched.`;
          const t = truncateText(body + summary, 4000);
          return { success: true, output: t.text, truncated: t.truncated };
        }

        if (outputMode === "count") {
          const lines = stdout.trim() ? stdout.trim().split("\n").filter(Boolean) : [];
          const pairs: Array<[string, number]> = [];
          let total = 0;
          for (const line of lines) {
            const lastColon = line.lastIndexOf(":");
            if (lastColon === -1) continue;
            const n = parseInt(line.slice(lastColon + 1), 10);
            if (!isNaN(n)) { pairs.push([line.slice(0, lastColon), n]); total += n; }
          }
          pairs.sort((a, b) => b[1] - a[1]);
          const body = pairs.length === 0 ? "(no matches)" : pairs.map(([f, c]) => `${f}: ${c}`).join("\n");
          const summary = `\n---\n[search_in_files] ${total} matches across ${pairs.length} file(s).`;
          const t = truncateText(body + summary, 4000);
          return { success: true, output: t.text, truncated: t.truncated };
        }

        return parseRgJsonContent(stdout, 500);
      }

      // In-process fallback (no ripgrep available)
      let matcher: (line: string) => boolean;
      if (literal) {
        const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
        matcher = (line) => (caseInsensitive ? line.toLowerCase() : line).includes(needle);
      } else {
        let re: RegExp;
        try {
          re = new RegExp(pattern, caseInsensitive ? "i" : "");
        } catch (e) {
          return { success: false, output: `Invalid regex pattern: ${String(e)}` };
        }
        matcher = (line) => re.test(line);
      }

      const globPattern = fileGlob ?? "**/*";
      const files = await fg(globPattern, {
        cwd: repoPath,
        dot: false,
        onlyFiles: true,
        unique: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
      });

      if (outputMode === "files_with_matches") {
        const matchedFiles: string[] = [];
        for (const rel of files) {
          let text = "";
          try {
            const abs = path.join(repoPath, rel);
            const staged = stagedRead(input?.stagingFiles, abs);
            text = staged !== null ? staged : fs.readFileSync(abs, "utf8");
          } catch { continue; }
          if (text.split(/\r?\n/).some((l) => matcher(l))) matchedFiles.push(rel);
        }
        const body = matchedFiles.length === 0 ? "(no matches)" : matchedFiles.join("\n");
        const summary = `\n---\n[search_in_files] ${matchedFiles.length} file(s) matched.`;
        const t = truncateText(body + summary, 4000);
        return { success: true, output: t.text, truncated: t.truncated };
      }

      const contentMatches: string[] = [];
      const matchCountsByFile = new Map<string, number>();
      const maxMatches = 500;
      let totalMatches = 0;
      let capReached = false;

      for (const rel of files) {
        if (totalMatches >= maxMatches) { capReached = true; break; }
        let text = "";
        try {
          const searchAbs = path.join(repoPath, rel);
          const stagedSearch = stagedRead(input?.stagingFiles, searchAbs);
          text = stagedSearch !== null ? stagedSearch : fs.readFileSync(searchAbs, "utf8");
        } catch { continue; }

        const lines = text.split(/\r?\n/);
        const fileMatchLines: number[] = [];
        for (let i = 0; i < lines.length; i += 1) {
          if (matcher(lines[i] ?? "")) {
            fileMatchLines.push(i + 1);
            matchCountsByFile.set(rel, (matchCountsByFile.get(rel) ?? 0) + 1);
            totalMatches += 1;
            if (totalMatches >= maxMatches) break;
          }
        }
        if (outputMode !== "count") {
          contentMatches.push(...formatSearchContextBlock(rel, lines, fileMatchLines, contextLines));
        }
        if (totalMatches >= maxMatches) capReached = true;
      }

      if (outputMode === "count") {
        const pairs = [...matchCountsByFile.entries()].sort((a, b) => b[1] - a[1]);
        const total = [...matchCountsByFile.values()].reduce((a, b) => a + b, 0);
        const body = pairs.length === 0 ? "(no matches)" : pairs.map(([f, c]) => `${f}: ${c}`).join("\n");
        const summary = `\n---\n[search_in_files] ${total} matches across ${pairs.length} file(s).`;
        const t = truncateText(body + summary, 4000);
        return { success: true, output: t.text, truncated: t.truncated };
      }

      const matchedFileCount = matchCountsByFile.size;
      const topFiles = [...matchCountsByFile.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5);
      const summaryLines = [
        "---",
        `[search_in_files] Found ${totalMatches} matches across ${matchedFileCount} files.`,
        "Top files by match count:",
        ...(topFiles.length > 0
          ? topFiles.map(([file, count]) => `  - ${file}: ${count} matches`)
          : ["  (none)"]),
      ];
      if (capReached) {
        summaryLines.push(
          `WARNING: CAP REACHED at ${maxMatches} matches — there may be more results. ` +
            "Narrow your pattern or add a glob filter for completeness."
        );
      }
      const summaryBlock = summaryLines.join("\n");
      let matchSection = contentMatches.length ? contentMatches.join("\n") : "(no matches)";
      const summaryBudget = 4000 - summaryBlock.length - 2;
      if (summaryBudget > 0 && matchSection.length > summaryBudget) {
        matchSection = truncateText(matchSection, summaryBudget).text;
      }
      const out = `${matchSection}\n\n${summaryBlock}`;
      const t = truncateText(out, 4000);
      return { success: true, output: t.text, truncated: t.truncated };
    }

    if (toolName === "verify_visual") {
      const visualInput = args as unknown as VerifyVisualInput;
      const config = getDevServerConfig();
      const visualPath = String(visualInput.path || "/");
      onProgress?.(`[tool] Visual verify: ${visualPath}`);

      const reachable = await probeDevServer(config.baseUrl);
      if (!reachable) {
        return {
          success: false,
          output:
            `Dev server not reachable at ${config.baseUrl}. Make sure your dev server is running ` +
            "(e.g. `npm run dev`). Configure URL in Settings -> Visual verification.",
        };
      }

      // Phase I.2: when the agent omits viewport, fall back to the user's
      // configured default from Settings (rather than the hardcoded
      // 1280x720 in verifyVisual.ts).
      const viewportForRun =
        visualInput.viewport && visualInput.viewport.width && visualInput.viewport.height
          ? visualInput.viewport
          : config.defaultViewport;

      const result = await runVerifyVisual(
        { ...visualInput, path: visualPath, viewport: viewportForRun },
        {
          devServerBaseUrl: config.baseUrl,
          runId: String(input?.runId || "unknown"),
          screenshotCount: Number(input?.visualScreenshotCount || 0),
        }
      );

      if (!result.success) {
        return {
          success: false,
          output: `verify_visual failed: ${result.error}`,
        };
      }

      const consoleSection =
        result.consoleErrors && result.consoleErrors.length > 0
          ? `\n\nConsole errors detected:\n${result.consoleErrors.map((e) => `  - ${e}`).join("\n")}`
          : "";

      debugLog("[zone-tool-verify-visual]", JSON.stringify({
        path: visualPath,
        baseUrl: config.baseUrl,
        screenshotPath: result.screenshotPath,
        pageTitle: result.pageTitle,
        consoleErrorCount: result.consoleErrors?.length ?? 0,
      }));

      return {
        success: true,
        output:
          `Screenshot taken: ${visualPath} (page title: "${result.pageTitle ?? ""}"). ` +
          `Saved to ${result.screenshotPath}.${consoleSection}`,
        metadata: {
          screenshotPath: result.screenshotPath,
          pageTitle: result.pageTitle,
          path: visualPath,
          ...(result.consoleErrors && result.consoleErrors.length > 0
            ? { consoleErrors: result.consoleErrors }
            : {}),
        },
      };
    }

    if (toolName === "find_references") {
      const sourceFile = resolveAgentPath(String(args.sourceFile || ""), repoPath, "find_references");
      const symbolName = String(args.symbolName || "").trim();

      if (!symbolName) {
        return { success: false, output: "symbolName is required" };
      }

      onProgress?.(`[tool] Finding references to ${symbolName} from ${sourceFile}`);

      const { buildDependencyGraph } = await import("../repo/buildDependencyGraph.js");
      const allFiles = await fg("**/*.{ts,tsx,js,jsx,mjs,cjs}", {
        cwd: repoPath,
        dot: false,
        onlyFiles: true,
        unique: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
      });

      const graph = await buildDependencyGraph(repoPath, allFiles);
      const sourceKey = sourceFile.replace(/\\/g, "/");
      const sourceNode = graph.nodes.get(sourceKey);

      if (!sourceNode) {
        return {
          success: false,
          output:
            `Source file not found in dependency graph: ${sourceFile}. ` +
            "Verify the path is relative to repo root and the file exists. " +
            `Available files (sample): ${[...graph.nodes.keys()].slice(0, 5).join(", ")}`,
        };
      }

      const consumers: Array<{ file: string; alias: string | null }> = [];
      for (const importerPath of sourceNode.importedBy) {
        const importerNode = graph.nodes.get(importerPath);
        if (!importerNode) continue;
        const symbols = importerNode.importedSymbolsBySource.get(sourceKey) ?? [];
        for (const s of symbols) {
          if (s.name === symbolName || (s.kind === "named" && s.alias === symbolName)) {
            consumers.push({
              file: importerPath,
              alias: s.alias && s.alias !== symbolName ? s.alias : null,
            });
            break;
          }
        }
      }

      const MAX_FIND_REFERENCES_RESULTS = 50;
      const truncated = consumers.length > MAX_FIND_REFERENCES_RESULTS;
      const capped = consumers.slice(0, MAX_FIND_REFERENCES_RESULTS);

      debugLog("[zone-tool-find-references]", JSON.stringify({
        sourceFile: sourceKey,
        symbolName,
        consumerCount: consumers.length,
        capped: truncated,
      }));

      if (capped.length === 0) {
        return {
          success: true,
          output: `No files import "${symbolName}" from ${sourceFile}.`,
        };
      }

      const lines = [
        `Found ${consumers.length} file(s) importing "${symbolName}" from ${sourceFile}${truncated ? ` (showing first ${MAX_FIND_REFERENCES_RESULTS})` : ""}:`,
        "",
        ...capped.map((c) =>
          c.alias
            ? `  ${c.file}  (imported as: ${c.alias})`
            : `  ${c.file}`
        ),
        "",
        `Note: This shows files that IMPORT the symbol. To find call/usage sites within those files, ` +
          `read each file and search for "${symbolName}" or its alias.`,
      ];

      return { success: true, output: lines.join("\n") };
    }

    if (toolName === "update_memory") {
      const entry = String(args.entry || "").trim();
      const reason = String(args.reason || "").trim();
      if (!entry) {
        return { success: false, output: "update_memory: entry is required" };
      }
      if (entry.length > 200) {
        return {
          success: false,
          output: `update_memory: entry too long (${entry.length}/200). Rephrase as a single short sentence.`,
        };
      }
      if (!reason) {
        return {
          success: false,
          output:
            "update_memory: reason is required — explain why this isn't obvious from the repo structure.",
        };
      }
      const { appendMemory } = await import("../memory/projectMemory.js");
      const saved = await appendMemory(repoPath, entry);
      console.log(
        `[zone-memory] entry added: "${saved.text}" — reason: ${reason}`
      );
      onProgress?.(`[tool] Saved memory: ${saved.text}`);
      return {
        success: true,
        output: `Saved to project memory:\n  - [${saved.date}] ${saved.text}\n\nThis convention will be injected into future Zone agent prompts on this repo.`,
      };
    }

    return {
      success: false,
      output: `Unknown tool: ${toolName}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: msg, error: msg };
  }
}
