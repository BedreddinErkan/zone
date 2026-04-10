"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startServer = exports.app = void 0;
console.log("[zone] server.ts loading...");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = require("node:fs");
function loadCliAuthConfig() {
    const configPath = node_path_1.default.join(node_os_1.default.homedir(), ".zone", "config.json");
    if (!(0, node_fs_1.existsSync)(configPath)) {
        return;
    }
    try {
        const raw = (0, node_fs_1.readFileSync)(configPath, "utf8");
        const parsed = JSON.parse(raw);
        const userId = typeof parsed.userId === "string" ? parsed.userId.trim() : "";
        const email = typeof parsed.email === "string" ? parsed.email.trim() : "";
        if (!userId) {
            return;
        }
        process.env.ZONE_USER_ID = userId;
        if (email) {
            process.env.ZONE_USER_EMAIL = email;
        }
        console.log(`[zone] Loaded CLI auth for user ${userId}`);
    }
    catch {
        console.warn("[zone] Warning: could not parse ~/.zone/config.json");
    }
}
loadCliAuthConfig();
// Load the API server synchronously so this wrapper stays compatible with CJS startup.
// `zone serve` imports this file through the current CommonJS-oriented serve path.
// Using require here avoids top-level await while preserving the same startup behavior.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const apiServer = require("./api/server.js");
exports.app = apiServer.app;
exports.startServer = apiServer.startServer;
//# sourceMappingURL=server.js.map