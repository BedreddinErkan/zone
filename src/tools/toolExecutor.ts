import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import { locateSymbol, type SymbolKind } from "../ast/astSymbolLocator.js";
import {
  checkSemanticSmells,
  validateSyntax,
} from "../ast/astSyntaxValidator.js";

const execAsync = promisify(exec);
const READ_FILE_MAX_CHARS = 150_000;

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
  "find_references",
]);

// Import the definitions lazily to keep the check co-located with the executor.
// We do a synchronous inline require so the guard runs before any server code.
(function verifyToolDispatch() {
  // Dynamically import the definitions at runtime to avoid a circular reference
  // at compile time.  If the module isn't compiled yet this is a no-op.
  let defs: Array<{ name: string }>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    defs = (require("./toolDefinitions.js") as { ZONE_TOOLS: Array<{ name: string }> })
      .ZONE_TOOLS;
  } catch {
    // dist/ not built yet — skip guard during source-only runs
    return;
  }
  for (const tool of defs) {
    if (!DISPATCHED_TOOLS.has(tool.name)) {
      throw new Error(
        `FATAL: Tool '${tool.name}' is defined in toolDefinitions but has no executor dispatch. ` +
          `Add a 'if (toolName === "${tool.name}") { ... }' branch to executeTool().`
      );
    }
  }
})();

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  truncated?: boolean;
  rejectionReason?: string;
}

function truncateText(
  text: string,
  maxChars: number
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars) + "... [truncated]", truncated: true };
}

