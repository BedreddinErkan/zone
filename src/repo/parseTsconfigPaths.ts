import fs from "node:fs";
import path from "node:path";

export interface PathAliasConfig {
  baseUrl: string;
  paths: Map<string, string[]>;
}

const REPO_ROOTS = new WeakMap<PathAliasConfig, string>();

function posix(p: string): string {
  return p.replace(/\\/g, "/");
}

function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      if (i < input.length) out += input[i];
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i += 1;
      if (i < input.length) i += 1;
      continue;
    }

    out += ch;
  }

  return out;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function parseTsconfigPaths(repoPath: string): PathAliasConfig | null {
  const tsconfigPath = path.join(repoPath, "tsconfig.json");
  const jsconfigPath = path.join(repoPath, "jsconfig.json");
  const configPath = fs.existsSync(tsconfigPath)
    ? tsconfigPath
    : fs.existsSync(jsconfigPath)
      ? jsconfigPath
      : null;

  if (!configPath) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(fs.readFileSync(configPath, "utf8")));
  } catch (err) {
    console.warn(
      `[zone-graph-tsconfig] Failed to parse ${path.basename(configPath)}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  if (typeof root.extends === "string") {
    console.warn(
      `[zone-graph-tsconfig] ${path.basename(configPath)} extends another config; ` +
        "only local compilerOptions.paths/baseUrl are used. Backlog: follow extends chains."
    );
  }

  const compilerOptions =
    root.compilerOptions && typeof root.compilerOptions === "object"
      ? (root.compilerOptions as Record<string, unknown>)
      : {};

  const baseUrl =
    typeof compilerOptions.baseUrl === "string"
      ? path.resolve(repoPath, compilerOptions.baseUrl)
      : path.resolve(repoPath);

  const paths = new Map<string, string[]>();
  const pathsRaw = compilerOptions.paths;
  if (pathsRaw && typeof pathsRaw === "object" && !Array.isArray(pathsRaw)) {
    for (const [pattern, targetsRaw] of Object.entries(pathsRaw as Record<string, unknown>)) {
      const targets = asStringArray(targetsRaw);
      if (targets.length > 0) paths.set(pattern, targets);
    }
  }

  const config: PathAliasConfig = { baseUrl, paths };
  REPO_ROOTS.set(config, path.resolve(repoPath));
  return config;
}

function patternToRegex(pattern: string): RegExp | null {
  const starCount = [...pattern].filter((ch) => ch === "*").length;
  if (starCount > 1) return null;
  const escapeRegex = (value: string): string => value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  if (starCount === 0) return new RegExp(`^${escapeRegex(pattern)}$`);
  const [before, after] = pattern.split("*");
  return new RegExp(`^${escapeRegex(before ?? "")}(.*)${escapeRegex(after ?? "")}$`);
}

function repoRelative(absPath: string, aliasConfig: PathAliasConfig): string {
  const repoRoot = REPO_ROOTS.get(aliasConfig) ?? aliasConfig.baseUrl;
  return posix(path.relative(repoRoot, absPath)).replace(/^\/+/, "");
}

export function expandAlias(spec: string, aliasConfig: PathAliasConfig): string[] {
  const out: string[] = [];
  let matched = false;

  for (const [pattern, targets] of aliasConfig.paths) {
    const re = patternToRegex(pattern);
    if (!re) continue;
    const match = spec.match(re);
    if (!match) continue;
    matched = true;
    const replacement = match[1] ?? "";

    for (const target of targets) {
      const expanded = target.includes("*") ? target.replace(/\*/g, replacement) : target;
      out.push(repoRelative(path.resolve(aliasConfig.baseUrl, expanded), aliasConfig));
    }
  }

  const repoRoot = REPO_ROOTS.get(aliasConfig);
  if (!matched && repoRoot && path.resolve(aliasConfig.baseUrl) !== repoRoot) {
    out.push(repoRelative(path.resolve(aliasConfig.baseUrl, spec), aliasConfig));
  }

  return [...new Set(out.map((candidate) => posix(path.posix.normalize(candidate))))];
}
