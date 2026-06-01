import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  expandAlias,
  parseTsconfigPaths,
  type PathAliasConfig,
} from "./parseTsconfigPaths.js";

// ─── Symbol-level import types ───────────────────────────────────────────────

export interface ImportedSymbolDetail {
  kind: "named" | "default" | "namespace";
  /** For 'named': the exported identifier; for 'namespace': the alias; for 'default': the local binding name. */
  name: string;
  /** Only for 'named' renamed imports: import { foo as bar } → name='foo', alias='bar'. */
  alias?: string;
}

// ─── Graph interfaces ────────────────────────────────────────────────────────

export interface DependencyNode {
  filePath: string;
  imports: string[];           // resolved relative paths this file imports
  importedBy: string[];        // resolved relative paths that import this file
  exports: string[];           // direct export names declared in this file
  depth: number;               // BFS distance from nearest entry point

  /**
   * Symbol-level import breakdown, keyed by RESOLVED relative path (same format
   * as entries in `imports[]`).  Value is the list of symbols imported from that
   * source by THIS file.
   *
   * Implementation approach: Option B (two-pass).  The existing path-extraction
   * regex is kept unchanged; a second focused regex extracts the import clause
   * from the same statement, then `parseImportClause` parses named/default/
   * namespace symbols.  Cleaner than a single mega-regex and easier to maintain.
   *
   * CACHE NOTE: the cache key is based on file LIST + repoPath, not file CONTENT.
   * Within the 60 s TTL window, symbol data may be stale if a file's import
   * declarations change.  Acceptable for Phase 3B-1 — the TTL is short enough
   * for interactive use.
   *
   * 200-LINE CAP NOTE: imports beyond line 200 are silently ignored (inherited
   * limit from readHeadLines).  Barrel files with hundreds of re-exports, or
   * source files that delay their imports past line 200, will have incomplete
   * symbol maps.
   */
  importedSymbolsBySource: Map<string, ImportedSymbolDetail[]>;
}

export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  entryPoints: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CACHE = new Map<string, { graph: DependencyGraph; ts: number }>();
const TTL_MS = 60_000;
const MAX_ANALYZE = 300;
const MAX_LINES = 200;

const ENTRY_NAMES = new Set([
  "index.js", "app.js", "main.js", "server.js",
  "index.ts", "app.ts", "main.ts", "server.ts",
  "main.py", "app.py", "manage.py",
]);

