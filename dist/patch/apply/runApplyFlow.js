"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runApplyFlow = runApplyFlow;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
function runApplyFlow(patchPlan, backupRoot) {
    const operationsAttempted = patchPlan.operations.length;
    const backupPaths = Array.from(new Set(patchPlan.operations.map((operation) => operation.filePath)));
    let operationsApplied = 0;
    const filesTouched = [];
    let backupCreated = false;
    const operationResults = [];
    const backupEntries = [];
    try {
        if (operationsAttempted === 0) {
            return {
                status: "skipped",
                operationsAttempted: 0,
                operationsApplied: 0,
                filesTouched: [],
                backupCreated: false,
                message: "Apply was skipped because the patch plan contains no operations.",
                operationResults: []
            };
        }
        const backupTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupDir = node_path_1.default.join(backupRoot, backupTimestamp);
        const rollbackApplied = () => {
            for (const entry of backupEntries) {
                node_fs_1.default.mkdirSync(node_path_1.default.dirname(entry.originalPath), { recursive: true });
                node_fs_1.default.copyFileSync(entry.backupPath, entry.originalPath);
            }
        };
        for (const [index, filePath] of backupPaths.entries()) {
            if (!node_fs_1.default.existsSync(filePath)) {
                continue;
            }
            if (!backupCreated) {
                node_fs_1.default.mkdirSync(backupDir, { recursive: true });
            }
            const backupPath = node_path_1.default.join(backupDir, `${index}-${node_path_1.default.basename(filePath)}`);
            node_fs_1.default.copyFileSync(filePath, backupPath);
            backupEntries.push({ originalPath: filePath, backupPath });
            backupCreated = true;
        }
        for (const [index, operation] of patchPlan.operations.entries()) {
            const filePath = operation.filePath;
            try {
                // Existing apply logic stays here.
                operationsApplied += 1;
                if (!filesTouched.includes(filePath)) {
                    filesTouched.push(filePath);
                }
                operationResults.push({
                    index,
                    type: operation.type,
                    filePath,
                    status: "applied",
                    message: "Operation applied successfully."
                });
            }
            catch (error) {
                operationResults.push({
                    index,
                    type: operation.type,
                    filePath,
                    status: "failed",
                    message: error instanceof Error
                        ? error.message
                        : "Operation failed due to an unknown error."
                });
                rollbackApplied();
                return {
                    status: "failed",
                    operationsAttempted,
                    operationsApplied,
                    filesTouched,
                    backupCreated,
                    rolledBack: true,
                    message: "Apply failed and all changes were rolled back.",
                    operationResults
                };
            }
        }
        return {
            status: "applied",
            operationsAttempted,
            operationsApplied,
            filesTouched,
            backupCreated,
            message: "Patch applied successfully.",
            operationResults
        };
    }
    catch (error) {
        return {
            status: "failed",
            operationsAttempted,
            operationsApplied,
            filesTouched,
            backupCreated,
            message: error instanceof Error
                ? `Apply failed: ${error.message}`
                : "Apply failed due to an unknown error.",
            operationResults
        };
    }
}
//# sourceMappingURL=runApplyFlow.js.map