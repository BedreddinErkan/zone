"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.backupFile = backupFile;
const node_path_1 = __importDefault(require("node:path"));
const files_js_1 = require("../utils/files.js");
async function backupFile(originalPath, backupRoot) {
    const exists = await (0, files_js_1.fileExists)(originalPath);
    if (!exists) {
        return null;
    }
    const content = await (0, files_js_1.readTextFile)(originalPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = node_path_1.default.basename(originalPath);
    const backupDir = node_path_1.default.join(backupRoot, timestamp);
    await (0, files_js_1.ensureDir)(backupDir);
    const backupPath = node_path_1.default.join(backupDir, fileName);
    await (0, files_js_1.writeTextFile)(backupPath, content);
    return backupPath;
}
//# sourceMappingURL=backupFile.js.map