function safeRelPath(rel: string): string {
  return String(rel || "").replace(/^[\\/]+/, "");
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

export async function executeTool(
  toolName: string,
  toolArgs: Record<string, unknown>,
  repoPath: string,
  onProgress?: (msg: string) => void,
  input?: {
    runId?: string;
    onApprovalRequired?: (command: string, runId: string) => Promise<boolean>;
  }
): Promise<ToolResult> {
  const args = (toolArgs ?? {}) as Record<string, unknown>;

  try {
    if (toolName === "run_command") {
      const command = String(args.command ?? "");
      const resolved = resolveRunCommandCwd(args.cwd, repoPath);
      if (!resolved.ok) {
        console.log("[zone-tool-runcmd-cwd-error]", {
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
      } = {
        cwd,
        timeout: 30000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      };

      if (process.platform === "win32") {
        execOptions.shell = process.env.ComSpec ?? "cmd.exe";
      } else {
        execOptions.shell = "/bin/sh";
      }

      console.log("[zone-tool-runcmd-debug]", {
        command: command.slice(0, 100),
        cwd,
        platform: process.platform,
        shellOption: execOptions.shell || "default",
      });

      const { stdout, stderr } = await execAsync(command, execOptions);
      const combined = [stdout, stderr].filter(Boolean).join("\n");
      const t = truncateText(combined || "(no output)", 4000);
      return { success: true, output: t.text, truncated: t.truncated };
    }

    if (toolName === "read_file") {
      const filePath = safeRelPath(String(args.filePath || ""));
      onProgress?.(`[tool] Reading: ${filePath}`);
      const abs = path.join(repoPath, filePath);
      const content = fs.readFileSync(abs, "utf8");
      const chunk = content.slice(0, READ_FILE_MAX_CHARS);
      const remainingChars = Math.max(content.length - chunk.length, 0);
      const wasTruncated = remainingChars > 0;
      const warning = wasTruncated
        ? `[FILE TRUNCATED — read ${chunk.length} of ${content.length} chars from the start; remaining ${remainingChars} chars NOT shown. The file is too large to read in one call. Use search_in_files to find the section you need, then ask the user to break the task into smaller scopes if necessary.]\n\n`
        : "";

      console.log("[zone-tool-readfile-debug]", JSON.stringify({
        filePath,
        fullSize: content.length,
        returnedChars: chunk.length,
        wasTruncated,
        limit: READ_FILE_MAX_CHARS,
      }));
      if (wasTruncated) {
        console.log("[zone-tool-readfile-truncated]", JSON.stringify({
          filePath,
          fullSize: content.length,
          returnedChars: chunk.length,
          remainingChars,
        }));
      }
      return {
        success: true,
        output: warning + chunk,
        truncated: wasTruncated,
      };
    }

    if (toolName === "list_files") {
      const dirPath = safeRelPath(String(args.dirPath || ""));
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
      const filePath = safeRelPath(String(args.filePath || ""));
      const patch = String(args.patch ?? "");
      const intentRaw = String(args.intent ?? "add").toLowerCase().trim();
      const intent = intentRaw === "delete" || intentRaw === "modify" ? intentRaw : "add";
      const allowShrink = intent === "delete" || intent === "modify";
      const abs = path.join(repoPath, filePath);

      onProgress?.(`[tool] Patching: ${filePath}`);

      let original: string;
      try {
        original = fs.readFileSync(abs, "utf8");
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
          console.log(
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
        console.log(
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

      console.log(
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
      let remaining = patch;
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

      if (blocks.length === 0) {
        return {
          success: false,
          output:
            "No valid --- FIND --- / --- REPLACE --- blocks found in patch. " +
            "Format: --- FIND ---\n<exact code>\n--- REPLACE ---\n<code with additions>",
        };
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
          console.log(
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
          console.log(
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
          console.log(
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
          console.log(
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
          console.log(
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
        console.log(
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
          console.log(
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

        const normalizedFind = block.find.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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

        console.log(
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
          console.log(
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
          console.log(
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
          console.log(
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
          console.log(
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
          console.log(
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

        console.log(
          "[zone-apply-patch-debug]",
          JSON.stringify({
            ...diagBase,
            rejected: false,
            rejectionReason: null,
          })
        );

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
        console.log(
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

      fs.writeFileSync(abs, outputContent, "utf8");

      // ─── Post-write syntax validation ────────────────────────────────────────
      const validation = validateSyntax(outputContent, abs);
      const syntaxBroken = !validation.ok && validation.reason === "parse_error";
      const smellValidation =
        validation.ok && validation.reason !== "unsupported_extension"
          ? checkSemanticSmells(outputContent, abs, validation.ast)
          : { ok: true as const };
      const semanticSmellDetected = !smellValidation.ok;
      console.log(
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
        fs.writeFileSync(abs, original, "utf8");
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
        fs.writeFileSync(abs, original, "utf8");
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
      const filePath = safeRelPath(String(args.filePath || ""));
      const content = String(args.content ?? "");
      const abs = path.join(repoPath, filePath);

      // Shrink guard: block write_file on existing files if new content < 70% of original
      let originalSize = 0;
      let fileExists = false;
      let originalContent = "";
      try {
        originalContent = fs.readFileSync(abs, "utf8");
        originalSize = originalContent.length;
        fileExists = true;
      } catch {
        // New file — no guard needed
      }
      const newSize = content.length;
      const shrinkRatio = fileExists && originalSize > 0 ? newSize / originalSize : 1;
      const blocked = fileExists && shrinkRatio < 0.7;

      console.log(
        `[zone-agent-write-debug] ${JSON.stringify({
          tool: "write_file",
          filePath,
          originalSize,
          newSize,
                    delta: newSize - originalSize,
          blocked,
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
      fs.writeFileSync(abs, content, "utf8");

      const validation = validateSyntax(content, abs);
      const syntaxBroken = !validation.ok && validation.reason === "parse_error";
      const smellValidation =
        validation.ok && validation.reason !== "unsupported_extension"
          ? checkSemanticSmells(content, abs, validation.ast)
          : { ok: true as const };
      const semanticSmellDetected = !smellValidation.ok;
      console.log(
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
          fs.writeFileSync(abs, originalContent, "utf8");
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
      const fileGlobRaw = args.fileGlob;
      const fileGlob =
        fileGlobRaw === null ||
        fileGlobRaw === undefined ||
        (typeof fileGlobRaw === "string" && fileGlobRaw.trim() === "")
          ? "**/*"
          : String(fileGlobRaw);
      onProgress?.(`[tool] Searching: ${pattern}`);

      const files = await fg(fileGlob, {
        cwd: repoPath,
        dot: false,
        onlyFiles: true,
        unique: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
      });

      const matches: string[] = [];
      const matchCountsByFile = new Map<string, number>();
      const needle = pattern;
      const maxMatches = 500;
      let capReached = false;

      for (const rel of files) {
        if (matches.length >= maxMatches) {
          capReached = true;
          break;
        }
        let text = "";
        try {
          text = fs.readFileSync(path.join(repoPath, rel), "utf8");
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? "";
          if (needle && line.includes(needle)) {
            matches.push(`${rel}:${i + 1}: ${line}`);
            matchCountsByFile.set(rel, (matchCountsByFile.get(rel) ?? 0) + 1);
            if (matches.length >= maxMatches) break;
          }
        }
        if (matches.length >= maxMatches) {
          capReached = true;
        }
      }

      const matchedFileCount = matchCountsByFile.size;
      const topFiles = [...matchCountsByFile.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5);
      const summaryLines = [
        "---",
        `[search_in_files] Found ${matches.length} matches across ${matchedFileCount} files.`,
        "Top files by match count:",
        ...(topFiles.length > 0
          ? topFiles.map(([file, count]) => `  - ${file}: ${count} matches`)
          : ["  (none)"]),
      ];
      if (capReached) {
        summaryLines.push(
          `WARNING: CAP REACHED at ${maxMatches} matches - there may be more results. ` +
            "Narrow your pattern (use a more specific string or a fileGlob filter) for completeness."
        );
      }
      const summaryBlock = summaryLines.join("\n");
      let matchSection = matches.length ? matches.join("\n") : "(no matches)";
      const summaryBudget = 4000 - summaryBlock.length - 2;
      if (summaryBudget > 0 && matchSection.length > summaryBudget) {
        matchSection = truncateText(matchSection, summaryBudget).text;
      }
      const out = `${matchSection}\n\n${summaryBlock}`;
      const t = truncateText(out, 4000);
      return { success: true, output: t.text, truncated: t.truncated };
    }

    if (toolName === "find_references") {
      const sourceFile = safeRelPath(String(args.sourceFile || ""));
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

      console.log("[zone-tool-find-references]", JSON.stringify({
        sourceFile: sourceKey,
        symbolName,
        consumerCount: consumers.length,
      }));

      if (consumers.length === 0) {
        return {
          success: true,
          output: `No files import "${symbolName}" from ${sourceFile}.`,
        };
      }

      const lines = [
        `Found ${consumers.length} file(s) importing "${symbolName}" from ${sourceFile}:`,
        "",
        ...consumers.map((c) =>
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

    return {
      success: false,
      output: `Unknown tool: ${toolName}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: msg, error: msg };
  }
}
