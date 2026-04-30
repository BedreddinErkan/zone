import path from "node:path";
import type {
  DependencyGraph,
  DependencyNode,
  ImportedSymbolDetail,
} from "./buildDependencyGraph.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ImportContextOptions {
  /** Hard character cap on the returned summary string. Default: 4000. */
  maxChars?: number;
  /** Max number of forward-import entries to include. Default: 20. */
  maxForward?: number;
  /** Max number of reverse-import entries to include. Default: 20. */
  maxReverse?: number;
}

export interface ImportContextResult {
  /** The compact text block, ready to prepend to an LLM prompt. */
  summary: string;
  /** How many forward imports the primary file has in total (before cap). */
  totalForward: number;
  /** How many files import the primary file in total (before cap). */
  totalReverse: number;
}

/**
 * Build a compact, agent-readable text block describing the import ecosystem
 * of `primaryRelativePath` within the dependency graph.
 *
 * The block covers:
 *   1. Forward imports (files this file imports) with their symbol lists.
 *   2. Reverse imports (files that import this file) with their symbol lists.
 *   3. An optional symbol-specific section when `primarySymbolName` is supplied.
 *
 * All paths are normalised to POSIX separators.  The result is budget-capped
 * to `maxChars` characters so it is safe to embed directly into an LLM prompt.
 */
export function buildImportContextSummary(
  graph: DependencyGraph,
  primaryRelativePath: string,
  primarySymbolName: string | null,
  options?: ImportContextOptions
): ImportContextResult {
  const maxChars = options?.maxChars ?? 4000;
  const maxForward = options?.maxForward ?? 20;
  const maxReverse = options?.maxReverse ?? 20;

  const primary = posix(primaryRelativePath);
  const node = graph.nodes.get(primary);

  // ── Header ────────────────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`[zone-import-context] ${primary}`);
  if (primarySymbolName) {
    lines.push(`Symbol: ${primarySymbolName}`);
  }

  if (!node) {
    lines.push("(file not found in dependency graph)");
    return { summary: lines.join("\n"), totalForward: 0, totalReverse: 0 };
  }

  // ── Forward imports ───────────────────────────────────────────────────────
  const forwardAll = node.imports;
  const totalForward = forwardAll.length;
  const forwardSlice = forwardAll.slice(0, maxForward);

  lines.push("");
  lines.push(`## Imports (${totalForward} total${totalForward > maxForward ? `, showing ${maxForward}` : ""})`);
  if (forwardSlice.length === 0) {
    lines.push("  (none)");
  } else {
    for (const imp of forwardSlice) {
      const symbolsFromImp = node.importedSymbolsBySource.get(imp) ?? [];
      const symbolStr = formatSymbolList(symbolsFromImp);
      lines.push(`  ${imp}${symbolStr ? `  ← ${symbolStr}` : ""}`);
    }
    if (totalForward > maxForward) {
      lines.push(`  … and ${totalForward - maxForward} more`);
    }
  }

  // ── Reverse imports ───────────────────────────────────────────────────────
  const reverseAll = node.importedBy;
  const totalReverse = reverseAll.length;
  const reverseSlice = reverseAll.slice(0, maxReverse);

  lines.push("");
  lines.push(`## Imported by (${totalReverse} total${totalReverse > maxReverse ? `, showing ${maxReverse}` : ""})`);
  if (reverseSlice.length === 0) {
    lines.push("  (none)");
  } else {
    for (const importer of reverseSlice) {
      const importerNode = graph.nodes.get(importer);
      const symbolsUsed = importerNode
        ? (importerNode.importedSymbolsBySource.get(primary) ?? [])
        : [];
      const symbolStr = formatSymbolList(symbolsUsed);
      lines.push(`  ${importer}${symbolStr ? `  → uses: ${symbolStr}` : ""}`);
    }
    if (totalReverse > maxReverse) {
      lines.push(`  … and ${totalReverse - maxReverse} more`);
    }
  }

  // ── Symbol-specific section ───────────────────────────────────────────────
  if (primarySymbolName) {
    const consumers = findSymbolConsumers(graph, primary, primarySymbolName);
    lines.push("");
    lines.push(`## Who uses \`${primarySymbolName}\` (${consumers.length} file${consumers.length === 1 ? "" : "s"})`);
    if (consumers.length === 0) {
      lines.push("  (none found in graph)");
    } else {
      for (const c of consumers) {
        lines.push(`  ${c}`);
      }
    }
  }

  // ── Budget cap ────────────────────────────────────────────────────────────
  let summary = lines.join("\n");
  if (summary.length > maxChars) {
    summary = summary.slice(0, maxChars - 3) + "...";
  }

  return { summary, totalForward, totalReverse };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Format a list of ImportedSymbolDetail entries into a compact readable string.
 * Example: `{ kind:'named', name:'foo' }, { kind:'default', name:'Svc' }`
 *   → "default:Svc, foo"
 */
function formatSymbolList(symbols: ImportedSymbolDetail[]): string {
  if (!symbols.length) return "";
  const parts: string[] = [];
  for (const s of symbols) {
    if (s.kind === "default") {
      parts.push(`default:${s.name}`);
    } else if (s.kind === "namespace") {
      parts.push(`* as ${s.name}`);
    } else {
      // named
      parts.push(s.alias ? `${s.name} as ${s.alias}` : s.name);
    }
  }
  return parts.join(", ");
}

/**
 * Walk reverse-import edges from `sourcePath` and collect all files that
 * import the named symbol from that source.  Checks `importedSymbolsBySource`
 * on each importer node.
 */
function findSymbolConsumers(
  graph: DependencyGraph,
  sourcePath: string,
  symbolName: string
): string[] {
  const results: string[] = [];
  const sourceNode = graph.nodes.get(sourcePath);
  if (!sourceNode) return results;

  for (const importerPath of sourceNode.importedBy) {
    const importerNode = graph.nodes.get(importerPath);
    if (!importerNode) continue;
    const symbols = importerNode.importedSymbolsBySource.get(sourcePath) ?? [];
    const uses = symbols.some(
      (s) =>
        s.name === symbolName ||
        (s.kind === "named" && s.alias === symbolName)
    );
    if (uses) {
      results.push(importerPath);
    }
  }

  return results;
}
