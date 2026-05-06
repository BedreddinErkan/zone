import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";

export interface ProjectFramework {
  language:
    | "javascript"
    | "typescript"
    | "python"
    | "java"
    | "rust"
    | "go"
    | "php"
    | "unknown";
  framework: string;
  testCommand: string;
  buildCommand: string;
  devCommand: string;
  packageManager: string;
  hasTests: boolean;
  testFilesDetected: boolean;
  testFramework: string;
  configFiles: string[];
  subProjects: ProjectFramework[];
}

type DetectedFrameworkBase = Omit<
  ProjectFramework,
  "configFiles" | "subProjects" | "testFilesDetected"
>;

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function readText(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function tryReadJson<T>(p: string): T | null {
  try {
    return JSON.parse(readText(p)) as T;
  } catch {
    return null;
  }
}

function detectPackageManager(dir: string): "yarn" | "pnpm" | "npm" {
  if (exists(path.join(dir, "yarn.lock"))) return "yarn";
  if (exists(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

function buildScriptCommand(
  pm: "npm" | "yarn" | "pnpm",
  scriptName: string
): string {
  if (pm === "yarn") return `yarn ${scriptName}`;
  if (pm === "pnpm") return `pnpm ${scriptName}`;
  if (scriptName === "test") return "npm test";
  return `npm run ${scriptName}`;
}

function detectNodeFromPackageJson(
  packageJson: Record<string, unknown> | null,
  dir: string
): DetectedFrameworkBase | null {
  if (!packageJson) return null;
  const deps = {
    ...(packageJson.dependencies as Record<string, unknown> | undefined),
    ...(packageJson.devDependencies as Record<string, unknown> | undefined),
  };
  const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(deps, name);

  const pm = detectPackageManager(dir);
  const scripts = (packageJson.scripts as Record<string, unknown> | undefined) ?? {};
  const hasScript = (k: string): boolean =>
    typeof (scripts as Record<string, unknown>)[k] === "string";

  const language: ProjectFramework["language"] =
    has("typescript") || exists(path.join(dir, "tsconfig.json")) ? "typescript" : "javascript";

  let framework = "Node.js";
  if (has("next")) framework = "Next.js";
  else if (has("nuxt")) framework = "Nuxt.js";
  else if (has("@angular/core")) framework = "Angular";
  else if (has("svelte")) framework = "Svelte";
  else if (has("vue")) framework = "Vue.js";
  else if (has("@nestjs/core")) framework = "NestJS";
  else if (has("react")) {
    if (has("vite")) framework = "React + Vite";
    else if (has("react-scripts")) framework = "React (CRA)";
    else framework = "React";
  } else if (has("express")) framework = "Node.js API (Express)";
  else if (has("fastify")) framework = "Node.js API (Fastify)";
  else if (has("koa")) framework = "Node.js API (Koa)";

  let testFramework = "unknown";
  let testCommand = "";
  if (has("vitest")) {
    testFramework = "vitest";
    testCommand = hasScript("test") ? buildScriptCommand(pm, "test") : "npx vitest run";
  } else if (has("jest") || has("@jest/core")) {
    testFramework = "jest";
    testCommand = hasScript("test") ? buildScriptCommand(pm, "test") : "npx jest";
  } else if (has("mocha")) {
    testFramework = "mocha";
    testCommand = hasScript("test") ? buildScriptCommand(pm, "test") : "npx mocha";
  } else if (has("cypress")) {
    testFramework = "cypress";
    testCommand = hasScript("test:e2e")
      ? buildScriptCommand(pm, "test:e2e")
      : hasScript("test")
        ? buildScriptCommand(pm, "test")
        : "npx cypress run";
  } else if (has("playwright") || has("@playwright/test")) {
    testFramework = "playwright";
    testCommand = hasScript("test:e2e")
      ? buildScriptCommand(pm, "test:e2e")
      : hasScript("test")
        ? buildScriptCommand(pm, "test")
        : "npx playwright test";
  } else if (hasScript("test")) {
    testFramework = "unknown";
    testCommand = buildScriptCommand(pm, "test");
  }

  const buildCommand = hasScript("build") ? buildScriptCommand(pm, "build") : "";
  const devCommand = hasScript("dev")
    ? buildScriptCommand(pm, "dev")
    : hasScript("start")
      ? buildScriptCommand(pm, "start")
      : "";

  return {
    language,
    framework,
    testCommand,
    buildCommand,
    devCommand,
    packageManager: pm,
    hasTests: testCommand !== "",
    testFramework,
  };
}

function detectPython(dir: string): DetectedFrameworkBase | null {
  const req = path.join(dir, "requirements.txt");
  const pyproject = path.join(dir, "pyproject.toml");
  if (!exists(req) && !exists(pyproject)) return null;

  const txt = [readText(req), readText(pyproject)].join("\n").toLowerCase();
  let framework = "Python";
  let devCommand = "";
  if (txt.includes("fastapi")) {
    framework = "FastAPI";
    devCommand = "uvicorn main:app --reload";
  } else if (txt.includes("django")) {
    framework = "Django";
    devCommand = "python manage.py runserver";
  } else if (txt.includes("flask")) {
    framework = "Flask";
    devCommand = "flask run";
  }

  const hasPytest = txt.includes("pytest") || exists(path.join(dir, "pytest.ini"));
  return {
    language: "python",
    framework,
    testCommand: hasPytest ? "pytest" : "",
    buildCommand: "",
    devCommand,
    packageManager: "pip",
    hasTests: hasPytest,
    testFramework: hasPytest ? "pytest" : "unknown",
  };
}

function detectRust(dir: string): DetectedFrameworkBase | null {
  const cargo = path.join(dir, "Cargo.toml");
  if (!exists(cargo)) return null;
  const txt = readText(cargo).toLowerCase();
  const framework = txt.includes("tauri") ? "Tauri" : "Rust";
  return {
    language: "rust",
    framework,
    testCommand: "cargo test",
    buildCommand: "cargo build",
    devCommand: "cargo run",
    packageManager: "cargo",
    hasTests: true,
    testFramework: "cargo",
  };
}

function detectGo(dir: string): DetectedFrameworkBase | null {
  const mod = path.join(dir, "go.mod");
  if (!exists(mod)) return null;
  return {
    language: "go",
    framework: "Go",
    testCommand: "go test ./...",
    buildCommand: "go build ./...",
    devCommand: "go run .",
    packageManager: "go",
    hasTests: true,
    testFramework: "go test",
  };
}

function detectJava(dir: string): DetectedFrameworkBase | null {
  const pom = path.join(dir, "pom.xml");
  const gradle = path.join(dir, "build.gradle");
  const gradleKts = path.join(dir, "build.gradle.kts");
  if (!exists(pom) && !exists(gradle) && !exists(gradleKts)) return null;
  if (exists(pom)) {
    return {
      language: "java",
      framework: "Maven",
      testCommand: "mvn test",
      buildCommand: "mvn package",
      devCommand: "",
      packageManager: "maven",
      hasTests: true,
      testFramework: "junit",
    };
  }
  return {
    language: "java",
    framework: "Gradle",
    testCommand: "gradle test",
    buildCommand: "gradle build",
    devCommand: "",
    packageManager: "gradle",
    hasTests: true,
    testFramework: "junit",
  };
}

function detectPhp(dir: string): DetectedFrameworkBase | null {
  const composer = path.join(dir, "composer.json");
  if (!exists(composer)) return null;
  return {
    language: "php",
    framework: "PHP",
    testCommand: "",
    buildCommand: "",
    devCommand: "",
    packageManager: "composer",
    hasTests: false,
    testFramework: "unknown",
  };
}

async function detectTestFiles(dir: string): Promise<boolean> {
  const hits = await fg(
    [
      "**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs}",
      "**/*.test.{js,jsx,ts,tsx,mjs,cjs}",
      "**/*.spec.{js,jsx,ts,tsx,mjs,cjs}",
      "**/*_test.go",
      "**/test_*.py",
      "**/*_test.py",
      "pytest.ini",
      "conftest.py",
      "testng.xml",
    ],
    {
      cwd: dir,
      onlyFiles: true,
      dot: false,
      unique: true,
      ignore: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/.next/**",
        "**/target/**",
        "**/vendor/**",
      ],
    }
  );
  return hits.length > 0;
}

async function detectInDir(dir: string): Promise<ProjectFramework> {
  const configFiles: string[] = [];
  const maybeConfigs = [
    "playwright.config.ts",
    "playwright.config.js",
    "cypress.config.ts",
    "cypress.config.js",
    "pytest.ini",
    "conftest.py",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "Gemfile",
    "package.json",
  ];
  for (const f of maybeConfigs) {
    if (exists(path.join(dir, f))) configFiles.push(f);
  }

  const pkgJson = tryReadJson<Record<string, unknown>>(path.join(dir, "package.json"));
  const node = detectNodeFromPackageJson(pkgJson, dir);
  const py = detectPython(dir);
  const rust = detectRust(dir);
  const go = detectGo(dir);
  const java = detectJava(dir);
  const php = detectPhp(dir);

  const base =
    node ??
    py ??
    rust ??
    go ??
    java ??
    php ?? {
      language: "unknown" as const,
      framework: "Unknown",
      testCommand: "",
      buildCommand: "",
      devCommand: "",
      packageManager: "unknown",
      hasTests: false,
      testFramework: "unknown",
    };

  const testFilesDetected = await detectTestFiles(dir);

  return {
    ...base,
    testFilesDetected,
    configFiles,
    subProjects: [],
  };
}

export async function detectFramework(repoPath: string): Promise<ProjectFramework> {
  const clientPkg = path.join(repoPath, "client", "package.json");
  const serverPkg = path.join(repoPath, "server", "package.json");
  const hasClient = exists(clientPkg);
  const hasServer = exists(serverPkg);

  if (hasClient && hasServer) {
    const client = await detectInDir(path.join(repoPath, "client"));
    const server = await detectInDir(path.join(repoPath, "server"));
    const root = await detectInDir(repoPath);

    // If server has a real test script, surface it as a secondary test command hint.
    // (Actual execution uses the verification planner; this string helps the planner/LLM.)
    let combinedTestCommand = root.testCommand;
    try {
      const serverPkgJson = tryReadJson<{ scripts?: Record<string, string> }>(serverPkg);
      const hasServerTest =
        typeof serverPkgJson?.scripts?.test === "string" &&
        serverPkgJson.scripts.test.trim().length > 0;
      if (hasServerTest) {
        const secondary = "cd server && npm test";
        combinedTestCommand = combinedTestCommand
          ? `${combinedTestCommand}\n${secondary}`
          : secondary;
      }
    } catch {
      // best-effort
    }
    return {
      ...root,
      testCommand: combinedTestCommand,
      hasTests: combinedTestCommand !== "",
      testFilesDetected:
        root.testFilesDetected || client.testFilesDetected || server.testFilesDetected,
      framework: "Monorepo",
      subProjects: [client, server],
    };
  }

  return detectInDir(repoPath);
}
