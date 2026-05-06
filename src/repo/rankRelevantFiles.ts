import type { RepoFile } from "../types/project.js";
import { getIntentAwareScoreBoost } from "../core/intentAwareScore.js";
import type { TaskIntent } from "../core/taskIntentParser.js";
import { debugLog } from "../utils/logger.js";

type TaskSignal =
  | "component"
  | "style"
  | "route"
  | "endpoint"
  | "api"
  | "auth"
  | "database"
  | "config"
  | "test"
  | "bugfix"
  | "refactor";

const GENERIC_TASK_TERMS = new Set([
  "add",
  "adjust",
  "app",
  "bug",
  "change",
  "client",
  "component",
  "create",
  "error",
  "feature",
  "fix",
  "flow",
  "form",
  "frontend",
  "improve",
  "issue",
  "minimal",
  "page",
  "screen",
  "small",
  "task",
  "ui",
  "update",
  "validation",
  "view",
]);

const GENERIC_SHELL_BASENAMES = new Set(["app", "index", "layout", "main", "root"]);

function singularizeTerm(term: string): string {
  if (term.endsWith("ies") && term.length > 4) {
    return `${term.slice(0, -3)}y`;
  }

  if (term.endsWith("s") && term.length > 4 && !term.endsWith("ss")) {
    return term.slice(0, -1);
  }

  return term;
}

function extractNormalizedTerms(text: string): string[] {
  const expandedText = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const terms = expandedText
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2);

  return [...new Set(terms.flatMap((term) => [term, singularizeTerm(term)]))];
}

function getTaskEntityTerms(task: string): string[] {
  return extractNormalizedTerms(task).filter((term) => !GENERIC_TASK_TERMS.has(term));
}

function getPathTermMatches(filePath: string, taskEntityTerms: string[]): string[] {
  if (taskEntityTerms.length === 0) {
    return [];
  }

  const pathTerms = new Set(extractNormalizedTerms(filePath));
  return taskEntityTerms.filter((term) => pathTerms.has(term));
}

function extractTaskSignals(task: string): TaskSignal[] {
  const normalizedTask = task.toLowerCase();
  const signals: TaskSignal[] = [];

  const addSignal = (signal: TaskSignal, patterns: RegExp[]): void => {
    if (patterns.some((pattern) => pattern.test(normalizedTask))) {
      signals.push(signal);
    }
  };

  addSignal("component", [
    /\bcomponent\b/,
    /\bmodal\b/,
    /\bbutton\b/,
    /\bform\b/,
    /\bpage\b/,
    /\bui\b/,
    /\bview\b/,
    /\bscreen\b/,
    /\bfont\b/,
    /\bheader\b/,
    /\bh1\b/,
  ]);
  addSignal("style", [
    /\bfont\b/,
    /\bfont-size\b/,
    /\bcolor\b/,
    /\bbackground\b/,
    /\bbackground.color\b/,
    /\btext.color\b/,
    /\bcss\b/,
    /\bstyle\b/,
    /\bstyles\b/,
    /\bstyling\b/,
    /\bbutton\b/,
    /\bexecute\b/,
    /\bbtn\b/,
    /\bzone\s+header\b/,
    /\bzone\s+ui\b/,
    /\bheader\b/,
    /\bfooter\b/,
    /\blayout\b/,
    /\bspacing\b/,
    /\bmargin\b/,
    /\bpadding\b/,
    /\bborder\b/,
    /\bwidth\b/,
    /\bheight\b/,
    /\bh1\b/,
    /\bh2\b/,
    /\bh3\b/,
    /\bhtml\b/,
    /\bui\b/,
  ]);
  addSignal("route", [/\broute\b/, /\brouting\b/, /\brouter\b/]);
  addSignal("endpoint", [/\bendpoint\b/, /\bhandler\b/, /\bcontroller\b/]);
  addSignal("api", [/\bapi\b/, /\brest\b/, /\bgraphql\b/]);
  addSignal("auth", [
    /\bauth\b/,
    /\blogin\b/,
    /\blogout\b/,
    /\bsession\b/,
    /\btoken\b/,
    /\bpassword\b/,
    /\bunauthorized\b/,
  ]);
  addSignal("database", [
    /\bdatabase\b/,
    /\bdb\b/,
    /\bschema\b/,
    /\bmigration\b/,
    /\bsql\b/,
    /\btable\b/,
    /\bquery\b/,
    /\bmodel\b/,
  ]);
  addSignal("config", [
    /\bconfig\b/,
    /\bbuild\b/,
    /\bwebpack\b/,
    /\bvite\b/,
    /\btsconfig\b/,
    /\benv\b/,
    /\beslint\b/,
    /\bprettier\b/,
    /\bvitest\b/,
    /\bjest\b/,
    /\bpackage\b/,
  ]);
  addSignal("test", [
    /\btest\b/,
    /\bspec\b/,
    /\be2e\b/,
    /\bplaywright\b/,
    /\bcypress\b/,
    /\bvitest\b/,
    /\bjest\b/,
  ]);
  addSignal("bugfix", [/\bbug\b/, /\bfix\b/, /\berror\b/, /\bissue\b/, /\bfail\b/]);
  addSignal("refactor", [/\brefactor\b/, /\bcleanup\b/, /\brestructure\b/]);

  return [...new Set(signals)];
}

