"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureDir = ensureDir;
exports.fileExists = fileExists;
exports.writeTextFile = writeTextFile;
exports.readTextFile = readTextFile;
exports.sanitizeFileName = sanitizeFileName;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
async function ensureDir(dirPath) {
    await promises_1.default.mkdir(dirPath, { recursive: true });
}
async function fileExists(filePath) {
    try {
        await promises_1.default.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function writeTextFile(filePath, content) {
    await ensureDir(node_path_1.default.dirname(filePath));
    await promises_1.default.writeFile(filePath, content, "utf-8");
}
async function readTextFile(filePath) {
    return promises_1.default.readFile(filePath, "utf-8");
}
function sanitizeFileName(input) {
    return input.replace(/[<>:"/\\|?*]+/g, "_");
}
//# sourceMappingURL=files.js.map