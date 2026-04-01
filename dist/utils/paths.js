"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTargetPath = resolveTargetPath;
const node_path_1 = __importDefault(require("node:path"));
function resolveTargetPath(inputPath) {
    if (!inputPath || inputPath.trim() === "") {
        return process.cwd();
    }
    return node_path_1.default.resolve(inputPath);
}
//# sourceMappingURL=paths.js.map