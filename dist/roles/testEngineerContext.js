"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTestEngineerContext = buildTestEngineerContext;
const node_path_1 = __importDefault(require("node:path"));
function detectPageObjects(files, language) {
    if (!Array.isArray(files))
        return [];
    if (language === "java") {
        return files.filter((f) => f.path.includes("pages/") ||
            f.path.includes("page/") ||
            f.path.endsWith("Page.java") ||
            f.path.endsWith("PageObject.java"));
    }
    if (language === "typescript" || language === "javascript") {
        return files.filter((f) => f.path.includes("pages/") ||
            f.path.includes("page-objects/") ||
            f.path.endsWith(".page.ts") ||
            f.path.endsWith(".page.js"));
    }
    if (language === "python") {
        return files.filter((f) => f.path.includes("pages/") ||
            f.path.endsWith("_page.py") ||
            f.path.includes("page_objects/"));
    }
    return [];
}
function detectStepDefinitions(files) {
    if (!Array.isArray(files))
        return [];
    return files.filter((f) => f.path.includes("steps/") ||
        f.path.includes("stepdefinitions/") ||
        f.path.includes("step_definitions/") ||
        f.path.endsWith("Steps.java") ||
        f.path.endsWith("_steps.py"));
}
function detectFeatureFiles(files) {
    if (!Array.isArray(files))
        return [];
    return files
        .filter((f) => f.path.endsWith(".feature"))
        .sort((a, b) => {
        const aIsPreferred = a.path.startsWith("src/test/resources/features/");
        const bIsPreferred = b.path.startsWith("src/test/resources/features/");
        if (aIsPreferred === bIsPreferred)
            return a.path.localeCompare(b.path);
        return aIsPreferred ? -1 : 1;
    });
}
function detectTestFiles(files, framework) {
    if (!Array.isArray(files))
        return [];
    switch (framework.framework) {
        case "playwright_ts":
            return files.filter((f) => f.path.endsWith(".spec.ts") || f.path.endsWith(".test.ts"));
        case "playwright_js":
            return files.filter((f) => f.path.endsWith(".spec.js") || f.path.endsWith(".test.js"));
        case "cypress":
            return files.filter((f) => f.path.endsWith(".cy.ts") || f.path.endsWith(".cy.js"));
        case "cucumber_java":
            return files.filter((f) => f.path.endsWith(".feature") || f.path.endsWith("Steps.java"));
        case "selenium_java":
        case "junit":
        case "testng":
            return files.filter((f) => f.path.endsWith("Test.java"));
        case "pytest":
        case "selenium_python":
            return files.filter((f) => f.path.startsWith("test_") || f.path.includes("/test_"));
        default:
            return [];
    }
}
function detectConfigFiles(files, framework) {
    if (!Array.isArray(files))
        return [];
    return files.filter((f) => f.path.includes("playwright.config") ||
        f.path.includes("cypress.config") ||
        f.path.includes("pytest.ini") ||
        f.path.includes("testng.xml") ||
        f.path.includes("pom.xml") ||
        f.path.includes("conftest.py") ||
        f.path.includes("build.gradle"));
}
function buildFrameworkSummary(fw) {
    const lines = [
        `Test framework: ${fw.framework}`,
        `Language: ${fw.language}`,
        `Confidence: ${fw.confidence}`,
        `Evidence: ${fw.evidence.join(", ")}`,
    ];
    if (fw.testDir)
        lines.push(`Test directory: ${fw.testDir}`);
    lines.push(`Test file pattern: ${fw.testFilePattern}`);
    return lines.join("\n");
}
function buildPromptRole(fw) {
    switch (fw.framework) {
        case "playwright_ts":
            return "You are a senior test automation engineer specializing in Playwright with TypeScript.";
        case "playwright_js":
            return "You are a senior test automation engineer specializing in Playwright with JavaScript.";
        case "cypress":
            return "You are a senior test automation engineer specializing in Cypress.";
        case "cucumber_java":
            return "You are a senior test automation engineer specializing in Cucumber BDD with Java and Selenium WebDriver. You write Gherkin scenarios and Java step definitions using Page Object Model.";
        case "selenium_java":
            return "You are a senior test automation engineer specializing in Selenium WebDriver with Java.";
        case "testng":
            return "You are a senior test automation engineer specializing in TestNG with Java and Selenium WebDriver.";
        case "pytest":
            return "You are a senior test automation engineer specializing in pytest with Python.";
        case "selenium_python":
            return "You are a senior test automation engineer specializing in Selenium WebDriver with Python.";
        default:
            return "You are a senior test automation engineer.";
    }
}
function buildOutputRules(fw) {
    const common = [
        "Use ONLY methods that exist in the provided page object files",
        "Do NOT invent new methods — if a method does not exist, mention it as a risk",
        "Follow the exact naming conventions used in existing test files",
        "Extend the closest matching existing test file when a relevant one already exists",
        "Do NOT derive filenames from prompt boilerplate or instruction text",
        "Keep tests focused and minimal",
    ];
    switch (fw.framework) {
        case "playwright_ts":
        case "playwright_js":
            return [...common, "Use async/await pattern", "Use expect() from @playwright/test"];
        case "cypress":
            return [...common, "Use cy.get() with data-testid selectors", "Use cy.visit() for navigation"];
        case "cucumber_java":
            return [
                ...common,
                "Write Gherkin in Given/When/Then format",
                "Use @Given @When @Then annotations",
                "Inject Page Objects via constructor — NEVER instantiate WebDriver directly",
                "Place feature files in src/test/resources/features/",
                "Place step definitions in src/test/java/ with correct package",
                "ALWAYS use export default ClassName not export default new ClassName()",
            ];
        case "selenium_java":
        case "testng":
            return [...common, "Use @Test annotation", "Use explicit waits — never Thread.sleep()"];
        case "pytest":
        case "selenium_python":
            return [...common, "Use pytest fixtures", "Use assert statements"];
        default:
            return common;
    }
}
function buildFileLocationRules(fw) {
    switch (fw.framework) {
        case "playwright_ts":
            return ["Test files: tests/ or e2e/", "Extension: .spec.ts"];
        case "playwright_js":
            return ["Test files: tests/ or e2e/", "Extension: .spec.js"];
        case "cypress":
            return ["Test files: cypress/e2e/", "Extension: .cy.ts or .cy.js"];
        case "cucumber_java":
            return [
                "Feature files: src/test/resources/features/",
                "Step definitions: src/test/java/<package>/stepdefinitions/",
                "Page objects: src/main/java/<package>/pages/",
            ];
        case "selenium_java":
        case "testng":
            return ["Test classes: src/test/java/<package>/", "Naming: <Name>Test.java"];
        case "pytest":
        case "selenium_python":
            return ["Test files: tests/", "Naming: test_<name>.py"];
        default:
            return ["Follow existing project structure"];
    }
}
const TASK_FILLER_WORDS = new Set([
    "a", "an", "the", "please", "write", "new", "cucumber",
    "scenario", "for", "test", "create", "generate", "feature",
    "playwright", "pytest", "username", "selector",
    "is", "and", "use", "as", "credentials", "after", "verify",
    "url", "contains", "password", "submit", "with",
    "you", "are", "code", "agent", "analyze", "repo", "repository",
    "inside", "working", "called", "task", "goal", "expected",
    "behavior", "implement", "update", "local", "flow", "function",
    "add", "requirements", "request", "prompt",
]);
const BANNED_TEST_FILE_BASENAMES = new Set([
    "you_are_code_agent_analyze",
    "task_generated",
    "analyze_repo",
]);
const LOGIN_TASK_KEYWORDS = new Set([
    "login",
    "signin",
    "sign",
    "authentication",
    "auth",
    "credentials",
]);
const AUTH_FILE_KEYWORDS = new Set([
    "login",
    "signin",
    "auth",
    "authentication",
    "credential",
    "credentials",
    "session",
]);
function normalizeTaskText(task) {
    return task
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/https?:\/\/[^\s]+/g, " ")
        .replace(/www\.[^\s]+/g, " ")
        .replace(/[a-z0-9-]+\.(com|org|net|io|dev|app|co)[^\s]*/g, " ")
        .replace(/[^a-z0-9\s]+/g, " ")
        .trim();
}
function buildIntentTokens(task) {
    const sanitizedTask = normalizeTaskText(task);
    const rawTokens = sanitizedTask.split(/\s+/).filter(Boolean);
    const meaningfulTokens = rawTokens.filter((token) => !TASK_FILLER_WORDS.has(token));
    const sourceTokens = meaningfulTokens.length > 0 ? meaningfulTokens : rawTokens;
    const limitedTokens = [];
    let totalLength = 0;
    for (const token of sourceTokens) {
        const nextLength = totalLength === 0 ? token.length : totalLength + 1 + token.length;
        if (limitedTokens.length >= 5 || nextLength > 40) {
            break;
        }
        limitedTokens.push(token);
        totalLength = nextLength;
    }
    return limitedTokens.length > 0 ? limitedTokens : ["generated", "test"];
}
function hasLoginIntent(task) {
    const normalizedTask = normalizeTaskText(task);
    if (normalizedTask.includes("sign in") ||
        normalizedTask.includes("invalid credential")) {
        return true;
    }
    const tokens = normalizedTask.split(/\s+/).filter(Boolean);
    return tokens.some((token) => LOGIN_TASK_KEYWORDS.has(token));
}
function preferredBasenameToken(task) {
    const normalizedTask = normalizeTaskText(task);
    if (normalizedTask.includes("login") ||
        normalizedTask.includes("sign in") ||
        normalizedTask.includes("signin") ||
        normalizedTask.includes("invalid credential")) {
        return "login";
    }
    if (normalizedTask.includes("auth") ||
        normalizedTask.includes("authentication")) {
        return "auth";
    }
    return null;
}
function buildOutputNameParts(task) {
    const preferredToken = preferredBasenameToken(task);
    const tokens = preferredToken ? [preferredToken] : buildIntentTokens(task);
    const slug = tokens.join("_");
    const pascal = tokens
        .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
        .join("");
    return { slug, pascal };
}
function tokenizePath(pathValue) {
    return node_path_1.default.posix
        .basename(pathValue)
        .toLowerCase()
        .replace(/\.(spec|test|cy)\.[a-z]+$/i, "")
        .replace(/^test_/i, "")
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}
function scoreExistingTestFile(pathValue, tokens) {
    if (tokens.length === 0)
        return 0;
    const fileTokens = tokenizePath(pathValue);
    return tokens.reduce((score, token) => score + (fileTokens.includes(token) ? 2 : pathValue.includes(token) ? 1 : 0), 0);
}
function scoreAuthRelatedExistingTestFile(pathValue, task) {
    if (!hasLoginIntent(task))
        return 0;
    const pathTokens = tokenizePath(pathValue);
    const normalizedPath = pathValue.toLowerCase();
    const keywordScore = [...AUTH_FILE_KEYWORDS].reduce((score, token) => {
        if (pathTokens.includes(token))
            return score + 12;
        if (normalizedPath.includes(token))
            return score + 6;
        return score;
    }, 0);
    return keywordScore;
}
function rankExistingTestFiles(files, task) {
    const tokens = buildIntentTokens(task);
    return [...files]
        .map((file) => ({
        path: file.path,
        baseScore: scoreExistingTestFile(file.path, tokens),
        authPreferenceScore: scoreAuthRelatedExistingTestFile(file.path, task),
        totalScore: scoreExistingTestFile(file.path, tokens) +
            scoreAuthRelatedExistingTestFile(file.path, task),
    }))
        .sort((a, b) => {
        if (b.totalScore !== a.totalScore)
            return b.totalScore - a.totalScore;
        return a.path.localeCompare(b.path);
    });
}
function isUnsafeGeneratedSlug(slug) {
    if (!slug)
        return true;
    if (BANNED_TEST_FILE_BASENAMES.has(slug))
        return true;
    const tokens = slug.split("_").filter(Boolean);
    const meaningfulTokens = tokens.filter((token) => !TASK_FILLER_WORDS.has(token));
    return (tokens.length === 0 ||
        meaningfulTokens.length === 0 ||
        tokens.length > 4 ||
        slug.length > 32);
}
function findExistingDirectory(files, matcher) {
    const existingFile = [...files]
        .sort((a, b) => {
        const aIsPreferred = a.path.startsWith("src/test/resources/features/");
        const bIsPreferred = b.path.startsWith("src/test/resources/features/");
        if (aIsPreferred === bIsPreferred)
            return a.path.localeCompare(b.path);
        return aIsPreferred ? -1 : 1;
    })
        .find(matcher);
    return existingFile ? node_path_1.default.posix.dirname(existingFile.path) : null;
}
function buildOutputPaths(task, fw, files) {
    const { slug, pascal } = buildOutputNameParts(task);
    const base = fw.testDir ?? "tests";
    const normalizedTask = normalizeTaskText(task);
    const intentTokens = buildIntentTokens(task);
    const rankedCandidates = rankExistingTestFiles(detectTestFiles(files, fw), task);
    const closestExistingTestFile = rankedCandidates[0] && rankedCandidates[0].totalScore > 0
        ? rankedCandidates[0].path
        : null;
    const suspiciousFilenameRejected = isUnsafeGeneratedSlug(slug);
    const safeSlug = suspiciousFilenameRejected ? "app" : slug;
    const hasLoginTaskIntent = hasLoginIntent(task);
    const preferredToken = preferredBasenameToken(task);
    const buildDebug = (fallbackTestFilePath, finalOutputPath, finalOutputPathSource) => ({
        selectedRole: "test_engineer",
        normalizedTask,
        intentTokens,
        hasLoginIntent: hasLoginTaskIntent,
        preferredBasenameToken: preferredToken,
        candidateTestFiles: rankedCandidates,
        chosenExistingTestFile: closestExistingTestFile,
        generatedSlug: slug,
        safeSlug,
        suspiciousFilenameRejected,
        fallbackTestFilePath,
        finalOutputPath,
        finalOutputPathSource,
    });
    switch (fw.framework) {
        case "playwright_ts": {
            const fallbackTestFilePath = `${base}/${safeSlug}.spec.ts`;
            const finalOutputPath = closestExistingTestFile ?? fallbackTestFilePath;
            return {
                outputPaths: { testFile: finalOutputPath },
                debug: buildDebug(fallbackTestFilePath, finalOutputPath, closestExistingTestFile ? "existing_test_file" : "generated_fallback"),
            };
        }
        case "playwright_js": {
            const fallbackTestFilePath = `${base}/${safeSlug}.spec.js`;
            const finalOutputPath = closestExistingTestFile ?? fallbackTestFilePath;
            return {
                outputPaths: { testFile: finalOutputPath },
                debug: buildDebug(fallbackTestFilePath, finalOutputPath, closestExistingTestFile ? "existing_test_file" : "generated_fallback"),
            };
        }
        case "cypress": {
            const fallbackTestFilePath = `cypress/e2e/${safeSlug}.cy.ts`;
            const finalOutputPath = closestExistingTestFile ?? fallbackTestFilePath;
            return {
                outputPaths: { testFile: finalOutputPath },
                debug: buildDebug(fallbackTestFilePath, finalOutputPath, closestExistingTestFile ? "existing_test_file" : "generated_fallback"),
            };
        }
        case "cucumber_java": {
            const featureDir = findExistingDirectory(files, (file) => file.path.endsWith(".feature")) ??
                fw.testDir ??
                "src/test/resources/features";
            const stepDefinitionDir = findExistingDirectory(files, (file) => file.path.endsWith("Steps.java")) ??
                "src/test/java/com/stepdefinitions";
            const fallbackTestFilePath = `${featureDir}/${safeSlug}.feature`;
            return {
                outputPaths: {
                    testFile: fallbackTestFilePath,
                    featureFile: fallbackTestFilePath,
                    stepDefinition: `${stepDefinitionDir}/${pascal}Steps.java`,
                },
                debug: buildDebug(fallbackTestFilePath, fallbackTestFilePath, "generated_fallback"),
            };
        }
        case "selenium_java":
        case "testng":
            return {
                outputPaths: { testFile: `src/test/java/${pascal}Test.java` },
                debug: buildDebug(`src/test/java/${pascal}Test.java`, `src/test/java/${pascal}Test.java`, "generated_fallback"),
            };
        case "pytest":
        case "selenium_python":
            return {
                outputPaths: {
                    testFile: closestExistingTestFile ?? `tests/test_${safeSlug}.py`,
                },
                debug: buildDebug(`tests/test_${safeSlug}.py`, closestExistingTestFile ?? `tests/test_${safeSlug}.py`, closestExistingTestFile ? "existing_test_file" : "generated_fallback"),
            };
        default:
            return {
                outputPaths: {
                    testFile: closestExistingTestFile ?? `tests/${safeSlug}.test`,
                },
                debug: buildDebug(`tests/${safeSlug}.test`, closestExistingTestFile ?? `tests/${safeSlug}.test`, closestExistingTestFile ? "existing_test_file" : "generated_fallback"),
            };
    }
}
function buildTestEngineerContext(task, framework, files) {
    const safeFiles = Array.isArray(files) ? files : [];
    const existingTestFiles = detectTestFiles(safeFiles, framework);
    const pageObjectFiles = detectPageObjects(safeFiles, framework.language);
    const stepDefinitionFiles = detectStepDefinitions(safeFiles);
    const featureFiles = detectFeatureFiles(safeFiles);
    const configFiles = detectConfigFiles(safeFiles, framework);
    const { outputPaths, debug } = buildOutputPaths(task, framework, safeFiles);
    return {
        framework,
        existingTestFiles,
        pageObjectFiles,
        stepDefinitionFiles,
        featureFiles,
        configFiles,
        frameworkSummary: buildFrameworkSummary(framework),
        promptRole: buildPromptRole(framework),
        outputRules: buildOutputRules(framework),
        fileLocationRules: buildFileLocationRules(framework),
        outputPaths,
        debug,
    };
}
//# sourceMappingURL=testEngineerContext.js.map