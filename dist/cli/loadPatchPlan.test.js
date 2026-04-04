"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const mockReadFileSync = vitest_1.vi.fn();
vitest_1.vi.mock("node:fs", () => ({
    readFileSync: mockReadFileSync
}));
(0, vitest_1.describe)("loadPatchPlan", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.it)("valid patch plan yükler", async () => {
        const validPlan = {
            patches: [
                {
                    filePath: "src/file.ts",
                    nextContent: "export const x = 1;"
                }
            ]
        };
        mockReadFileSync.mockReturnValue(JSON.stringify(validPlan));
        const { loadPatchPlan } = await import("./loadPatchPlan.js");
        const result = loadPatchPlan("./plan.json");
        (0, vitest_1.expect)(result).toEqual(validPlan);
    });
    (0, vitest_1.it)("dosya okunamazsa throw eder", async () => {
        mockReadFileSync.mockImplementation(() => {
            throw new Error("ENOENT");
        });
        const { loadPatchPlan } = await import("./loadPatchPlan.js");
        (0, vitest_1.expect)(() => loadPatchPlan("./missing.json")).toThrow("Failed to read patch plan");
    });
    (0, vitest_1.it)("invalid JSON ise throw eder", async () => {
        mockReadFileSync.mockReturnValue("{ invalid json }");
        const { loadPatchPlan } = await import("./loadPatchPlan.js");
        (0, vitest_1.expect)(() => loadPatchPlan("./plan.json")).toThrow("Failed to parse patch plan JSON");
    });
    (0, vitest_1.it)("patches yoksa throw eder", async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({}));
        const { loadPatchPlan } = await import("./loadPatchPlan.js");
        (0, vitest_1.expect)(() => loadPatchPlan("./plan.json")).toThrow('Patch plan must include a "patches" array.');
    });
    (0, vitest_1.it)("patch array değilse throw eder", async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({ patches: "not-array" }));
        const { loadPatchPlan } = await import("./loadPatchPlan.js");
        (0, vitest_1.expect)(() => loadPatchPlan("./plan.json")).toThrow();
    });
    (0, vitest_1.it)("patch object değilse throw eder", async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({ patches: ["invalid"] }));
        const { loadPatchPlan } = await import("./loadPatchPlan.js");
        (0, vitest_1.expect)(() => loadPatchPlan("./plan.json")).toThrow("must be an object");
    });
    (0, vitest_1.it)("filePath yoksa throw eder", async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({
            patches: [{ nextContent: "x" }]
        }));
        const { loadPatchPlan } = await import("./loadPatchPlan.js");
        (0, vitest_1.expect)(() => loadPatchPlan("./plan.json")).toThrow("filePath");
    });
    (0, vitest_1.it)("nextContent yoksa throw eder", async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({
            patches: [{ filePath: "a.ts" }]
        }));
        const { loadPatchPlan } = await import("./loadPatchPlan.js");
        (0, vitest_1.expect)(() => loadPatchPlan("./plan.json")).toThrow("nextContent");
    });
    (0, vitest_1.it)("filePath boş string ise throw eder", async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({
            patches: [{ filePath: "", nextContent: "x" }]
        }));
        const { loadPatchPlan } = await import("./loadPatchPlan.js");
        (0, vitest_1.expect)(() => loadPatchPlan("./plan.json")).toThrow("filePath");
    });
});
//# sourceMappingURL=loadPatchPlan.test.js.map