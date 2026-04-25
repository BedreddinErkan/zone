import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

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
      finalContent: string;
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

function insertUploadNullGuard(fn: t.FunctionDeclaration): boolean {
  if (!fn.params || fn.params.length === 0) return false;
  const p0 = fn.params[0];
  if (!t.isIdentifier(p0) || p0.name !== "upload") return false;
  if (hasUploadGuardAlready(fn)) return false;

  const guard = t.ifStatement(
    t.unaryExpression("!", t.identifier("upload")),
    t.returnStatement(t.booleanLiteral(false))
  );
  fn.body.body.unshift(guard);
  return true;
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

export function tryAstPatchFallback(input: AstPatchFallbackInput): AstPatchFallbackResult {
  if (!isSupportedScriptFile(input.filePath)) {
    return { ok: false, reason: "unsupported_file_type" };
  }

  const task = String(input.task || "");
  const failedRawPatch = input.failedRawPatch;

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
    const ok = insertUploadNullGuard(fn);
    if (!ok) return { ok: false, reason: "no_change" };
    changed = true;
    summary = "Added `if (!upload) return false;` guard to isImageFile(upload).";
  } else if (supportsB) {
    const res = removeStrayOneCharIdentifierStatements(ast);
    if (res.removed === 0) return { ok: false, reason: "target_not_found" };
    if (res.removed > 1) return { ok: false, reason: "ambiguous_target" };
    changed = true;
    summary = "Removed stray one-character identifier statement.";
  }

  if (!changed) return { ok: false, reason: "no_change" };

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
    return { ok: false, reason: "unsafe_change" };
  }

  if (changedLinesEstimate === 0) {
    return { ok: false, reason: "no_change" };
  }

  return {
    ok: true,
    mode: "ast_fallback",
    finalContent: generated,
    summary,
    changedLinesEstimate,
  };
}