function getSignalScore(file: RepoFile, signals: TaskSignal[]): number {
  const filePath = file.path.toLowerCase();
  const extension = file.extension.toLowerCase();
  let score = 0;

  for (const signal of signals) {
    switch (signal) {
      case "component":
        if (
          filePath.includes("/components/") ||
          filePath.includes("/component/") ||
          filePath.includes("/pages/") ||
          filePath.includes("/ui/") ||
          ["tsx", "jsx", "css", "scss"].includes(extension)
        ) {
          score += 16;
        }
        break;
      case "style":
        if (
          filePath.endsWith("index.html")
        ) {
          score += 80;
        } else if (
          filePath.endsWith("styles.css") ||
          filePath.endsWith("global.css") ||
          filePath.endsWith("app.css") ||
          ((filePath.includes("/ui/") || filePath.includes("\\ui\\")) &&
            ["html", "css", "scss"].includes(extension))
        ) {
          score += 40;
        } else if (
          ["css", "html", "scss"].includes(extension) ||
          filePath.includes("/styles/") ||
          filePath.includes("/css/")
        ) {
          score += 40;
        }
        break;
      case "route":
        if (
          filePath.includes("/routes/") ||
          filePath.includes("router") ||
          filePath.includes("/pages/")
        ) {
          score += 14;
        }
        break;
      case "endpoint":
      case "api":
        if (
          filePath.includes("/api/") ||
          filePath.includes("/routes/") ||
          filePath.includes("/controllers/") ||
          filePath.includes("/services/") ||
          file.category === "backend"
        ) {
          score += 15;
        }
        break;
      case "auth":
        if (
          filePath.includes("auth") ||
          filePath.includes("login") ||
          filePath.includes("session") ||
          filePath.includes("token") ||
          filePath.includes("guard") ||
          filePath.includes("middleware")
        ) {
          score += 18;
        }
        if (filePath.includes("auth")) {
          score += 6;
        }
        break;
      case "database":
        if (
          filePath.includes("/db/") ||
          filePath.includes("migration") ||
          filePath.includes("schema") ||
          filePath.includes("model") ||
          filePath.includes("query") ||
          ["sql", "db"].includes(extension)
        ) {
          score += 18;
        }
        break;
      case "config":
        if (
          filePath.endsWith("package.json") ||
          filePath.includes("config") ||
          filePath.includes(".env") ||
          filePath.includes("tsconfig") ||
          filePath.includes("vite.config") ||
          filePath.includes("webpack") ||
          filePath.includes("vitest") ||
          filePath.includes("jest")
        ) {
          score += 18;
        }
        break;
      case "test":
        if (
          filePath.includes("test") ||
          filePath.includes("spec") ||
          filePath.includes("e2e") ||
          filePath.includes("playwright") ||
          filePath.includes("cypress")
        ) {
          score += 15;
        }
        break;
      case "bugfix":
        if (
          filePath.includes("/src/") ||
          filePath.includes("/server/") ||
          filePath.includes("/client/") ||
          ["ts", "tsx", "js", "jsx", "java", "py"].includes(extension)
        ) {
          score += 4;
        }
        break;
      case "refactor":
        if (
          filePath.includes("/src/") ||
          filePath.includes("/services/") ||
          filePath.includes("/utils/") ||
          filePath.includes("/lib/")
        ) {
          score += 6;
        }
        break;
    }
  }

  return score;
}

