"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectFramework = detectFramework;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const fast_glob_1 = __importDefault(require("fast-glob"));
function exists(p) {
    try {
        return node_fs_1.default.existsSync(p);
    }
    catch {
        return false;
    }
}
function readText(p) {
    try {
        return node_fs_1.default.readFileSync(p, "utf8");
    }
    catch {
        return "";
    }
}
function tryReadJson(p) {
    try {
        return JSON.parse(readText(p));
    }
    catch {
        return null;
    }
}
function detectPackageManager(dir) {
    if (exists(node_path_1.default.join(dir, "yarn.lock")))
        return "yarn";
    if (exists(node_path_1.default.join(dir, "pnpm-lock.yaml")))
        return "pnpm";
    return "npm";
}
function buildScriptCommand(pm, scriptName) {
    if (pm === "yarn")
        return `yarn ${scriptName}`;
    if (pm === "pnpm")
        return `pnpm ${scriptName}`;
    if (scriptName === "test")
        return "npm test";
    return `npm run ${scriptName}`;
}
function detectNodeFromPackageJson(packageJson, dir) {
    if (!packageJson)
        return null;
    const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
    };
    const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
    const pm = detectPackageManager(dir);
    const scripts = packageJson.scripts ?? {};
    const hasScript = (k) => typeof scripts[k] === "string";
    const language = has("typescript") || exists(node_path_1.default.join(dir, "tsconfig.json")) ? "typescript" : "javascript";
    let framework = "Node.js";
    if (has("next"))
        framework = "Next.js";
    else if (has("nuxt"))
        framework = "Nuxt.js";
    else if (has("@angular/core"))
        framework = "Angular";
    else if (has("svelte"))
        framework = "Svelte";
    else if (has("vue"))
        framework = "Vue.js";
    else if (has("@nestjs/core"))
        framework = "NestJS";
    else if (has("react")) {
        if (has("vite"))
            framework = "React + Vite";
        else if (has("react-scripts"))
            framework = "React (CRA)";
        else
            framework = "React";
    }
    else if (has("express"))
        framework = "Node.js API (Express)";
    else if (has("fastify"))
        framework = "Node.js API (Fastify)";
    else if (has("koa"))
        framework = "Node.js API (Koa)";
    let testFramework = "unknown";
    let testCommand = "npm test";
    if (has("vitest")) {
        testFramework = "vitest";
        testCommand = buildScriptCommand(pm, hasScript("test") ? "test" : "test");
    }
    else if (has("jest") || has("@jest/core")) {
        testFramework = "jest";
        testCommand = buildScriptCommand(pm, "test");
    }
    else if (has("mocha")) {
        testFramework = "mocha";
        testCommand = buildScriptCommand(pm, "test");
    }
    else if (has("cypress")) {
        testFramework = "cypress";
        testCommand = hasScript("test:e2e")
            ? buildScriptCommand(pm, "test:e2e")
            : buildScriptCommand(pm, "test");
    }
    else if (has("playwright") || has("@playwright/test")) {
        testFramework = "playwright";
        testCommand = "npx playwright test";
    }
    else if (hasScript("test")) {
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
        hasTests: hasScript("test") || testFramework !== "unknown",
        testFramework,
    };
}
function detectPython(dir) {
    const req = node_path_1.default.join(dir, "requirements.txt");
    const pyproject = node_path_1.default.join(dir, "pyproject.toml");
    if (!exists(req) && !exists(pyproject))
        return null;
    const txt = [readText(req), readText(pyproject)].join("\n").toLowerCase();
    let framework = "Python";
    let devCommand = "";
    if (txt.includes("fastapi")) {
        framework = "FastAPI";
        devCommand = "uvicorn main:app --reload";
    }
    else if (txt.includes("django")) {
        framework = "Django";
        devCommand = "python manage.py runserver";
    }
    else if (txt.includes("flask")) {
        framework = "Flask";
        devCommand = "flask run";
    }
    const hasPytest = txt.includes("pytest") || exists(node_path_1.default.join(dir, "pytest.ini"));
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
function detectRust(dir) {
    const cargo = node_path_1.default.join(dir, "Cargo.toml");
    if (!exists(cargo))
        return null;
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
function detectGo(dir) {
    const mod = node_path_1.default.join(dir, "go.mod");
    if (!exists(mod))
        return null;
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
function detectJava(dir) {
    const pom = node_path_1.default.join(dir, "pom.xml");
    const gradle = node_path_1.default.join(dir, "build.gradle");
    const gradleKts = node_path_1.default.join(dir, "build.gradle.kts");
    if (!exists(pom) && !exists(gradle) && !exists(gradleKts))
        return null;
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
function detectPhp(dir) {
    const composer = node_path_1.default.join(dir, "composer.json");
    if (!exists(composer))
        return null;
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
async function detectHasTests(dir) {
    const hits = await (0, fast_glob_1.default)([
        "**/__tests__/**",
        "**/tests/**",
        "**/test/**",
        "**/*.test.{js,jsx,ts,tsx}",
        "**/*.spec.{js,jsx,ts,tsx}",
        "pytest.ini",
        "conftest.py",
        "testng.xml",
    ], {
        cwd: dir,
        onlyFiles: false,
        dot: false,
        unique: true,
        ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"],
    });
    return hits.length > 0;
}
async function detectInDir(dir) {
    const configFiles = [];
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
        if (exists(node_path_1.default.join(dir, f)))
            configFiles.push(f);
    }
    const pkgJson = tryReadJson(node_path_1.default.join(dir, "package.json"));
    const node = detectNodeFromPackageJson(pkgJson, dir);
    const py = detectPython(dir);
    const rust = detectRust(dir);
    const go = detectGo(dir);
    const java = detectJava(dir);
    const php = detectPhp(dir);
    const base = node ??
        py ??
        rust ??
        go ??
        java ??
        php ?? {
        language: "unknown",
        framework: "Unknown",
        testCommand: "",
        buildCommand: "",
        devCommand: "",
        packageManager: "unknown",
        hasTests: false,
        testFramework: "unknown",
    };
    const hasTests = base.hasTests || (await detectHasTests(dir));
    return {
        ...base,
        hasTests,
        configFiles,
        subProjects: [],
    };
}
async function detectFramework(repoPath) {
    const clientPkg = node_path_1.default.join(repoPath, "client", "package.json");
    const serverPkg = node_path_1.default.join(repoPath, "server", "package.json");
    const hasClient = exists(clientPkg);
    const hasServer = exists(serverPkg);
    if (hasClient && hasServer) {
        const client = await detectInDir(node_path_1.default.join(repoPath, "client"));
        const server = await detectInDir(node_path_1.default.join(repoPath, "server"));
        const root = await detectInDir(repoPath);
        // If server has a real test script, surface it as a secondary test command hint.
        // (Actual execution uses the verification planner; this string helps the planner/LLM.)
        let combinedTestCommand = root.testCommand;
        try {
            const serverPkgJson = tryReadJson(serverPkg);
            const hasServerTest = typeof serverPkgJson?.scripts?.test === "string" &&
                serverPkgJson.scripts.test.trim().length > 0;
            if (hasServerTest) {
                const secondary = "cd server && npm test";
                combinedTestCommand = combinedTestCommand
                    ? `${combinedTestCommand}\n${secondary}`
                    : secondary;
            }
        }
        catch {
            // best-effort
        }
        return {
            ...root,
            testCommand: combinedTestCommand,
            framework: "Monorepo",
            subProjects: [client, server],
        };
    }
    return detectInDir(repoPath);
}
//# sourceMappingURL=detectFramework.js.map