import path from "node:path";
import { parse, type ParserPlugin } from "@babel/parser";
import traverseModule from "@babel/traverse";
import * as t from "@babel/types";

export interface SyntaxValidationResult {
  ok: boolean;
  reason?: "unsupported_extension" | "parse_error";
  errorMessage?: string;
  errorLine?: number;
  errorColumn?: number;
  ast?: t.File;
}

export type SemanticSmellReason =
  | "broken_template_expression"
  | "duplicate_jsx_attribute"
  | "duplicate_import_statement"
  | "inline_style_pseudo_class";

export interface SemanticSmellResult {
  ok: boolean;
  reason?: SemanticSmellReason;
  details?: string;
}

type DuplicateJsxAttributeInfo = {
  attributeName: string;
  line?: number;
};

type InlineStylePseudoClassInfo = {
  key: string;
  line?: number;
};

const traverse =
  (
    traverseModule as unknown as {
      default?: typeof traverseModule;
    }
  ).default ?? traverseModule;

const BABEL_PLUGINS: ParserPlugin[] = [
  "jsx",
  "typescript",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "optionalChaining",
  "nullishCoalescingOperator",
  "decorators-legacy",
  "topLevelAwait",
];

function isSupportedScriptExtension(filePath: string): boolean {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext);
}

function parseJsFamily(fileContent: string): t.File {
  return parse(String(fileContent ?? ""), {
    sourceType: "module",
    allowReturnOutsideFunction: true,
    errorRecovery: false,
    plugins: BABEL_PLUGINS,
  });
}

function getObjectPropertyKeyName(property: t.ObjectProperty): string | null {
  const key = property.key;
  if (t.isIdentifier(key)) return key.name;
  if (t.isStringLiteral(key)) return key.value;
  if (t.isNumericLiteral(key)) return String(key.value);
  return null;
}

export function validateSyntax(
  fileContent: string,
  filePath: string
): SyntaxValidationResult {
  if (!isSupportedScriptExtension(filePath)) {
    return { ok: true, reason: "unsupported_extension" };
  }

  try {
    const ast = parseJsFamily(fileContent);
    return { ok: true, ast };
  } catch (error) {
    const err = error as Error & { loc?: { line?: number; column?: number } };
    return {
      ok: false,
      reason: "parse_error",
      errorMessage: err?.message ?? String(error),
      errorLine: err?.loc?.line,
      errorColumn: err?.loc?.column,
    };
  }
}

export function checkSemanticSmells(
  fileContent: string,
  filePath: string,
  parsedAst?: t.File
): SemanticSmellResult {
  if (!isSupportedScriptExtension(filePath)) {
    return { ok: true };
  }

  if (/`[^`]*\$\s+\{/.test(fileContent)) {
    return {
      ok: false,
      reason: "broken_template_expression",
      details: "Found `$ {` inside a template literal. Template expressions must be written as `${...}`.",
    };
  }

  let ast = parsedAst;
  if (!ast) {
    try {
      ast = parseJsFamily(fileContent);
    } catch {
      return { ok: true };
    }
  }

  let duplicateJsxAttribute: DuplicateJsxAttributeInfo | null = null;

  traverse(ast, {
    JSXOpeningElement(path) {
      if (duplicateJsxAttribute) {
        path.stop();
        return;
      }

      const seen = new Set<string>();
      for (const attribute of path.node.attributes) {
        if (!t.isJSXAttribute(attribute)) continue;
        if (!t.isJSXIdentifier(attribute.name)) continue;
        const attributeName = attribute.name.name;
        if (seen.has(attributeName)) {
          duplicateJsxAttribute = {
            attributeName,
            line: path.node.loc?.start.line,
          };
          path.stop();
          return;
        }
        seen.add(attributeName);
      }
    },
  });

  if (duplicateJsxAttribute !== null) {
    const duplicate: DuplicateJsxAttributeInfo = duplicateJsxAttribute;
    return {
      ok: false,
      reason: "duplicate_jsx_attribute",
      details:
        `The JSX element near line ${duplicate.line ?? "?"} has ` +
        `the attribute '${duplicate.attributeName}' defined twice.`,
    };
  }

  const seenImports = new Set<string>();
  for (const node of ast.program.body) {
    if (!t.isImportDeclaration(node)) continue;
    const sourceValue = node.source.value;
    if (typeof sourceValue !== "string") continue;
    if (seenImports.has(sourceValue)) {
      return {
        ok: false,
        reason: "duplicate_import_statement",
        details: `Two top-level import statements both import from '${sourceValue}'.`,
      };
    }
    seenImports.add(sourceValue);
  }

  let inlineStylePseudoClass: InlineStylePseudoClassInfo | null = null;

  traverse(ast, {
    JSXAttribute(path) {
      if (inlineStylePseudoClass) {
        path.stop();
        return;
      }
      if (!t.isJSXIdentifier(path.node.name) || path.node.name.name !== "style") return;
      const attrValue = path.node.value;
      if (!t.isJSXExpressionContainer(attrValue)) return;
      if (!t.isObjectExpression(attrValue.expression)) return;

      for (const property of attrValue.expression.properties) {
        if (!t.isObjectProperty(property)) continue;
        const keyName = getObjectPropertyKeyName(property);
        if (!keyName?.startsWith(":")) continue;
        inlineStylePseudoClass = {
          key: keyName,
          line: property.loc?.start.line ?? path.node.loc?.start.line,
        };
        path.stop();
        return;
      }
    },
  });

  if (inlineStylePseudoClass !== null) {
    const pseudoClass: InlineStylePseudoClassInfo = inlineStylePseudoClass;
    return {
      ok: false,
      reason: "inline_style_pseudo_class",
      details:
        `Inline React style near line ${pseudoClass.line ?? "?"} uses ` +
        `pseudo-class key '${pseudoClass.key}', which does not work in plain inline style objects.`,
    };
  }

  return { ok: true };
}