/**
 * Framework-agnostic path tiers.
 * Higher priority = more likely to contain "the answer" for typical queries.
 * Match is by path SEGMENT (split on "/"), not substring — so "componentry"
 * doesn't accidentally match the "components" tier.
 */
const PATH_TIERS: Array<{
  priority: number;
  segments: string[];
  description: string;
}> = [
  {
    priority: 8,
    segments: [
      "lib",
      "libs",
      "utils",
      "util",
      "helpers",
      "services",
      "domain",
      "core",
      "shared",
      "common",
      "modules",
    ],
    description: "source-of-truth: shared logic, helpers, services",
  },
  {
    priority: 5,
    segments: [
      "app",
      "pages",
      "routes",
      "controllers",
      "views",
      "handlers",
      "endpoints",
      "actions",
    ],
    description: "entry points: pages, routes, controllers",
  },
  {
    priority: 4,
    segments: [
      "components",
      "widgets",
      "partials",
      "ui",
      "elements",
      "containers",
      "screens",
    ],
    description: "UI: components, widgets",
  },
  {
    priority: 4,
    segments: [
      "models",
      "schemas",
      "stores",
      "state",
      "store",
      "repositories",
      "repos",
      "data",
      "entities",
    ],
    description: "data layer: models, schemas, stores",
  },
  {
    priority: 3,
    segments: [
      "middleware",
      "middlewares",
      "api",
      "server",
      "client",
      "providers",
      "adapters",
      "integrations",
      "plugins",
    ],
    description: "infrastructure: middleware, api, providers",
  },
  {
    priority: 4,
    segments: ["hooks", "composables", "mixins"],
    description: "hooks, composables, mixins",
  },
  {
    priority: 2,
    segments: ["config", "configs", "configuration"],
    description: "config",
  },
  {
    priority: 2,
    segments: ["styles", "css", "scss", "themes"],
    description: "styles",
  },
  {
    priority: 1,
    segments: [
      "tests",
      "test",
      "__tests__",
      "spec",
      "specs",
      "fixtures",
      "mocks",
      "__mocks__",
      "e2e",
      "cypress",
    ],
    description: "tests & fixtures",
  },
  {
    priority: 0,
    segments: [
      "generated",
      "gen",
      "auto-generated",
      ".next",
      "dist",
      "build",
    ],
    description: "generated/build artifacts",
  },
];

/**
 * Returns the highest tier priority across the file's path segments.
 * Segment match (case-insensitive) — not substring — to avoid false positives
 * like "components" inside "componentry/" or third-party paths.
 */
export function computePathTierScore(filePath: string): number {
  const segments = (filePath || "").split("/").filter(Boolean);
  if (segments.length === 0) return 0;
  const lowerSegments = segments.map((s) => s.toLowerCase());

  let highest = 0;
  for (const tier of PATH_TIERS) {
    for (const seg of lowerSegments) {
      if (tier.segments.includes(seg)) {
        if (tier.priority > highest) highest = tier.priority;
      }
    }
  }
  return highest;
}

const MONOREPO_CONTAINER_SEGMENTS = new Set([
  "src",
  "client",
  "server",
  "packages",
  "apps",
]);

function getBaselineScore(file: RepoFile): number {
  const tierScore = computePathTierScore(file.path);
  const firstSegment = (file.path.split("/")[0] ?? "").toLowerCase();
  const containerBonus = MONOREPO_CONTAINER_SEGMENTS.has(firstSegment) ? 1 : 0;
  return tierScore + containerBonus;
}

/**
 * Extract path-like tokens from task text and resolve to actual repo files.
 * Catches "look at lib/env.ts", "edit src/foo.ts", "the env.ts file",
 * "AppProviders component". Returns a Set of file paths (from the candidate
 * list) the user explicitly mentioned.
 */
