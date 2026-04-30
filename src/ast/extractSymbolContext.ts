import type { FunctionRange } from "./extractFunctionRange.js";
import { findFunctionByName } from "./extractFunctionRange.js";

export interface SymbolContext {
  targetFunction: FunctionRange;
  surroundingContext: string; // a few lines before/after for context
  fileHeader: string; // imports + top-level consts (first 20 lines)
}

export function extractSymbolContext(
  fileContent: string,
  functionName: string,
  filePath: string,
  contextLines: number = 5
): SymbolContext | null {
  const normalized = String(fileContent ?? "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const target = findFunctionByName(normalized, functionName, filePath);
  if (!target) return null;

  const header = lines.slice(0, 20).join("\n");
  const startIdx = Math.max(0, target.startLine - 1 - Math.max(0, contextLines));
  const endIdx = Math.min(lines.length, target.endLine + Math.max(0, contextLines));
  const surroundingContext = lines.slice(startIdx, endIdx).join("\n");

  return {
    targetFunction: target,
    surroundingContext,
    fileHeader: header,
  };
}