const ENTRY_DIRS = ["", "src", "client/src", "server"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

function cacheKey(repoPath: string, files: string[], aliasConfig: PathAliasConfig | null): string {
  const h = createHash("sha256");
  h.update(repoPath);
  h.update("\0");
  const sorted = [...files].map(posix).sort();
  const sample = sorted.slice(0, 500).join("\n");
  h.update(sample);
  h.update(`\0${sorted.length}`);
  if (aliasConfig) {
    h.update(`\0baseUrl:${aliasConfig.baseUrl}`);
    for (const [pattern, targets] of aliasConfig.paths) {
      h.update(`\0path:${pattern}=>${targets.join("|")}`);
    }
  }
  return h.digest("hex").slice(0, 32);
}

function readHeadLines(abs: string, maxLines: number, stagingFiles?: Map<string, string>): string {
  try {
    const staged = stagingFiles?.get(path.resolve(abs));
    const buf = staged !== undefined ? staged : fs.readFileSync(abs, "utf8");
    const lines = buf.split(/\r?\n/);
    return lines.slice(0, maxLines).join("\n");
  } catch {
    return "";
  }
}

function fileSetFromList(files: string[]): Set<string> {
  return new Set(files.map((f) => posix(f)));
}

function resolveCandidatePath(
  repoPath: string,
  candidate: string,
  fileSet: Set<string>
): string | null {
  const tryPaths: string[] = [];
  const normalizedCandidate = posix(path.posix.normalize(candidate));
  const noExt = !/\.[a-z0-9]+$/i.test(path.posix.basename(normalizedCandidate));
  if (noExt) {
    tryPaths.push(
      normalizedCandidate + ".ts",
      normalizedCandidate + ".tsx",
      normalizedCandidate + ".js",
      normalizedCandidate + ".jsx",
      normalizedCandidate + ".mjs",
      normalizedCandidate + ".cjs",
      path.posix.join(normalizedCandidate, "index.ts"),
      path.posix.join(normalizedCandidate, "index.tsx"),
      path.posix.join(normalizedCandidate, "index.js"),
      path.posix.join(normalizedCandidate, "index.jsx")
    );
  }
  tryPaths.unshift(normalizedCandidate);

  for (const rel of tryPaths) {
    const n = posix(rel).replace(/^\/+/, "");
    if (fileSet.has(n)) return n;
    const abs = path.join(repoPath, n);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return n;
  }
  return null;
}

function tryResolveImport(
  repoPath: string,
  fromRel: string,
  spec: string,
  fileSet: Set<string>,
  aliasConfig: PathAliasConfig | null
): string | null {
  let s = spec.trim().replace(/^["'`]|["'`]$/g, "");
  if (!s || s.startsWith("node:")) return null;
  if (s.includes("://")) return null;
  if (!s.startsWith(".") && !s.startsWith("/")) {
    if (aliasConfig) {
      const candidates = expandAlias(s, aliasConfig);
      for (const candidate of candidates) {
        const resolved = resolveCandidatePath(repoPath, candidate, fileSet);
        if (resolved) return resolved;
      }
    }
    const bare = posix(s);
    if (fileSet.has(bare)) return bare;
    return null;
  }

  const fromDir = posix(path.posix.dirname(posix(fromRel)));
  const candidate = s.startsWith("/")
    ? posix(path.posix.normalize(s.slice(1)))
    : posix(path.posix.normalize(path.posix.join(fromDir, s)));

  return resolveCandidatePath(repoPath, candidate, fileSet);
}

// ─── Symbol clause parser ─────────────────────────────────────────────────────

/**
 * Parse an import clause string into a list of ImportedSymbolDetail entries.
 * Handles: default, namespace (* as x), named ({ a, b as c }), and combinations.
 * Never throws — returns [] on unexpected input.
 */
export function parseImportClause(clause: string): ImportedSymbolDetail[] {
  const symbols: ImportedSymbolDetail[] = [];
  const s = clause.trim();
  if (!s) return symbols;

  // Pure namespace: "* as alias"
  const nsOnly = s.match(/^\*\s+as\s+(\w+)$/);
  if (nsOnly) {
    symbols.push({ kind: "namespace", name: nsOnly[1]! });
    return symbols;
  }

  const braceStart = s.indexOf("{");
  const braceEnd = s.lastIndexOf("}");
  const hasNamedBlock = braceStart !== -1 && braceEnd > braceStart;

  let outerRemainder = s;
  let namedContent = "";

  if (hasNamedBlock) {
    namedContent = s.slice(braceStart + 1, braceEnd);
    outerRemainder = (s.slice(0, braceStart) + s.slice(braceEnd + 1))
      .replace(/,/g, " ")
      .trim();
  }

  // Parse the outer part: may be "default" and/or "* as ns"
  if (outerRemainder) {
    const nsInOuter = outerRemainder.match(/\*\s+as\s+(\w+)/);
    if (nsInOuter) {
      symbols.push({ kind: "namespace", name: nsInOuter[1]! });
      outerRemainder = outerRemainder.replace(/\*\s+as\s+\w+/, "").replace(/,/g, " ").trim();
    }
    // Whatever is left is the default binding (if it looks like an identifier)
    const defToken = outerRemainder.trim();
    if (defToken && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(defToken)) {
      symbols.push({ kind: "default", name: defToken });
    }
  }

  // Parse named bindings inside { ... }
  if (namedContent) {
    for (const part of namedContent.split(",")) {
      const token = part.trim();
      if (!token) continue;
      // Skip TS inline `type` modifiers: "type Foo" → token has a space → fails id test below
      const asParts = token.split(/\s+as\s+/);
      const rawName = asParts[0]?.trim() ?? "";
      const rawAlias = asParts[1]?.trim();
      // Must be a plain identifier (rejects "type Foo", "default", etc.)
      if (!rawName || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawName)) continue;
      const detail: ImportedSymbolDetail = { kind: "named", name: rawName };
      if (rawAlias && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawAlias)) {
        detail.alias = rawAlias;
      }
      symbols.push(detail);
    }
  }

  return symbols;
}

// ─── JS/TS import extraction (Option B two-pass) ─────────────────────────────

interface RawImport {
  spec: string;
  symbols: ImportedSymbolDetail[];
}

/**
 * Extract all JS/TS imports from source content.
 * Returns both the module specifier and any parsed symbol details.
 *
 * Approach: Option B (two-pass).
 * Pass 1: a "from-import" regex captures the full clause + path.
 *         `parseImportClause` turns the clause into ImportedSymbolDetail[].
 * Pass 2: supplementary patterns for side-effect imports, dynamic import(),
 *         and require() calls.
 * Rationale: keeps the existing path-regex intact and tested; the clause
 * parser is isolated and independently testable.
 */
function extractJsImportsWithSymbols(content: string): RawImport[] {
  const results: RawImport[] = [];
  // Track specs already emitted by the static-from pass to avoid duplicates
  // from the side-effect / dynamic passes.
  const fromSpecsSeen = new Set<string>();

  // ── Pass 1: static `import <clause> from "<spec>"` ────────────────────────
  // Uses 's' flag (dotall) so [\s\S]*? handles multi-line import braces.
  // Lazy quantifier stops at first `from` keyword — correct for the vast
  // majority of real-world import statements.
  const reStaticFrom =
    /\bimport\s+([\s\S]*?)\s+from\s+["'`]([^"'`]+)["'`]/gs;
  let m: RegExpExecArray | null;
  while ((m = reStaticFrom.exec(content)) !== null) {
    const clauseRaw = m[1]!.trim();
    const spec = m[2]!;
    let symbols: ImportedSymbolDetail[] = [];
    try {
      symbols = parseImportClause(clauseRaw);
    } catch {
      // Graceful degradation: path edge still recorded, symbols empty.
    }
    results.push({ spec, symbols });
    fromSpecsSeen.add(spec);
  }

  // ── Pass 2: side-effect imports `import "./x"` ────────────────────────────
  // These have no clause; `reStaticFrom` won't match them (no `from`).
  const reSideEffect = /\bimport\s+["'`]([^"'`]+)["'`]/g;
  while ((m = reSideEffect.exec(content)) !== null) {
    const spec = m[1]!;
    if (!fromSpecsSeen.has(spec)) {
      results.push({ spec, symbols: [] });
    }
  }

  // ── Pass 3: dynamic import("./x") — no symbol info available ─────────────
  const reDynamic = /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  while ((m = reDynamic.exec(content)) !== null) {
    results.push({ spec: m[1]!, symbols: [] });
  }

  // ── Pass 4a: destructured require `const { a, b } = require("./x")` ──────
  const destructuredSpecs = new Set<string>();
  const reDestructuredReq =
    /(?:const|let|var)\s*\{\s*([^}]+)\}\s*=\s*require\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  while ((m = reDestructuredReq.exec(content)) !== null) {
    const namesStr = m[1]!;
    const spec = m[2]!;
    const symbols: ImportedSymbolDetail[] = [];
    for (const part of namesStr.split(",")) {
      const token = part.trim();
      if (!token) continue;
      const asParts = token.split(/\s+as\s+/);
      const rawName = asParts[0]?.trim() ?? "";
      const rawAlias = asParts[1]?.trim();
      if (!rawName || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawName)) continue;
      const detail: ImportedSymbolDetail = { kind: "named", name: rawName };
      if (rawAlias && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawAlias)) {
        detail.alias = rawAlias;
      }
      symbols.push(detail);
    }
    results.push({ spec, symbols });
    destructuredSpecs.add(spec);
  }

  // ── Pass 4b: plain require `const x = require("./x")` ────────────────────
  const rePlainReq =
    /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  while ((m = rePlainReq.exec(content)) !== null) {
    const binding = m[1]!;
    const spec = m[2]!;
    if (!destructuredSpecs.has(spec)) {
      results.push({ spec, symbols: [{ kind: "default", name: binding }] });
    }
  }

  return results;
}