export function extractMentionedFiles(
  task: string,
  files: RepoFile[]
): Set<string> {
  const mentioned = new Set<string>();
  if (!task || files.length === 0) return mentioned;

  const fileByBasename = new Map<string, string[]>();
  const fileByFullPath = new Set<string>();

  for (const f of files) {
    fileByFullPath.add(f.path);
    const basename = f.path.split("/").pop() ?? "";
    if (!fileByBasename.has(basename)) fileByBasename.set(basename, []);
    fileByBasename.get(basename)!.push(f.path);
  }

  // Pattern A: full path-like tokens with extension.
  const fullPathRegex =
    /\b[\w/.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|css|scss|html|md|json|sql|yaml|yml|toml)\b/gi;
  for (const match of task.matchAll(fullPathRegex)) {
    const candidate = match[0];

    if (fileByFullPath.has(candidate)) {
      mentioned.add(candidate);
      continue;
    }

    const basename = candidate.split("/").pop() ?? "";
    const matches = fileByBasename.get(basename);
    if (matches && matches.length === 1) {
      mentioned.add(matches[0]);
    } else if (matches && matches.length > 1) {
      const taskLower = task.toLowerCase();
      const partialMatch = matches.find((p) =>
        taskLower.includes(p.toLowerCase())
      );
      if (partialMatch) {
        mentioned.add(partialMatch);
      } else {
        for (const p of matches) mentioned.add(p);
      }
    }
  }

  // Pattern B: bare CamelCase words → unique-stem basenames.
  const camelCaseRegex = /\b([A-Z][A-Za-z0-9_]{2,})\b/g;
  for (const match of task.matchAll(camelCaseRegex)) {
    const word = match[0];
    for (const [basename, paths] of fileByBasename) {
      const stem = basename.replace(/\.[^.]+$/, "");
      if (stem === word && paths.length === 1) {
        mentioned.add(paths[0]);
      }
    }
  }

  return mentioned;
}

const ENTITY_TERM_BLOCKLIST = new Set([
  "function",
  "functions",
  "const",
  "var",
  "let",
  "class",
  "interface",
  "type",
  "import",
  "export",
  "default",
  "return",
  "async",
  "await",
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "null",
  "undefined",
  "true",
  "false",
  "this",
  "that",
  "what",
  "which",
  "when",
  "where",
  "who",
  "why",
  "how",
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "have",
  "has",
  "are",
  "was",
  "were",
  "been",
  "use",
  "uses",
  "used",
  "using",
  "project",
  "projects",
  "code",
  "codebase",
  "file",
  "files",
  "test",
  "tests",
  "component",
  "components",
  "feature",
  "features",
  "task",
  "tasks",
  "tell",
  "give",
  "show",
  "find",
  "list",
  "check",
  "look",
  "make",
  "add",
  "fix",
]);

/**
 * Extract entity-like terms from task text — identifiers, function names,
 * env-var names. Excludes common English/dev stopwords. Returns lowercase
 * terms for case-insensitive matching.
 */
