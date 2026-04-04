"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyPatchPlan = applyPatchPlan;
const node_fs_1 = require("node:fs");
async function applyPatchPlan(plan) {
    const filesChanged = [];
    for (const patch of plan.patches) {
        await node_fs_1.promises.writeFile(patch.filePath, patch.nextContent, "utf8");
        filesChanged.push(patch.filePath);
    }
    return {
        applied: true,
        filesChanged,
        summary: `Applied ${filesChanged.length} file change(s).`
    };
}
//# sourceMappingURL=applyPatchPlan.js.map