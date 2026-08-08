import fs from "node:fs";
import type { ProjectStructure, RepoFile } from "../types/project.js";

/**
 * Notes are joined into the one-line project summary that reaches the plan-generation
 * prompt on both generation paths, and that call is fully uncached — every note is paid
 * at full input rate on every plan. The cap exists for that reason, not for readability.
 * Five is where the ordering below stops carrying discrimination: tiers one and two are
 * at most four notes combined, so the cap only ever truncates the framework tier, whose
 * later members are the least surprising thing about a repository that already declared
 * its runtime, language and kind.
 */
const MAX_NOTES = 5;

interface Manifest {
  type?: unknown;
  bin?: unknown;
  exports?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

/**
 * Reads the root manifest's declared fields. Returns null when absent or unparseable —
 * a missing manifest must produce no note rather than a guessed one, since a wrong line
 * displaces every right one in a summary this short.
 */
function readManifest(files: RepoFile[]): Manifest | null {
  const entry = files.find((file) => file.path.replace(/\\/g, "/") === "package.json");
  if (!entry) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(entry.absolutePath, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Manifest) : null;
  } catch {
    return null;
  }
}

/** True when `name` is declared in either dependency map. Presence is what a manifest
 *  actually asserts; a version range is not inspected. */
function declaresDependency(manifest: Manifest | null, name: string): boolean {
  if (!manifest) return false;
  const deps = manifest.dependencies;
  const dev = manifest.devDependencies;
  return (
    (!!deps && typeof deps === "object" && name in deps) ||
    (!!dev && typeof dev === "object" && name in dev)
  );
}

export function detectProjectStructure(files: RepoFile[]): ProjectStructure {
  const filePaths = files.map((file) => file.path.replace(/\\/g, "/"));
  const has = (path: string): boolean => filePaths.includes(path);
  const someEndsWith = (suffix: string): boolean => filePaths.some((f) => f.endsWith(suffix));

  const manifest = readManifest(files);

  const hasClientFolder = filePaths.some((file) => file.startsWith("client/"));
  const hasServerFolder = filePaths.some((file) => file.startsWith("server/"));

  // A browser React app declares react-dom; a terminal UI built on Ink declares react
  // WITHOUT it. Keying on `react` alone — or on the .tsx extension, which is what used
  // to fire here — cannot tell the two apart, and this repository is the counterexample:
  // it declares react as a real production dependency, via ink, and renders to a
  // terminal. react-dom is the field that discriminates, so it is the field used.
  const isReactApp =
    declaresDependency(manifest, "react-dom") ||
    declaresDependency(manifest, "next") ||
    has("vite.config.ts") ||
    has("vite.config.js") ||
    has("next.config.js") ||
    has("next.config.mjs");

  const hasServicesPattern = filePaths.some((file) => file.includes("/services/"));
  const hasRoutesPattern = filePaths.some((file) => file.includes("/routes/"));
  const hasControllersPattern = filePaths.some((file) => file.includes("/controllers/"));

  // Deliberately NOT the declared dependency alone, unlike the frontend check above.
  // react-dom appears only in a browser React app, so its presence is conclusive; express
  // does not have that property — this repository declares it at a real version and keeps
  // one type-only import of it long after its HTTP server was deleted, so a
  // declaration-only test reports an Express backend for a CLI. Requiring the declaration
  // AND a server-shaped layout costs the occasional single-file Express app a note, which
  // is the cheaper error of the two.
  const isExpressApp =
    declaresDependency(manifest, "express") &&
    (hasRoutesPattern || hasControllersPattern || someEndsWith("server/index.ts") || someEndsWith("server/index.js"));

  const notes: string[] = [];

  // ── Tier 1: runtime and language. Most discriminating, so it goes first. ──
  if (manifest) {
    notes.push(manifest.type === "module" ? "Node.js project (ESM)" : "Node.js project (CommonJS)");
  }
  if (has("go.mod")) notes.push("Go module");
  if (has("Cargo.toml")) notes.push("Rust crate");
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) notes.push("Python project");
  if (has("pom.xml") || has("build.gradle")) notes.push("Java/JVM project");
  if (has("tsconfig.json") || someEndsWith(".ts")) notes.push("TypeScript");

  // ── Tier 2: project kind, from what the manifest declares rather than from layout. ──
  if (manifest?.bin !== undefined) notes.push("Command-line tool (declares a bin entry)");
  else if (manifest?.exports !== undefined) notes.push("Library (declares an exports map)");

  // ── Tier 3: frameworks. Least discriminating of the three, capped away first. ──
  if (isReactApp) notes.push("React frontend");
  if (declaresDependency(manifest, "ink")) notes.push("Ink terminal UI");
  if (isExpressApp) notes.push("Express backend");
  if (hasClientFolder && hasServerFolder) notes.push("Client/server split");

  return {
    isReactApp,
    isExpressApp,
    hasClientFolder,
    hasServerFolder,
    hasServicesPattern,
    hasRoutesPattern,
    hasControllersPattern,
    notes: notes.slice(0, MAX_NOTES),
  };
}
