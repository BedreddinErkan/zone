"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const scanRepoMock = vitest_1.vi.fn();
const readProjectFilesMock = vitest_1.vi.fn();
const createMock = vitest_1.vi.fn();
const getModelNameMock = vitest_1.vi.fn();
const validateTestOutputMock = vitest_1.vi.fn();
const buildDataAnalystContextMock = vitest_1.vi.fn();
const detectDataSchemaMock = vitest_1.vi.fn();
const buildDataAnalystPromptMock = vitest_1.vi.fn();
vitest_1.vi.mock("../repo/scanRepo.js", () => ({
    scanRepo: scanRepoMock,
}));
vitest_1.vi.mock("../repo/readProjectFiles.js", () => ({
    readProjectFiles: readProjectFilesMock,
}));
vitest_1.vi.mock("../llm/openaiClient.js", () => ({
    createOpenAIClient: createMock,
    getModelName: getModelNameMock,
}));
vitest_1.vi.mock("./testOutputValidator.js", () => ({
    validateTestOutput: validateTestOutputMock,
}));
vitest_1.vi.mock("./dataAnalystContext.js", () => ({
    buildDataAnalystContext: buildDataAnalystContextMock,
}));
vitest_1.vi.mock("./detectDataSchema.js", () => ({
    detectDataSchema: detectDataSchemaMock,
}));
vitest_1.vi.mock("../prompts/dataAnalystPrompt.js", () => ({
    buildDataAnalystPrompt: buildDataAnalystPromptMock,
}));
function buildRepoFile(path) {
    return {
        path,
        absolutePath: `C:/repo/${path}`,
        extension: path.split(".").pop() ?? "",
        category: "unknown",
    };
}
(0, vitest_1.describe)("runDataAnalystFlow", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.resetModules();
        vitest_1.vi.clearAllMocks();
        validateTestOutputMock.mockReturnValue({
            decision: "pass",
            issues: [],
            summary: "Validation passed",
        });
    });
    (0, vitest_1.it)("returns fileDiffs for generated migration patches", async () => {
        const files = [buildRepoFile("db/migration/V3__orders.sql")];
        const client = {
            responses: {
                create: vitest_1.vi.fn().mockResolvedValue({
                    output_text: JSON.stringify({
                        summary: "Creates orders table",
                        warnings: [],
                        confidence: 90,
                        migrationFile: {
                            path: "db/migration/V3__orders.sql",
                            content: "CREATE TABLE IF NOT EXISTS orders (\n  id SERIAL PRIMARY KEY,\n  email TEXT NOT NULL\n);",
                        },
                    }),
                }),
            },
        };
        scanRepoMock.mockResolvedValue(files);
        detectDataSchemaMock.mockReturnValue({
            dialect: "postgresql",
            migrationFormat: "flyway",
        });
        buildDataAnalystContextMock.mockReturnValue({
            existingSqlFiles: files,
        });
        readProjectFilesMock.mockResolvedValue({
            "C:/repo/db/migration/V3__orders.sql": "CREATE TABLE IF NOT EXISTS orders (\n  id SERIAL PRIMARY KEY\n);",
        });
        buildDataAnalystPromptMock.mockReturnValue("prompt");
        createMock.mockReturnValue(client);
        getModelNameMock.mockReturnValue("test-model");
        const { runDataAnalystFlow } = await import("./runDataAnalystFlow.js");
        const result = await runDataAnalystFlow({
            task: "add email to orders table",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.fileDiffs).toEqual([
                vitest_1.expect.objectContaining({
                    filePath: "db/migration/V3__orders.sql",
                    addedLines: 2,
                    removedLines: 1,
                    diff: vitest_1.expect.arrayContaining([
                        vitest_1.expect.objectContaining({
                            type: "added",
                            content: "  email TEXT NOT NULL",
                        }),
                    ]),
                }),
            ]);
        }
    });
});
//# sourceMappingURL=runDataAnalystFlow.test.js.map