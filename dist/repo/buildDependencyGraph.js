"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseImportClause = parseImportClause;
exports.buildDependencyGraph = buildDependencyGraph;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// ─── Constants ───────────────────────────────────────────────────────────────
const CACHE = new Map();
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
function posix(p) {
    return p.replace(/\\/g, "/");
}
function cacheKey(repoPath, files) {
    const h = (0, node_crypto_1.createHash)("sha256");
    h.update(repoPath);
    h.update("\0");
    const sorted = [...files].map(posix).sort();
    const sample = sorted.slice(0, 500).join("\n");
    h.update(sample);
    h.update(`\0${sorted.length}`);
    return h.digest("hex").slice(0, 32);
}
function readHeadLines(abs, maxLines) {
    try {
        const buf = node_fs_1.default.readFileSync(abs, "utf8");
        const lines = buf.split(/\r?\n/);
        return lines.slice(0, maxLines).join("\n");
    }
    catch {
        return "";
    }
}
function fileSetFromList(files) {
    return new Set(files.map((f) => posix(f)));
}
function tryResolveImport(repoPath, fromRel, spec, fileSet) {
    let s = spec.trim().replace(/^["'`]|["'`]$/g, "");
    if (!s || s.startsWith("node:"))
        return null;
    if (s.includes("://"))
        return null;
    if (!s.startsWith(".") && !s.startsWith("/")) {
        // bare specifier — map only if exact path exists in repo (rare)
        const bare = posix(s);
        if (fileSet.has(bare))
            return bare;
        // NOTE: tsconfig path aliases (e.g. @/controllers/foo) are NOT resolved here.
        // Such imports produce no edge. A [zone-graph-alias-unresolved] diagnostic
        // would fire here if/when alias support is added.
        return null;
    }
    const fromDir = posix(node_path_1.default.posix.dirname(posix(fromRel)));
    let candidate = s.startsWith("/")
        ? posix(node_path_1.default.posix.normalize(s.slice(1)))
        : posix(node_path_1.default.posix.normalize(node_path_1.default.posix.join(fromDir, s)));
    const tryPaths = [];
    const noExt = !/\.[a-z0-9]+$/i.test(node_path_1.default.posix.basename(candidate));
    if (noExt) {
        tryPaths.push(candidate + ".ts", candidate + ".tsx", candidate + ".js", candidate + ".jsx", candidate + ".mjs", candidate + ".cjs", node_path_1.default.posix.join(candidate, "index.ts"), node_path_1.default.posix.join(candidate, "index.tsx"), node_path_1.default.posix.join(candidate, "index.js"), node_path_1.default.posix.join(candidate, "index.jsx"));
    }
    tryPaths.unshift(candidate);
    for (const rel of tryPaths) {
        const n = posix(rel).replace(/^\/+/, "");
        if (fileSet.has(n))
            return n;
        const abs = node_path_1.default.join(repoPath, n);
        if (node_fs_1.default.existsSync(abs) && node_fs_1.default.statSync(abs).isFile())
            return n;
    }
    return null;
}
// ─── Symbol clause parser ─────────────────────────────────────────────────────
/**
 * Parse an import clause string into a list of ImportedSymbolDetail entries.
 * Handles: default, namespace (* as x), named ({ a, b as c }), and combinations.
 * Never throws — returns [] on unexpected input.
 */
function parseImportClause(clause) {
    const symbols = [];
    const s = clause.trim();
    if (!s)
        return symbols;
    // Pure namespace: "* as alias"
    const nsOnly = s.match(/^\*\s+as\s+(\w+)$/);
    if (nsOnly) {
        symbols.push({ kind: "namespace", name: nsOnly[1] });
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
            symbols.push({ kind: "namespace", name: nsInOuter[1] });
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
            if (!token)
                continue;
            // Skip TS inline `type` modifiers: "type Foo" → token has a space → fails id test below
            const asParts = token.split(/\s+as\s+/);
            const rawName = asParts[0]?.trim() ?? "";
            const rawAlias = asParts[1]?.trim();
            // Must be a plain identifier (rejects "type Foo", "default", etc.)
            if (!rawName || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawName))
                continue;
            const detail = { kind: "named", name: rawName };
            if (rawAlias && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawAlias)) {
                detail.alias = rawAlias;
            }
            symbols.push(detail);
        }
    }
    return symbols;
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
function extractJsImportsWithSymbols(content) {
    const results = [];
    // Track specs already emitted by the static-from pass to avoid duplicates
    // from the side-effect / dynamic passes.
    const fromSpecsSeen = new Set();
    // ── Pass 1: static `import <clause> from "<spec>"` ────────────────────────
    // Uses 's' flag (dotall) so [\s\S]*? handles multi-line import braces.
    // Lazy quantifier stops at first `from` keyword — correct for the vast
    // majority of real-world import statements.
    const reStaticFrom = /\bimport\s+([\s\S]*?)\s+from\s+["'`](\.[^"'`]+)["'`]/gs;
    let m;
    while ((m = reStaticFrom.exec(content)) !== null) {
        const clauseRaw = m[1].trim();
        const spec = m[2];
        let symbols = [];
        try {
            symbols = parseImportClause(clauseRaw);
        }
        catch {
            // Graceful degradation: path edge still recorded, symbols empty.
        }
        results.push({ spec, symbols });
        fromSpecsSeen.add(spec);
    }
    // ── Pass 2: side-effect imports `import "./x"` ────────────────────────────
    // These have no clause; `reStaticFrom` won't match them (no `from`).
    const reSideEffect = /\bimport\s+["'`](\.[^"'`]+)["'`]/g;
    while ((m = reSideEffect.exec(content)) !== null) {
        const spec = m[1];
        if (!fromSpecsSeen.has(spec)) {
            results.push({ spec, symbols: [] });
        }
    }
    // ── Pass 3: dynamic import("./x") — no symbol info available ─────────────
    const reDynamic = /\bimport\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g;
    while ((m = reDynamic.exec(content)) !== null) {
        results.push({ spec: m[1], symbols: [] });
    }
    // ── Pass 4a: destructured require `const { a, b } = require("./x")` ──────
    const destructuredSpecs = new Set();
    const reDestructuredReq = /(?:const|let|var)\s*\{\s*([^}]+)\}\s*=\s*require\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g;
    while ((m = reDestructuredReq.exec(content)) !== null) {
        const namesStr = m[1];
        const spec = m[2];
        const symbols = [];
        for (const part of namesStr.split(",")) {
            const token = part.trim();
            if (!token)
                continue;
            const asParts = token.split(/\s+as\s+/);
            const rawName = asParts[0]?.trim() ?? "";
            const rawAlias = asParts[1]?.trim();
            if (!rawName || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawName))
                continue;
            const detail = { kind: "named", name: rawName };
            if (rawAlias && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawAlias)) {
                detail.alias = rawAlias;
            }
            symbols.push(detail);
        }
        results.push({ spec, symbols });
        destructuredSpecs.add(spec);
    }
    // ── Pass 4b: plain require `const x = require("./x")` ────────────────────
    const rePlainReq = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g;
    while ((m = rePlainReq.exec(content)) !== null) {
        const binding = m[1];
        const spec = m[2];
        if (!destructuredSpecs.has(spec)) {
            results.push({ spec, symbols: [{ kind: "default", name: binding }] });
        }
    }
    return results;
}
// ─── Keep backward-compat path-only helper (used by Python extractor) ────────
function extractJsImports(content) {
    return extractJsImportsWithSymbols(content).map((r) => r.spec);
}
// ─── Export/Python helpers (unchanged from original) ─────────────────────────
function extractJsExports(content) {
    const names = [];
    const re1 = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)|export\s+class\s+([A-Za-z0-9_$]+)|export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g;
    let m;
    while ((m = re1.exec(content)) !== null) {
        const n = m[1] || m[2] || m[3];
        if (n)
            names.push(n);
    }
    const re2 = /export\s*\{\s*([^}]+)\}/g;
    while ((m = re2.exec(content)) !== null) {
        const inner = m[1] || "";
        for (const part of inner.split(",")) {
            const t = part.trim().split(/\s+as\s+/)[0]?.trim();
            if (t && /^[A-Za-z0-9_$]+$/.test(t))
                names.push(t);
        }
    }
    return [...new Set(names)];
}
function extractPyImports(content, fromRel, fileSet) {
    const out = [];
    const fromRe = /^\s*from\s+(\.+)([a-zA-Z0-9_.]*)\s+import\b/gm;
    let m;
    while ((m = fromRe.exec(content)) !== null) {
        const dots = m[1] || "";
        const mod = (m[2] || "").replace(/\./g, "/");
        if (!mod && dots.length <= 1)
            continue;
        const fromDir = posix(node_path_1.default.posix.dirname(posix(fromRel)));
        let dir = fromDir;
        const up = Math.max(0, dots.length - 1);
        for (let i = 0; i < up; i += 1) {
            dir = posix(node_path_1.default.posix.dirname(dir || ".")) || "";
        }
        const joined = mod ? posix(node_path_1.default.posix.normalize(node_path_1.default.posix.join(dir, mod))) : dir;
        const candidates = mod
            ? [`${joined}.py`, node_path_1.default.posix.join(joined, "__init__.py")]
            : [`${node_path_1.default.posix.join(dir, "__init__.py")}`];
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
function discoverEntryPoints(files, fileSet) {
    const found = [];
    for (const base of ENTRY_DIRS) {
        for (const name of ENTRY_NAMES) {
            const rel = base ? posix(node_path_1.default.posix.join(base, name)) : posix(name);
            if (fileSet.has(rel))
                found.push(rel);
        }
    }
    return [...new Set(found)];
}
function assignDepths(nodes, entryPoints) {
    for (const n of nodes.values())
        n.depth = 999;
    const q = [];
    for (const ep of entryPoints) {
        if (!nodes.has(ep))
            continue;
        nodes.get(ep).depth = 0;
        q.push(ep);
    }
    while (q.length) {
        const cur = q.shift();
        const node = nodes.get(cur);
        for (const imp of node.imports) {
            const t = nodes.get(imp);
            if (!t)
                continue;
            if (t.depth > node.depth + 1) {
                t.depth = node.depth + 1;
                q.push(imp);
            }
        }
    }
}
// ─── Main export ──────────────────────────────────────────────────────────────
async function buildDependencyGraph(repoPath, files) {
    const key = cacheKey(repoPath, files);
    const now = Date.now();
    const hit = CACHE.get(key);
    if (hit && now - hit.ts < TTL_MS) {
        return hit.graph;
    }
    const posixFiles = files.map(posix);
    const fileSet = fileSetFromList(posixFiles);
    const nodes = new Map();
    const entryPoints = discoverEntryPoints(posixFiles, fileSet);
    let analyzed = 0;
    for (const rel of posixFiles) {
        if (analyzed >= MAX_ANALYZE)
            break;
        if (!/\.(m?[jt]sx?|jsx?|py)$/i.test(rel))
            continue;
        const abs = node_path_1.default.join(repoPath, rel.split("/").join(node_path_1.default.sep));
        if (!node_fs_1.default.existsSync(abs) || !node_fs_1.default.statSync(abs).isFile())
            continue;
        analyzed += 1;
        const head = readHeadLines(abs, MAX_LINES);
        let resolvedImports = [];
        let exports = [];
        // importedSymbolsBySource populated only for JS/TS files below
        const symbolsBySource = new Map();
        if (/\.py$/i.test(rel)) {
            resolvedImports = extractPyImports(head, rel, fileSet);
            exports = [];
        }
        else {
            const rawImports = extractJsImportsWithSymbols(head);
            for (const { spec, symbols } of rawImports) {
                const resolved = tryResolveImport(repoPath, rel, spec, fileSet);
                if (!resolved)
                    continue;
                resolvedImports.push(resolved);
                // Merge symbols if the same source appears more than once (unusual but safe)
                const existing = symbolsBySource.get(resolved) ?? [];
                symbolsBySource.set(resolved, [...existing, ...symbols]);
            }
            // Deduplicate resolved paths
            resolvedImports = [...new Set(resolvedImports)];
            exports = extractJsExports(head);
        }
        const existing = nodes.get(rel) ?? {
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
            const target = nodes.get(imp);
            if (!target.importedBy.includes(rel))
                target.importedBy.push(rel);
        }
    }
    assignDepths(nodes, entryPoints);
    const graph = { nodes, entryPoints };
    CACHE.set(key, { graph, ts: now });
    return graph;
}
//# sourceMappingURL=buildDependencyGraph.js.map