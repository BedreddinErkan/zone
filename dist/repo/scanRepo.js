"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanRepo = scanRepo;
const fast_glob_1 = __importDefault(require("fast-glob"));
const node_path_1 = __importDefault(require("node:path"));
function detectCategory(filePath) {
    const normalized = filePath.replace(/\\/g, "/");
    if (normalized.startsWith("client/"))
        return "frontend";
    if (normalized.startsWith("server/"))
        return "backend";
    return "unknown";
}
async function scanRepo(targetPath) {
    const entries = await (0, fast_glob_1.default)([
        // JavaScript/TypeScript projects
        "client/src/**/*.{js,jsx,ts,tsx,css}",
        "client/package.json",
        "server/**/*.{js,ts}",
        "server/package.json",
        "src/**/*.{js,jsx,ts,tsx}",
        // Java projects
        "src/**/*.java",
        "src/**/*.feature",
        "src/test/resources/**/*.feature",
        "features/**/*.feature",
        // Config files
        "*.json",
        "*.xml",
        "*.gradle",
        "*.md",
        "*.properties",
        // SQL / Database
        "**/*.sql",
        "**/migrations/**/*.sql",
        "**/db/**/*.sql",
        "**/alembic/**/*.py",
        "alembic.ini",
        "**/*.db",
        "my.cnf",
        "postgresql.conf",
        // Root config files — framework detection
        "playwright.config.ts",
        "playwright.config.js",
        "cypress.config.ts",
        "cypress.config.js",
        "pytest.ini",
        "conftest.py",
        "pyproject.toml",
        "testng.xml",
        // Cypress
        "cypress/**/*.{js,ts,feature}",
        // Playwright
        "tests/**/*.{js,ts}",
        "e2e/**/*.{js,ts}",
        // Python
        "tests/**/*.py",
        "**/*.py",
        // UI files
        "src/ui/**/*.{html,css,js}",
        "public/**/*.{html,css}",
        "*.html",
    ], {
        cwd: targetPath,
        onlyFiles: true,
        dot: false,
        ignore: [
            "**/node_modules/**",
            "**/dist/**",
            "**/build/**",
            "**/target/**",
            "**/.git/**",
            "**/.next/**",
            "**/coverage/**",
            "**/.agent-cache/**",
            "**/.agent-patches/**",
            "**/.agent-backups/**",
            "**/venv/**",
            "**/.venv/**",
            "**/env/**",
            "**/__pycache__/**",
            "**/*.pyc",
            "**/site-packages/**",
            "**/.pytest_cache/**",
        ],
    });
    return entries.map((entry) => {
        const extension = node_path_1.default.extname(entry).replace(".", "").toLowerCase();
        return {
            path: entry,
            absolutePath: node_path_1.default.join(targetPath, entry),
            extension,
            category: detectCategory(entry),
        };
    });
}
//# sourceMappingURL=scanRepo.js.map