// ─── Keep backward-compat path-only helper (used by Python extractor) ────────

function extractJsImports(content: string): string[] {
  return extractJsImportsWithSymbols(content).map((r) => r.spec);
}

// ─── Export/Python helpers (unchanged from original) ─────────────────────────

function extractJsExports(content: string): string[] {
  const names: string[] = [];
  const re1 =
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)|export\s+class\s+([A-Za-z0-9_$]+)|export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(content)) !== null) {
    const n = m[1] || m[2] || m[3];
    if (n) names.push(n);
  }
  const re2 = /export\s*\{\s*([^}]+)\}/g;
  while ((m = re2.exec(content)) !== null) {
    const inner = m[1] || "";
    for (const part of inner.split(",")) {
      const t = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (t && /^[A-Za-z0-9_$]+$/.test(t)) names.push(t);
    }
  }
  return [...new Set(names)];
}

function extractPyImports(content: string, fromRel: string, fileSet: Set<string>): string[] {
  const out: string[] = [];
  const fromRe = /^\s*from\s+(\.+)([a-zA-Z0-9_.]*)\s+import\b/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(content)) !== null) {
    const dots = m[1] || "";
    const mod = (m[2] || "").replace(/\./g, "/");
    if (!mod && dots.length <= 1) continue;
    const fromDir = posix(path.posix.dirname(posix(fromRel)));
    let dir = fromDir;
    const up = Math.max(0, dots.length - 1);
    for (let i = 0; i < up; i += 1) {
      dir = posix(path.posix.dirname(dir || ".")) || "";
    }
    const joined = mod ? posix(path.posix.normalize(path.posix.join(dir, mod))) : dir;
    const candidates = mod
      ? [`${joined}.py`, path.posix.join(joined, "__init__.py")]
      : [`${path.posix.join(dir, "__init__.py")}`];
    for (const c of candidates) {
      const n = posix(c).replace(/^\/+/, "");
      if (fileSet.has(n)) {
        out.push(n);
        break;
      }
    }
  }
  return out;
}

