import type { RepoFile } from "../types/project.js";
import { getIntentAwareScoreBoost } from "../core/intentAwareScore.js";
import type { TaskIntent } from "../core/taskIntentParser.js";

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
    /\bcss\b/,
    /\bstyle\b/,
    /\bstyles\b/,
    /\bstyling\b/,
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
          score += 46;
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
          score += 20;
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

function getBaselineScore(file: RepoFile): number {
  const filePath = file.path.toLowerCase();
  if (filePath.startsWith("src/") || filePath.startsWith("client/") || filePath.startsWith("server/")) {
    return 1;
  }
  return 0;
}

function scoreFile(file: RepoFile, task: string): number {
  const normalizedTask = task.toLowerCase();
  const filePath = file.path.toLowerCase();
  const signals = extractTaskSignals(task);

  let score = getBaselineScore(file) + getSignalScore(file, signals);

  const keywords = normalizedTask
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2);

  for (const keyword of keywords) {
    if (filePath.includes(keyword)) {
      score += 10;
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

  if (file.path.includes("/routes/")) {
    score += 4;
  }

  if (file.path.includes("/controllers/")) {
    score += 4;
  }

  if (file.path.includes("/pages/")) {
    score += 4;
  }

  return score;
}

export function rankRelevantFiles(args: {
  task: string;
  files: RepoFile[];
  projectStructure?: unknown;
  intent?: TaskIntent;
}): Array<RepoFile & { score: number }> {
  const { task, files, intent } = args;

  return files
    .map((file) => {
      const baseScore = scoreFile(file, task);
      const boost = intent
        ? getIntentAwareScoreBoost(file.path, "", intent)
        : 0;

      return {
        ...file,
        score: baseScore + boost
      };
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}
