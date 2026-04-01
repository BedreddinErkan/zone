"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSchemaSnapshot = loadSchemaSnapshot;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
async function loadSchemaSnapshot(projectRoot) {
    const candidatePaths = [
        node_path_1.default.join(projectRoot, ".agent-cache", "schema.json"),
        node_path_1.default.join(projectRoot, "schema.json"),
        node_path_1.default.join(projectRoot, "supabase-schema.json")
    ];
    for (const filePath of candidatePaths) {
        try {
            const raw = await promises_1.default.readFile(filePath, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.tables) && Array.isArray(parsed.columns)) {
                return parsed;
            }
        }
        catch {
            // ignore and continue
        }
    }
    return null;
}
//# sourceMappingURL=loadSchemaSnapshot.js.map