export function extractEntityTerms(task: string): string[] {
  if (!task) return [];

  const terms = new Set<string>();

  // CamelCase identifiers (functions, classes, components).
  for (const match of task.matchAll(
    /\b(?:[A-Z][A-Za-z0-9]{2,}|[a-z]+[A-Z][A-Za-z0-9]+)\b/g
  )) {
    terms.add(match[0].toLowerCase());
  }

  // SCREAMING_SNAKE_CASE (env vars, constants).
  for (const match of task.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) {
    terms.add(match[0].toLowerCase());
  }

  // snake_case identifiers (require an underscore so "router" is not picked up).
  for (const match of task.matchAll(/\b([a-z][a-z0-9_]{4,})\b/g)) {
    const word = match[0];
    if (word.includes("_")) terms.add(word.toLowerCase());
  }

  // Quoted strings (user might quote a function/var name).
  for (const match of task.matchAll(/[`'"]([\w]+)[`'"]/g)) {
    if (match[1].length > 2) terms.add(match[1].toLowerCase());
  }

  return Array.from(terms).filter((t) => !ENTITY_TERM_BLOCKLIST.has(t));
}

/**
 * Domain phrases → identifier terms.
 * When a query uses domain language (e.g. "environment variables") we expand
 * to concrete identifier-like tokens that lexical scan can match against
 * actual file contents. Framework-agnostic: works whether the project uses
 * Clerk/Supabase/Prisma/Stripe/etc.
 */
const DOMAIN_TERM_MAP: Record<string, string[]> = {
  // env & config
  "environment variable": ["env", "process.env", "readenv", "getenv"],
  "environment variables": ["env", "process.env", "readenv", "getenv"],
  "env var": ["env", "process.env", "readenv"],
  "env vars": ["env", "process.env", "readenv"],
  "configuration": ["config", "configure", "settings", "options"],
  "settings": ["config", "settings", "preferences", "options"],

  // auth
  "authentication": ["auth", "clerk", "auth0", "login", "session", "jwt", "oauth", "user"],
  "auth": ["auth", "clerk", "login", "session", "jwt", "oauth"],
  "login": ["login", "signin", "auth", "session"],
  "user session": ["session", "user", "auth", "cookie"],
  "permissions": ["permission", "role", "access", "policy"],

  // database
  "database": ["supabase", "prisma", "drizzle", "mongoose", "db", "query", "table", "schema"],
  "data layer": ["repository", "repo", "model", "entity", "schema"],
  "sql": ["sql", "query", "table", "column", "migration"],
  "migration": ["migration", "schema", "alter", "create"],
  "schema": ["schema", "model", "table", "type"],
  "orm": ["prisma", "drizzle", "mongoose", "sequelize", "typeorm"],

  // api & routes
  "api": ["route", "endpoint", "handler", "controller", "api"],
  "endpoint": ["route", "endpoint", "handler", "controller"],
  "rest": ["rest", "route", "endpoint", "handler"],
  "graphql": ["graphql", "resolver", "schema", "query", "mutation"],
  "webhook": ["webhook", "event", "handler", "callback"],

  // ui
  "component": ["component", "props", "render", "jsx", "tsx"],
  "page": ["page", "route", "layout", "view"],
  "layout": ["layout", "wrapper", "container", "shell"],
  "form": ["form", "input", "field", "validation", "zod", "yup"],
  "modal": ["modal", "dialog", "popup", "overlay"],

  // styling
  "styling": ["css", "scss", "tailwind", "style", "theme", "classname"],
  "style": ["css", "style", "tailwind", "theme"],
  "theme": ["theme", "color", "palette", "dark", "light"],
  "tailwind": ["tailwind", "tw", "classname", "cn"],

  // state
  "state management": ["state", "store", "reducer", "redux", "zustand", "context"],
  "store": ["store", "state", "reducer", "atom"],
  "context": ["context", "provider", "consumer", "use"],

  // networking
  "fetch": ["fetch", "axios", "request", "http", "api"],
  "http": ["http", "request", "response", "fetch", "axios"],
  "websocket": ["websocket", "ws", "socket", "realtime"],

  // payments
  "payment": ["stripe", "payment", "checkout", "charge", "subscription"],
  "billing": ["billing", "invoice", "subscription", "stripe", "plan"],
  "subscription": ["subscription", "plan", "tier", "stripe"],
  "stripe": ["stripe", "checkout", "webhook", "session"],

  // testing
  "test": ["test", "spec", "fixture", "mock"],
  "unit test": ["test", "spec", "describe", "it", "expect"],
  "integration test": ["test", "spec", "fixture", "setup"],
  "mock": ["mock", "stub", "fixture", "fake"],

  // build & tooling
  "build": ["webpack", "vite", "rollup", "esbuild", "bundle"],
  "bundle": ["webpack", "vite", "rollup", "bundle"],
  "linting": ["eslint", "prettier", "lint", "rule"],
  "typescript": ["tsconfig", "typescript", "type", "interface"],

  // i18n
  "internationalization": ["i18n", "locale", "translation", "language"],
  "i18n": ["i18n", "locale", "translation", "lang"],
  "translation": ["translation", "i18n", "locale", "messages"],

  // monitoring
  "logging": ["log", "logger", "console", "winston", "pino"],
  "monitoring": ["sentry", "datadog", "telemetry", "metric"],
  "error handling": ["error", "exception", "catch", "throw"],
  "telemetry": ["telemetry", "tracking", "analytics", "metric"],

  // queue & messaging
  "queue": ["queue", "job", "worker", "bullmq", "redis"],
  "background job": ["job", "worker", "queue", "task"],

  // cache
  "cache": ["cache", "redis", "memcached", "lru"],
  "caching": ["cache", "redis", "memo", "ttl"],

  // file & storage
  "file upload": ["upload", "file", "multipart", "formdata", "s3"],
  "storage": ["storage", "s3", "blob", "bucket"],
};

const DOMAIN_PHRASES_BY_LENGTH = Object.keys(DOMAIN_TERM_MAP).sort(
  (a, b) => b.length - a.length
);

/**
 * If the task contains any domain phrase, fold its mapped identifier terms
 * into the existing entity term set. Case-insensitive substring match so
 * "the environment variables here" still triggers.
 */
export function expandWithDomainTerms(
  task: string,
  baseTerms: string[]
): string[] {
  if (!task) return baseTerms;
  const expanded = new Set(baseTerms);
  const lowerTask = task.toLowerCase();
  for (const phrase of DOMAIN_PHRASES_BY_LENGTH) {
    if (lowerTask.includes(phrase)) {
      for (const term of DOMAIN_TERM_MAP[phrase]) {
        expanded.add(term.toLowerCase());
      }
    }
  }
  return Array.from(expanded);
}

function scoreFile(
  file: RepoFile,
  task: string,
  mentionedFiles: Set<string>
): number {
  const normalizedTask = task.toLowerCase();
  const filePath = file.path.toLowerCase();
  const fileBasename = (file.path.split("/").pop() ?? file.path)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  const signals = extractTaskSignals(task);
  const taskEntityTerms = getTaskEntityTerms(task);
  const pathTermMatches = getPathTermMatches(file.path, taskEntityTerms);
  const explicitFilenameTokens = task.match(
    /\b(?:[A-Z][A-Za-z0-9_]*|[A-Za-z0-9_-]+\.(?:jsx|tsx|ts|js|py))\b/g
  ) ?? [];
  const explicitBasenameTargets = explicitFilenameTokens.map((token) =>
    token.replace(/\.[^.]+$/, "").toLowerCase()
  );
  const hasExplicitBasenameTarget = explicitBasenameTargets.length > 0;

  let score = getBaselineScore(file) + getSignalScore(file, signals);

  if (mentionedFiles.has(file.path)) {
    score += 300;
  }

  const keywords = normalizedTask
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2);

  for (const keyword of keywords) {
    if (filePath.includes(keyword)) {
      score += 10;
    }
  }

  score += pathTermMatches.length * 14;

  if (pathTermMatches.length > 0) {
    if (filePath.includes("/pages/")) {
      score += 12;
    } else if (filePath.includes("/components/")) {
      score += 8;
    }
  }

  for (const token of explicitFilenameTokens) {
    const normalizedToken = token.replace(/\.[^.]+$/, "").toLowerCase();
    if (normalizedToken === fileBasename) {
      score += token.includes(".") ? 200 : 500;
    }
  }

  if (normalizedTask.includes("timeline") && filePath.includes("timeline")) {
    score += 25;
  }

  if (normalizedTask.includes("patient") && filePath.includes("patient")) {
    score += 20;
  }

  if (normalizedTask.includes("appointment") && filePath.includes("appointment")) {
    score += 20;
  }

  if (normalizedTask.includes("scan") && filePath.includes("scan")) {
    score += 20;
  }

  if (normalizedTask.includes("service") && filePath.includes("/services/")) {
    score += 10;
  }

  if (normalizedTask.includes("backend") && file.category === "backend") {
    score += 12;
  }

  if (normalizedTask.includes("frontend") && file.category === "frontend") {
    score += 12;
  }

  if (
    (normalizedTask.includes("html") ||
      normalizedTask.includes("ui") ||
      normalizedTask.includes("header")) &&
    filePath.endsWith("index.html")
  ) {
    score += 12;
  }

  if (
    (normalizedTask.includes("index.html") || normalizedTask.includes("src/ui")) &&
    filePath === "src/ui/index.html"
  ) {
    score += 100;
  }

  if (
    [
      "exec-btn",
      "role-btn",
      "decision-badge",
      "patch-preview",
      "apply-btn",
    ].some((token) => normalizedTask.includes(token)) &&
    filePath === "src/ui/index.html"
  ) {
    score += 60;
  }

  if (file.path.includes("/routes/")) {
    score += 4;
  }

  if (file.path.includes("/controllers/")) {
    score += 4;
  }

  if (
    file.path.includes("/pages/") &&
    (!hasExplicitBasenameTarget || explicitBasenameTargets.includes(fileBasename))
  ) {
    score += 4;
  }

  if (
    signals.includes("component") &&
    taskEntityTerms.length > 0 &&
    pathTermMatches.length === 0 &&
    GENERIC_SHELL_BASENAMES.has(fileBasename)
  ) {
    score -= 18;
  }

  return score;
}

/**
 * Read top-N candidate file contents (bounded I/O) and award a small score
 * boost for each entity-term match. Caps per-file boost at +50.
 */
async function applyLexicalBoost<
  T extends { path: string; score: number; __keywordScore: number }
>(
  scored: T[],
  task: string,
  readContent: (filePath: string) => Promise<string | null>
): Promise<void> {
  const baseTerms = extractEntityTerms(task);
  const allTerms = expandWithDomainTerms(task, baseTerms);
  if (allTerms.length === 0 || scored.length === 0) return;

  const TOP_N = 30;
  const MAX_FILE_BYTES = 50_000;
  const top = scored.slice(0, TOP_N);

  await Promise.all(
    top.map(async (sf) => {
      let content: string | null = null;
      try {
        content = await readContent(sf.path);
      } catch {
        return;
      }
      if (!content) return;
      if (content.length > MAX_FILE_BYTES) {
        content = content.slice(0, MAX_FILE_BYTES);
      }
      const lower = content.toLowerCase();
      let totalHits = 0;
      for (const term of allTerms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const matches = lower.match(new RegExp(`\\b${escaped}\\b`, "g"));
        if (matches) totalHits += Math.min(matches.length, 3);
      }
      if (totalHits > 0) {
        const boost = Math.min(totalHits * 5, 50);
        sf.score += boost;
        sf.__keywordScore += boost;
      }
    })
  );
}

export async function rankRelevantFiles(args: {
  task: string;
  files: RepoFile[];
  projectStructure?: unknown;
  intent?: TaskIntent;
  semanticScores?: Map<string, number>;
  lastChangedFiles?: string[];
  readContent?: (filePath: string) => Promise<string | null>;
}): Promise<Array<RepoFile & { score: number }>> {
  debugLog("[zone-rank-fn-entry] rankRelevantFiles called", {
    hasSemanticScores: !!args.semanticScores,
    semanticScoresSize: args.semanticScores?.size || 0,
    fileCount: args.files?.length,
  });
  const { task, files, intent, semanticScores, lastChangedFiles, readContent } =
    args;

  debugLog("[zone-rank-input-debug]", {
    hasSemanticScores: !!semanticScores,
    semanticScoresSize: semanticScores?.size || 0,
  });

  const maxContextFilesRaw = (process.env.MAX_CONTEXT_FILES ?? "").trim();
  const maxContextFiles =
    maxContextFilesRaw && Number.isFinite(Number(maxContextFilesRaw))
      ? Math.max(1, Math.floor(Number(maxContextFilesRaw)))
      : 5;

  const shouldSkipPath = (filePath: string): boolean => {
    const p = (filePath ?? "").toLowerCase();
    return [
      "venv",
      ".venv",
      "site-packages",
      "__pycache__",
      "node_modules",
      "/.git/",
      "\\.git\\",
      "dist",
      "build",
      ".next",
    ].some((token) => p.includes(token));
  };

  const candidateFiles = files.filter((f) => !shouldSkipPath(f.path));
  const mentionedFiles = extractMentionedFiles(task, candidateFiles);
  const lastChangedSet = new Set(
    Array.isArray(lastChangedFiles)
      ? lastChangedFiles.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      : []
  );

  const ranked = candidateFiles.map((file) => {
    const keywordScore = scoreFile(file, task, mentionedFiles);
    const boost = intent
      ? getIntentAwareScoreBoost(file.path, "", intent)
      : 0;
    const lastChangedBoost =
      lastChangedSet.has(file.path) && keywordScore > 0 ? 30 : 0;

    return {
      ...file,
      score: keywordScore + boost + lastChangedBoost,
      __keywordScore: keywordScore + lastChangedBoost,
      __boost: boost,
    };
  });

  if (readContent) {
    const baseTerms = extractEntityTerms(task);
    const allTerms = expandWithDomainTerms(task, baseTerms);
    if (allTerms.length > 0) {
      ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
      await applyLexicalBoost(ranked, task, readContent);
      debugLog("[zone-rank-lexical-debug]", {
        baseTerms,
        domainTerms: allTerms.filter((t) => !baseTerms.includes(t)),
        topAfterLexical: ranked
          .slice()
          .sort(
            (a, b) => b.score - a.score || a.path.localeCompare(b.path)
          )
          .slice(0, 5)
          .map((f) => ({ path: f.path, score: f.score })),
      });
    }
  }

  if (semanticScores && semanticScores.size > 0 && ranked.length > 0) {
    const taskLen = String(task || "").length;
    const semanticWeight = taskLen > 80 ? 0.75 : 0.6;
    const keywordWeight = 1 - semanticWeight;
    const keywordScores = ranked.map((file) => Number((file as typeof file & { __keywordScore: number }).__keywordScore || 0));
    const maxKeyword = Math.max(...keywordScores);
    const minKeyword = Math.min(...keywordScores);
    const normalizeKeywordScore = (value: number): number => {
      if (maxKeyword === minKeyword) {
        return value > 0 ? 90 : 0;
      }
      return Math.min(
        90,
        ((value - minKeyword) / (maxKeyword - minKeyword)) * 100
      );
    };

    const hybridRanked = ranked.map((file) => {
      const keywordScore = Number((file as typeof file & { __keywordScore: number }).__keywordScore || 0);
      const boost = Number((file as typeof file & { __boost: number }).__boost || 0);
      const semanticScore = Math.max(
        0,
        Math.min(1, Number(semanticScores.get(file.path) ?? 0))
      );
      const normalizedKeywordScore = normalizeKeywordScore(keywordScore);
      const hybridScore =
        keywordWeight * normalizedKeywordScore +
        semanticWeight * (semanticScore * 100);

      return {
        ...file,
        score: hybridScore + boost,
        __keywordScoreNormalized: normalizedKeywordScore,
        __semanticScore: semanticScore,
        __hybridScore: hybridScore + boost,
      };
    });

    let finalHybridRanked = [...hybridRanked]
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    const topSemanticMatch = [...hybridRanked]
      .filter((file) => Number((file as typeof file & { __semanticScore: number }).__semanticScore || 0) > 0)
      .sort((a, b) => {
        const semanticDelta =
          Number((b as typeof b & { __semanticScore: number }).__semanticScore || 0) -
          Number((a as typeof a & { __semanticScore: number }).__semanticScore || 0);
        if (semanticDelta !== 0) return semanticDelta;
        return b.score - a.score || a.path.localeCompare(b.path);
      })[0];

    if (topSemanticMatch) {
      const topSemanticSimilarity = Number(
        (topSemanticMatch as typeof topSemanticMatch & { __semanticScore: number })
          .__semanticScore || 0
      );
      const currentTopFive = finalHybridRanked.slice(0, 5).map((file) => file.path);
      const thresholdMet = topSemanticSimilarity > 0.35;
      const alreadyInTop5 = currentTopFive.includes(topSemanticMatch.path);
      const willInsert = thresholdMet && !alreadyInTop5;
      debugLog("[zone-rank-rescue-check]", {
        topSemantic: {
          file: topSemanticMatch.path,
          similarity: topSemanticSimilarity,
        },
        thresholdMet,
        alreadyInTop5,
        willInsert,
      });
      if (
        willInsert
      ) {
        finalHybridRanked = finalHybridRanked.filter(
          (file) => file.path !== topSemanticMatch.path
        );
        finalHybridRanked.splice(1, 0, topSemanticMatch);
        debugLog("[zone-rank-rescue-debug]", {
          candidateFile: topSemanticMatch.path,
          candidateSimilarity: topSemanticSimilarity,
          decision: "inserted",
        });
        debugLog("[zone-rank-semantic-rescue]", {
          file: topSemanticMatch.path,
          similarity: topSemanticSimilarity,
          hybridScore: Number(
            (topSemanticMatch as typeof topSemanticMatch & { __hybridScore: number })
              .__hybridScore || topSemanticMatch.score
          ),
          action: "inserted_at_top",
        });
      } else {
        debugLog("[zone-rank-rescue-debug]", {
          candidateFile: topSemanticMatch.path,
          candidateSimilarity: topSemanticSimilarity,
          decision: "skipped",
          skipReason: !thresholdMet ? "below_threshold" : "already_present",
        });
      }
    }

    const topFiles = finalHybridRanked
      .slice(0, Math.min(5, finalHybridRanked.length))
      .map((file) => ({
        path: file.path,
        keywordScore: Number((file as typeof file & { __keywordScoreNormalized: number }).__keywordScoreNormalized || 0),
        semanticScore: Number((file as typeof file & { __semanticScore: number }).__semanticScore || 0),
        hybridScore: Number((file as typeof file & { __hybridScore: number }).__hybridScore || file.score),
      }));

    debugLog("[zone-rank-hybrid-debug]", {
      task,
      topFiles,
    });

    return finalHybridRanked
      .slice(0, maxContextFiles)
      .map(({ __keywordScore, __boost, __keywordScoreNormalized, __semanticScore, __hybridScore, ...file }) => file);
  }

  return ranked
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxContextFiles)
    .map(({ __keywordScore, __boost, ...file }) => file);
}
