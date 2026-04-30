"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRelatedFiles = getRelatedFiles;
function posix(p) {
    return p.replace(/\\/g, "/");
}
function dirname(p) {
    const n = posix(p);
    const i = n.lastIndexOf("/");
    return i <= 0 ? "" : n.slice(0, i);
}
function basename(p) {
    const n = posix(p);
    const i = n.lastIndexOf("/");
    return i < 0 ? n : n.slice(i + 1);
}
function stemBase(name) {
    return name.replace(/\.(test|spec)\.[m]?[jt]sx?$/i, "").replace(/\.[m]?[jt]sx?$/i, "");
}
function collectTestCandidates(targetRel, allPaths) {
    const dir = dirname(targetRel);
    const base = basename(targetRel);
    const stem = stemBase(base);
    const out = [];
    const patterns = [
        `${dir ? dir + "/" : ""}${stem}.test.ts`,
        `${dir ? dir + "/" : ""}${stem}.test.tsx`,
        `${dir ? dir + "/" : ""}${stem}.test.js`,
        `${dir ? dir + "/" : ""}${stem}.test.jsx`,
        `${dir ? dir + "/" : ""}${stem}.spec.ts`,
        `${dir ? dir + "/" : ""}${stem}.spec.tsx`,
        `${dir ? dir + "/" : ""}${stem}.spec.js`,
        `${dir ? dir + "/" : ""}${stem}.spec.jsx`,
        `${dir ? dir + "/" : ""}__tests__/${stem}.ts`,
        `${dir ? dir + "/" : ""}__tests__/${stem}.tsx`,
    ];
    for (const p of patterns) {
        const n = posix(p).replace(/^\//, "");
        if (allPaths.has(n))
            out.push(n);
    }
    return out;
}
function collectSiblings(targetRel, allPaths) {
    const dir = dirname(targetRel);
    const stem = stemBase(basename(targetRel));
    const out = [];
    for (const p of allPaths) {
        if (p === targetRel)
            continue;
        if (dirname(p) !== dir)
            continue;
        const b = basename(p);
        if (b.startsWith(stem) && /\.(ts|tsx|js|jsx)$/.test(b))
            out.push(p);
    }
    return out.slice(0, 12);
}
function getRelatedFiles(targetFiles, graph, maxResults = 8) {
    const targets = new Set(targetFiles.map(posix));
    const scored = new Map();
    const upsert = (fp, rel, score) => {
        if (targets.has(posix(fp)))
            return;
        const k = posix(fp);
        const prev = scored.get(k);
        if (!prev || score > prev.score) {
            scored.set(k, { filePath: k, relationship: rel, score });
        }
        else if (prev && score === prev.score && rel === "importedBy" && prev.relationship === "imports") {
            scored.set(k, { filePath: k, relationship: "importedBy", score });
        }
    };
    const allPaths = new Set(graph.nodes.keys());
    for (const t of targetFiles) {
        const rel = posix(t);
        const node = graph.nodes.get(rel);
        if (!node)
            continue;
        for (const imp of node.imports) {
            upsert(imp, "imports", 3);
        }
        for (const by of node.importedBy) {
            upsert(by, "importedBy", 2);
        }
        for (const sib of collectSiblings(rel, allPaths)) {
            upsert(sib, "sibling", 1);
        }
        for (const test of collectTestCandidates(rel, allPaths)) {
            upsert(test, "test", 2);
        }
    }
    return [...scored.values()]
        .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
        .slice(0, maxResults);
}
//# sourceMappingURL=getRelatedFiles.js.map