function discoverEntryPoints(files: string[], fileSet: Set<string>): string[] {
  const found: string[] = [];
  for (const base of ENTRY_DIRS) {
    for (const name of ENTRY_NAMES) {
      const rel = base ? posix(path.posix.join(base, name)) : posix(name);
      if (fileSet.has(rel)) found.push(rel);
    }
  }
  return [...new Set(found)];
}

function assignDepths(nodes: Map<string, DependencyNode>, entryPoints: string[]): void {
  for (const n of nodes.values()) n.depth = 999;
  const q: string[] = [];
  for (const ep of entryPoints) {
    if (!nodes.has(ep)) continue;
    nodes.get(ep)!.depth = 0;
    q.push(ep);
  }
  while (q.length) {
    const cur = q.shift()!;
    const node = nodes.get(cur)!;
    for (const imp of node.imports) {
      const t = nodes.get(imp);
      if (!t) continue;
      if (t.depth > node.depth + 1) {
        t.depth = node.depth + 1;
        q.push(imp);
      }
    }
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function buildDependencyGraph(
  repoPath: string,
  files: string[],
  stagingFiles?: Map<string, string>,
): Promise<DependencyGraph> {
  const aliasConfig = parseTsconfigPaths(repoPath);
  const key = cacheKey(repoPath, files, aliasConfig);
  const now = Date.now();
  // Skip cache when staging is active — staged content is not reflected in the cache key
  if (!stagingFiles?.size) {
    const hit = CACHE.get(key);
    if (hit && now - hit.ts < TTL_MS) {
      return hit.graph;
    }
  }

  const posixFiles = files.map(posix);
  const fileSet = fileSetFromList(posixFiles);
  const nodes = new Map<string, DependencyNode>();
  const entryPoints = discoverEntryPoints(posixFiles, fileSet);

  let analyzed = 0;
  for (const rel of posixFiles) {
    if (analyzed >= MAX_ANALYZE) break;
    if (!/\.(m?[jt]sx?|jsx?|py)$/i.test(rel)) continue;

    const abs = path.join(repoPath, rel.split("/").join(path.sep));
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;

    analyzed += 1;
    const head = readHeadLines(abs, MAX_LINES, stagingFiles);
    let resolvedImports: string[] = [];
    let exports: string[] = [];
    // importedSymbolsBySource populated only for JS/TS files below
    const symbolsBySource = new Map<string, ImportedSymbolDetail[]>();

    if (/\.py$/i.test(rel)) {
      resolvedImports = extractPyImports(head, rel, fileSet);
      exports = [];
    } else {
      const rawImports = extractJsImportsWithSymbols(head);
      for (const { spec, symbols } of rawImports) {
        const resolved = tryResolveImport(repoPath, rel, spec, fileSet, aliasConfig);
        if (!resolved) continue;
        resolvedImports.push(resolved);
        // Merge symbols if the same source appears more than once (unusual but safe)
        const existing = symbolsBySource.get(resolved) ?? [];
        symbolsBySource.set(resolved, [...existing, ...symbols]);
      }
      // Deduplicate resolved paths
      resolvedImports = [...new Set(resolvedImports)];
      exports = extractJsExports(head);
    }

    const existing: DependencyNode =
      nodes.get(rel) ?? {
        filePath: rel,
        imports: [],
        importedBy: [],
        exports: [],
        depth: 999,
        importedSymbolsBySource: new Map(),
      };

    existing.imports = [...new Set([...existing.imports, ...resolvedImports])];
    existing.exports = [...new Set([...existing.exports, ...exports])];
    // Merge symbol maps
    for (const [src, syms] of symbolsBySource) {
      const prev = existing.importedSymbolsBySource.get(src) ?? [];
      existing.importedSymbolsBySource.set(src, [...prev, ...syms]);
    }
    nodes.set(rel, existing);

    for (const imp of resolvedImports) {
      if (!nodes.has(imp)) {
        nodes.set(imp, {
          filePath: imp,
          imports: [],
          importedBy: [],
          exports: [],
          depth: 999,
          importedSymbolsBySource: new Map(),
        });
      }
      const target = nodes.get(imp)!;
      if (!target.importedBy.includes(rel)) target.importedBy.push(rel);
    }
  }

  assignDepths(nodes, entryPoints);

  const graph: DependencyGraph = { nodes, entryPoints };
  CACHE.set(key, { graph, ts: now });
  return graph;
}
