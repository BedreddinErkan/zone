import path from "node:path";
import { parse } from "@babel/parser";
import traverseModule, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

export type SymbolKind =
  | "function"
  | "arrow"
  | "method"
  | "class"
  | "export_default"
  | "any";

export interface SymbolDescriptor {
  name: string;
  kind?: SymbolKind;
  className?: string;
}

export interface SymbolLocation {
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  kind: Exclude<SymbolKind, "any">;
  source: string;
}

export type LocateResult =
  | {
      ok: true;
      matches: SymbolLocation[];
    }
  | {
      ok: false;
      reason: "parse_error" | "unsupported_extension" | "not_found";
      parseErrorMessage?: string;
    };

type ConcreteSymbolKind = Exclude<SymbolKind, "any">;

type Candidate = {
  name: string;
  kind: ConcreteSymbolKind;
  className?: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  source: string;
};

const traverse =
  (
    traverseModule as unknown as {
      default?: typeof traverseModule;
    }
  ).default ?? traverseModule;

function isSupportedScriptExtension(filePath: string): boolean {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext);
}

function parseJsFamily(fileContent: string) {
  return parse(fileContent, {
    sourceType: "module",
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [
      "jsx",
      "typescript",
      "classProperties",
      "classPrivateProperties",
      "classPrivateMethods",
      "optionalChaining",
      "nullishCoalescingOperator",
      "decorators-legacy",
      "topLevelAwait",
    ],
  });
}

function buildLocation(
  fileContent: string,
  node: { loc?: t.SourceLocation | null; start?: number | null; end?: number | null },
  kind: ConcreteSymbolKind
): SymbolLocation | null {
  const startLine = node.loc?.start.line;
  const endLine = node.loc?.end.line;
  const startChar = node.start;
  const endChar = node.end;
  if (
    typeof startLine !== "number" ||
    typeof endLine !== "number" ||
    typeof startChar !== "number" ||
    typeof endChar !== "number"
  ) {
    return null;
  }
  return {
    startLine,
    endLine,
    startChar,
    endChar,
    kind,
    source: fileContent.slice(startChar, endChar),
  };
}

function pushCandidate(
  candidates: Candidate[],
  fileContent: string,
  node: { loc?: t.SourceLocation | null; start?: number | null; end?: number | null },
  name: string,
  kind: ConcreteSymbolKind,
  className?: string
): void {
  const location = buildLocation(fileContent, node, kind);
  if (!location) return;
  candidates.push({
    name,
    className,
    startLine: location.startLine,
    endLine: location.endLine,
    startChar: location.startChar,
    endChar: location.endChar,
    kind: location.kind,
    source: location.source,
  });
}

function getScopeCandidateNode<T extends t.Node>(path: NodePath<T>): T | t.ExportNamedDeclaration {
  if (path.parentPath?.isExportNamedDeclaration()) {
    return path.parentPath.node;
  }
  return path.node;
}

function identifierNameFromPattern(id: t.LVal | t.PatternLike | null | undefined): string | null {
  if (!id) return null;
  if ("type" in id && id.type === "Identifier") return id.name;
  return null;
}

function getMethodName(
  node: t.ClassMethod | t.ClassPrivateMethod
): string | null {
  if (node.type === "ClassPrivateMethod") {
    return node.key.id.name;
  }
  if (node.computed) {
    if (node.key.type === "StringLiteral") return String(node.key.value);
    if (node.key.type === "NumericLiteral") return String(node.key.value);
    if (node.key.type === "Identifier") return node.key.name;
    return null;
  }
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "StringLiteral") return String(node.key.value);
  if (node.key.type === "NumericLiteral") return String(node.key.value);
  return null;
}

function getEnclosingClassName(path: NodePath<t.ClassMethod | t.ClassPrivateMethod>): string | undefined {
  const classPath = path.findParent(
    (parentPath) => parentPath.isClassDeclaration() || parentPath.isClassExpression()
  );
  if (!classPath) return undefined;
  const node = classPath.node;
  if ("id" in node && node.id?.type === "Identifier") {
    return node.id.name;
  }
  return undefined;
}

function isInsideExportDefault(path: NodePath<t.Node>): boolean {
  return !!path.findParent((parentPath) => parentPath.isExportDefaultDeclaration());
}

function collectCandidates(fileContent: string): Candidate[] {
  const ast = parseJsFamily(fileContent);
  const candidates: Candidate[] = [];

  traverse(ast, {
    FunctionDeclaration(path) {
      if (isInsideExportDefault(path)) return;
      const name = path.node.id?.name;
      if (!name) return;
      pushCandidate(
        candidates,
        fileContent,
        getScopeCandidateNode(path),
        name,
        "function"
      );
    },

    VariableDeclaration(path) {
      for (const decl of path.node.declarations) {
        const init = decl.init;
        if (
          !init ||
          (init.type !== "ArrowFunctionExpression" &&
            init.type !== "FunctionExpression")
        ) {
          continue;
        }
        const name = identifierNameFromPattern(decl.id);
        if (!name) continue;
        pushCandidate(
          candidates,
          fileContent,
          getScopeCandidateNode(path),
          name,
          "arrow"
        );
      }
    },

    ClassDeclaration(path) {
      if (isInsideExportDefault(path)) return;
      const name = path.node.id?.name;
      if (!name) return;
      pushCandidate(
        candidates,
        fileContent,
        getScopeCandidateNode(path),
        name,
        "class"
      );
    },

    ClassMethod(path) {
      const name = getMethodName(path.node);
      if (!name) return;
      const className = getEnclosingClassName(path);
      pushCandidate(candidates, fileContent, path.node, name, "method", className);
    },

    ClassPrivateMethod(path) {
      const name = getMethodName(path.node);
      if (!name) return;
      const className = getEnclosingClassName(path);
      pushCandidate(candidates, fileContent, path.node, name, "method", className);
    },

    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      const aliases = new Set<string>(["__default__"]);

      if (
        (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") &&
        decl.id?.type === "Identifier"
      ) {
        aliases.add(decl.id.name);
      } else if (decl.type === "Identifier") {
        aliases.add(decl.name);
      }

      for (const alias of aliases) {
        pushCandidate(candidates, fileContent, path.node, alias, "export_default");
      }
    },
  });

  return candidates;
}

export function locateSymbol(
  fileContent: string,
  filePath: string,
  descriptor: SymbolDescriptor
): LocateResult {
  if (!isSupportedScriptExtension(filePath)) {
    return { ok: false, reason: "unsupported_extension" };
  }

  try {
    const candidates = collectCandidates(String(fileContent ?? ""));
    const targetName = String(descriptor.name || "").trim();
    const targetKind = descriptor.kind ?? "any";
    const targetClassName = descriptor.className?.trim();

    const matches = candidates
      .filter((candidate) => {
        if (candidate.name !== targetName) return false;
        if (targetKind !== "any" && candidate.kind !== targetKind) return false;
        if (targetClassName && candidate.className !== targetClassName) return false;
        return true;
      })
      .sort((a, b) => a.startLine - b.startLine)
      .map<SymbolLocation>((candidate) => ({
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        startChar: candidate.startChar,
        endChar: candidate.endChar,
        kind: candidate.kind,
        source: candidate.source,
      }));

    if (matches.length === 0) {
      return { ok: false, reason: "not_found" };
    }

    return { ok: true, matches };
  } catch (error) {
    return {
      ok: false,
      reason: "parse_error",
      parseErrorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
