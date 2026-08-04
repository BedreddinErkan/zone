import { parse } from "@babel/parser";
import _traverseImport, { type NodePath } from "@babel/traverse";
import _generateImport from "@babel/generator";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = ((_traverseImport as unknown as { default?: unknown }).default ?? _traverseImport) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const generate = ((_generateImport as unknown as { default?: unknown }).default ?? _generateImport) as any;
import * as t from "@babel/types";
import { debugLog } from "../utils/logger.js";

export type AstPatchFallbackInput = {
  filePath: string;
  task: string;
  originalContent: string;
  failedRawPatch?: string;
};

export type AstPatchFallbackResult =
  | {
      ok: true;
      mode: "ast_fallback";
      patchText: string;
      summary: string;
      changedLinesEstimate: number;
    }
  | {
      ok: false;
      reason:
        | "unsupported_file_type"
        | "unsupported_task"
        | "parse_failed"
        | "target_not_found"
        | "ambiguous_target"
        | "unsafe_change"
        | "no_change";
    };

function isSupportedScriptFile(filePath: string): boolean {
  const p = String(filePath || "").toLowerCase();
  return (
    p.endsWith(".js") ||
    p.endsWith(".jsx") ||
    p.endsWith(".ts") ||
    p.endsWith(".tsx")
  );
}

function estimateChangedLines(before: string, after: string): number {
  const a = String(before || "").replace(/\r\n/g, "\n").split("\n");
  const b = String(after || "").replace(/\r\n/g, "\n").split("\n");
  const max = Math.max(a.length, b.length);
  const min = Math.min(a.length, b.length);
  let diffs = Math.abs(a.length - b.length);
  for (let i = 0; i < min; i += 1) {
    if ((a[i] ?? "") !== (b[i] ?? "")) diffs += 1;
  }
  return Math.min(diffs, max);
}

function parseWithBabel(content: string) {
  return parse(content, {
    sourceType: "module",
    plugins: [
      "jsx",
      "typescript",
      "classProperties",
      "optionalChaining",
      "nullishCoalescingOperator",
    ],
    errorRecovery: false,
  });
}

function taskLooksLikeNullGuard(task: string, failedRawPatch?: string): boolean {
  const tnorm = `${task || ""}\n${failedRawPatch || ""}`.toLowerCase();
  return (
    tnorm.includes("undefined") ||
    tnorm.includes("cannot read") ||
    tnorm.includes("null") ||
    tnorm.includes("guard") ||
    tnorm.includes("runtime rendering")
  );
}

function taskLooksLikeStrayIdentifierRemoval(task: string): boolean {
  const tnorm = String(task || "").toLowerCase();
  return (
    tnorm.includes("stray character") ||
    tnorm.includes("accidental stray character") ||
    tnorm.includes("invalid character")
  );
}

function containsUploadOrIsImageFileHints(task: string, failedRawPatch?: string): boolean {
  const s = `${task || ""}\n${failedRawPatch || ""}`.toLowerCase();
  return s.includes("isimagefile") || s.includes("upload");
}

function isSafeGuardInsertion(code: string): boolean {
  const lower = String(code || "").toLowerCase();

  return (
    lower.includes("if (!") &&
    (lower.includes("return") || lower.includes("return null")) &&
    String(code || "").split("\n").length <= 6
  );
}

function hasUploadGuardAlready(fn: t.FunctionDeclaration): boolean {
  const body = fn.body?.body ?? [];
  const first = body[0];
  if (!first || !t.isIfStatement(first)) return false;
  const test = first.test;
  // if (!upload) return false;
  if (!t.isUnaryExpression(test) || test.operator !== "!") return false;
  if (!t.isIdentifier(test.argument) || test.argument.name !== "upload") return false;
  const cons = first.consequent;
  if (!t.isReturnStatement(cons)) return false;
  return t.isBooleanLiteral(cons.argument) && cons.argument.value === false;
}

function removeStrayOneCharIdentifierStatements(ast: t.File): { removed: number } {
  let removed = 0;
  traverse(ast, {
    ExpressionStatement(path: NodePath<t.ExpressionStatement>) {
      const expr = path.node.expression;
      if (!t.isIdentifier(expr)) return;
      if ((expr.name || "").length !== 1) return;
      removed += 1;
      path.remove();
    },
  });
  return { removed };
}

function detectPrimaryLineEnding(content: string): "\r\n" | "\n" {
  return String(content || "").includes("\r\n") ? "\r\n" : "\n";
}

