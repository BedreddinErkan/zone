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
    if (normalized.startsWith("client/")) {
        return "frontend";
    }
    if (normalized.startsWith("server/")) {
        return "backend";
    }
    return "unknown";
}
async function scanRepo(targetPath) {
    const entries = await (0, fast_glob_1.default)([
        "client/src/**/*.{js,jsx,ts,tsx,css}",
        "server/**/*.{js,ts}",
        "*.json",
        "*.md"
    ], {
        cwd: targetPath,
        onlyFiles: true,
        dot: false,
        ignore: [
            "**/node_modules/**",
            "**/dist/**",
            "**/build/**",
            "**/.git/**",
            "**/.next/**",
            "**/coverage/**",
            "**/.agent-cache/**",
            "**/.agent-patches/**",
            "**/.agent-backups/**"
        ]
    });
    return entries.map((entry) => {
        const extension = node_path_1.default.extname(entry).replace(".", "").toLowerCase();
        return {
            path: entry,
            absolutePath: node_path_1.default.join(targetPath, entry),
            extension,
            category: detectCategory(entry)
        };
    });
}
//# sourceMappingURL=scanRepo.js.map