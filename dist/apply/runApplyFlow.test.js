"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_fs_1 = require("node:fs");
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const runApplyFlow_js_1 = require("./runApplyFlow.js");
const tempDirs = [];
async function createTempDir() {
    const dir = await node_fs_1.promises.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), "zone-apply-"));
    tempDirs.push(dir);
    return dir;
}
(0, vitest_1.afterEach)(async () => {
    await Promise.all(tempDirs.map((dir) => node_fs_1.promises.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
});
function buildRunAgentResult(mode) {
    return {
        task: "rename helper function",
        decision: {
            mode,
            confidenceScore: 82
        },
        risk: {
            score: 18,
            breakdown: {
                destructive: 0,
                schema: 0,
                critical: 0,
                lowRisk: 10,
                massScope: 0
            }
        },
        confidence: {
            score: 82,
            breakdown: {
                base: 100,
                destructivePenalty: 0,
                schemaPenalty: 0,
                criticalPenalty: 0,
                massScopePenalty: 0,
                lowRiskBonus: 0
            }
        },
        explanation: "SAFE TO APPLY: Task appears localized and low risk.",
        recommendation: "Safe to apply with standard review.",
        topRisks: [],
        trace: {},
        reasonCodes: []
    };
}
(0, vitest_1.describe)("runApplyFlow", () => {
    (0, vitest_1.it)("does not apply when decision mode is blocked", async () => {
        const dir = await createTempDir();
        const filePath = node_path_1.default.join(dir, "example.ts");
        const plan = {
            patches: [
                {
                    filePath,
                    nextContent: "export const value = 1;\n"
                }
            ]
        };
        const result = await (0, runApplyFlow_js_1.runApplyFlow)({
            result: buildRunAgentResult("blocked"),
            plan,
            request: { confirm: true }
        });
        (0, vitest_1.expect)(result).toEqual({
            applied: false,
            filesChanged: [],
            summary: "Blocked decisions cannot be applied."
        });
    });
    (0, vitest_1.it)("does not apply when confirmation is missing", async () => {
        const dir = await createTempDir();
        const filePath = node_path_1.default.join(dir, "example.ts");
        const plan = {
            patches: [
                {
                    filePath,
                    nextContent: "export const value = 1;\n"
                }
            ]
        };
        const result = await (0, runApplyFlow_js_1.runApplyFlow)({
            result: buildRunAgentResult("preview_only"),
            plan,
            request: { confirm: false }
        });
        (0, vitest_1.expect)(result).toEqual({
            applied: false,
            filesChanged: [],
            summary: "Apply confirmation is required."
        });
    });
    (0, vitest_1.it)("applies a valid patch plan for safe_to_apply mode", async () => {
        const dir = await createTempDir();
        const filePath = node_path_1.default.join(dir, "example.ts");
        const plan = {
            patches: [
                {
                    filePath,
                    nextContent: "export const value = 42;\n"
                }
            ]
        };
        const result = await (0, runApplyFlow_js_1.runApplyFlow)({
            result: buildRunAgentResult("safe_to_apply"),
            plan,
            request: { confirm: true }
        });
        const saved = await node_fs_1.promises.readFile(filePath, "utf8");
        (0, vitest_1.expect)(saved).toBe("export const value = 42;\n");
        (0, vitest_1.expect)(result).toEqual({
            applied: true,
            filesChanged: [filePath],
            summary: "Applied 1 file change(s)."
        });
    });
    (0, vitest_1.it)("throws for an empty patch plan", async () => {
        await (0, vitest_1.expect)((0, runApplyFlow_js_1.runApplyFlow)({
            result: buildRunAgentResult("safe_to_apply"),
            plan: { patches: [] },
            request: { confirm: true }
        })).rejects.toThrow("Patch plan must include at least one patch.");
    });
    (0, vitest_1.it)("throws for duplicate file paths", async () => {
        const dir = await createTempDir();
        const filePath = node_path_1.default.join(dir, "example.ts");
        await (0, vitest_1.expect)((0, runApplyFlow_js_1.runApplyFlow)({
            result: buildRunAgentResult("safe_to_apply"),
            plan: {
                patches: [
                    {
                        filePath,
                        nextContent: "export const value = 1;\n"
                    },
                    {
                        filePath,
                        nextContent: "export const value = 2;\n"
                    }
                ]
            },
            request: { confirm: true }
        })).rejects.toThrow(`Duplicate patch filePath detected: ${filePath}`);
    });
});
//# sourceMappingURL=runApplyFlow.test.js.map