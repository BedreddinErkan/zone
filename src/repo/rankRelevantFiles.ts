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

export function rankRelevantFiles(args: {
  task: string;
  files: RepoFile[];
  projectStructure?: unknown;
  intent?: TaskIntent;
  semanticScores?: Map<string, number>;
}): Array<RepoFile & { score: number }> {
  console.log("[zone-rank-fn-entry] rankRelevantFiles called", {
    hasSemanticScores: !!args.semanticScores,
    semanticScoresSize: args.semanticScores?.size || 0,
    fileCount: args.files?.length,
  });
  const { task, files, intent, semanticScores } = args;

  console.log("[zone-rank-input-debug]", {
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

  const ranked = files
    .filter((f) => !shouldSkipPath(f.path))
    .map((file) => {
      const keywordScore = scoreFile(file, task);
      const boost = intent
        ? getIntentAwareScoreBoost(file.path, "", intent)
        : 0;

      return {
        ...file,
        score: keywordScore + boost,
        __keywordScore: keywordScore,
        __boost: boost,
      };
    });

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
      console.log("[zone-rank-rescue-check]", {
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
        console.log("[zone-rank-rescue-debug]", {
          candidateFile: topSemanticMatch.path,
          candidateSimilarity: topSemanticSimilarity,
          decision: "inserted",
        });
        console.log("[zone-rank-semantic-rescue]", {
          file: topSemanticMatch.path,
          similarity: topSemanticSimilarity,
          hybridScore: Number(
            (topSemanticMatch as typeof topSemanticMatch & { __hybridScore: number })
              .__hybridScore || topSemanticMatch.score
          ),
          action: "inserted_at_top",
        });
      } else {
        console.log("[zone-rank-rescue-debug]", {
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

    console.log("[zone-rank-hybrid-debug]", {
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