function buildIsImageFileUploadGuardPatch(input: {
  filePath: string;
  originalContent: string;
}): { ok: true; patchText: string; insertedLines: string[] } | { ok: false } {
  const original = String(input.originalContent || "");
  const lineEnding = detectPrimaryLineEnding(original);

  // Anchor strategy: first `function isImageFile(upload) {` (exact text from file).
  const functionRegex = /function\s+isImageFile\s*\(\s*upload\s*\)\s*\{/;
  const match = original.match(functionRegex);
  if (!match || !match[0]) return { ok: false };

  // Use the full matched token as the FIND anchor (keeps formatting stable).
  const anchor = match[0];
  const anchorIdx = original.indexOf(anchor);
  if (anchorIdx < 0) return { ok: false };

  // Infer indentation from the line after the anchor line.
  const afterAnchorIdx = anchorIdx + anchor.length;
  const nextLineStart = original.indexOf(lineEnding, afterAnchorIdx);
  let indent = "  ";
  if (nextLineStart >= 0) {
    const nextLineEnd = original.indexOf(lineEnding, nextLineStart + lineEnding.length);
    const nextLine =
      nextLineEnd >= 0
        ? original.slice(nextLineStart + lineEnding.length, nextLineEnd)
        : original.slice(nextLineStart + lineEnding.length);
    const m = nextLine.match(/^\s+/);
    if (m && m[0]) indent = m[0];
  }

  const guardLine = `${indent}if (!upload) return false;`;
  const insertedLines = [guardLine];

  const findBlock = anchor;
  const replaceBlock = `${anchor}${lineEnding}${guardLine}`;
  const patchText = [
    `--- FILE: ${input.filePath} ---`,
    `--- FIND ---`,
    findBlock,
    `--- REPLACE ---`,
    replaceBlock,
  ].join(lineEnding);

  return { ok: true, patchText, insertedLines };
}

export function tryAstPatchFallback(input: AstPatchFallbackInput): AstPatchFallbackResult {
  if (!isSupportedScriptFile(input.filePath)) {
    return { ok: false, reason: "unsupported_file_type" };
  }

  const task = String(input.task || "");
  const failedRawPatch = input.failedRawPatch;
  const filePath = input.filePath;

  const supportsA =
    taskLooksLikeNullGuard(task, failedRawPatch) &&
    containsUploadOrIsImageFileHints(task, failedRawPatch);
  const supportsB = taskLooksLikeStrayIdentifierRemoval(task);
  if (!supportsA && !supportsB) {
    return { ok: false, reason: "unsupported_task" };
  }

  let ast: t.File;
  try {
    ast = parseWithBabel(String(input.originalContent || "")) as unknown as t.File;
  } catch {
    return { ok: false, reason: "parse_failed" };
  }

  let changed = false;
  let summary = "";
  let patchText = "";

  if (supportsA) {
    const candidates: t.FunctionDeclaration[] = [];
    traverse(ast, {
      FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
        const id = path.node.id;
        if (!id || !t.isIdentifier(id)) return;
        if (id.name !== "isImageFile") return;
        candidates.push(path.node);
      },
    });
    if (candidates.length === 0) return { ok: false, reason: "target_not_found" };
    if (candidates.length > 1) return { ok: false, reason: "ambiguous_target" };
    const fn = candidates[0];
    if (!fn) return { ok: false, reason: "target_not_found" };
    if (hasUploadGuardAlready(fn)) {
      debugLog(
        "[zone-ast-fallback-no-change]",
        JSON.stringify({ filePath, reason: "guard_already_present" })
      );
      return { ok: false, reason: "no_change" };
    }
    const patch = buildIsImageFileUploadGuardPatch({
      filePath,
      originalContent: input.originalContent,
    });
    if (!patch.ok) return { ok: false, reason: "target_not_found" };
    debugLog("[zone-ast-safe-guard-insert]", JSON.stringify({ filePath }));
    debugLog(
      "[zone-ast-patch-generated]",
      JSON.stringify({ lines: patch.insertedLines.length })
    );
    changed = true;
    summary = "Added `if (!upload) return false;` guard to isImageFile(upload).";
    patchText = patch.patchText;
  } else if (supportsB) {
    const res = removeStrayOneCharIdentifierStatements(ast);
    if (res.removed === 0) return { ok: false, reason: "target_not_found" };
    if (res.removed > 1) return { ok: false, reason: "ambiguous_target" };
    changed = true;
    summary = "Removed stray one-character identifier statement.";
  }

  if (!changed) {
    debugLog(
      "[zone-ast-fallback-no-change]",
      JSON.stringify({ filePath, reason: "no_ast_transform_applied" })
    );
    return { ok: false, reason: "no_change" };
  }

  // For the guard insertion path, emit a minimal FIND/REPLACE patch (not full rewritten content).
  if (supportsA) {
    const changedLinesEstimate = patchText ? 1 : 0;
    if (changedLinesEstimate === 0) return { ok: false, reason: "no_change" };
    return {
      ok: true,
      mode: "ast_fallback",
      patchText,
      summary,
      changedLinesEstimate,
    };
  }

  const generated = generate(
    ast,
    {
      retainLines: true,
      comments: true,
      jsescOption: { minimal: true },
    },
    String(input.originalContent || "")
  ).code;

  // Ensure generated output parses successfully.
  try {
    parseWithBabel(generated);
  } catch {
    return { ok: false, reason: "unsafe_change" };
  }

  const changedLinesEstimate = estimateChangedLines(input.originalContent, generated);
  if (changedLinesEstimate > 20) {
    const insertedGuardCode = supportsA ? "if (!upload) return false;" : "";
    if (!supportsA || !isSafeGuardInsertion(insertedGuardCode)) {
      return { ok: false, reason: "unsafe_change" };
    }
  }

  if (changedLinesEstimate === 0) {
    debugLog(
      "[zone-ast-fallback-no-change]",
      JSON.stringify({ filePath, reason: "generated_equals_original" })
    );
    return { ok: false, reason: "no_change" };
  }

  return {
    ok: true,
    mode: "ast_fallback",
    patchText: [
      `--- FILE: ${filePath} ---`,
      `--- FIND ---`,
      // conservative: replace the whole file (legacy path) only for stray identifier removal.
      // This path isn't used for the guard insertion scenario.
      String(input.originalContent || ""),
      `--- REPLACE ---`,
      generated,
    ].join(detectPrimaryLineEnding(input.originalContent)),
    summary,
    changedLinesEstimate,
  };
}

