"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_http_1 = require("node:http");
const runAgentMock = vitest_1.vi.fn();
const runLlmPatchFlowMock = vitest_1.vi.fn();
const applyLlmPatchesMock = vitest_1.vi.fn();
const runTestEngineerFlowMock = vitest_1.vi.fn();
const runDataAnalystFlowMock = vitest_1.vi.fn();
vitest_1.vi.mock("../core/runAgent.js", () => ({
    runAgent: runAgentMock,
}));
vitest_1.vi.mock("../core/runLlmPatchFlow.js", () => ({
    runLlmPatchFlow: runLlmPatchFlowMock,
}));
vitest_1.vi.mock("../core/applyLlmPatches.js", () => ({
    applyLlmPatches: applyLlmPatchesMock,
}));
vitest_1.vi.mock("../roles/runTestEngineerFlow.js", () => ({
    runTestEngineerFlow: runTestEngineerFlowMock,
}));
vitest_1.vi.mock("../roles/runDataAnalystFlow.js", () => ({
    runDataAnalystFlow: runDataAnalystFlowMock,
}));
(0, vitest_1.describe)("/api/test-engineer", () => {
    let server;
    let baseUrl;
    (0, vitest_1.beforeEach)(async () => {
        vitest_1.vi.resetModules();
        vitest_1.vi.clearAllMocks();
        process.env.VITEST = "true";
        const { app } = await import("./server.js");
        server = (0, node_http_1.createServer)(app);
        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("Server address unavailable");
        }
        baseUrl = `http://127.0.0.1:${address.port}`;
    });
    (0, vitest_1.afterEach)(async () => {
        await new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
        });
    });
    (0, vitest_1.it)("returns complexity from the test engineer flow", async () => {
        runTestEngineerFlowMock.mockResolvedValue({
            ok: true,
            framework: "playwright_ts",
            language: "typescript",
            confidence: 82,
            summary: "Generated test",
            warnings: [],
            complexity: "data_driven",
            applyPatches: [],
            preview: "preview",
        });
        const response = await fetch(`${baseUrl}/api/test-engineer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                task: "Write a data driven login test for multiple users",
                repoPath: "C:/repo",
            }),
        });
        const body = await response.json();
        (0, vitest_1.expect)(response.status).toBe(200);
        (0, vitest_1.expect)(body.complexity).toBe("data_driven");
    });
    (0, vitest_1.it)("returns the expected successful shape for /api/data-analyst", async () => {
        runDataAnalystFlowMock.mockResolvedValue({
            ok: true,
            dialect: "postgresql",
            migrationFormat: "flyway",
            confidence: 90,
            summary: "Creates orders table",
            warnings: ["Existing index naming differs from default convention."],
            applyPatches: [
                {
                    filePath: "db/migration/V3__orders.sql",
                    fullContent: "CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY);",
                },
            ],
            preview: "=== DATA ANALYST PREVIEW ===\nDialect: postgresql",
        });
        const response = await fetch(`${baseUrl}/api/data-analyst`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                task: "create orders table",
                repoPath: "C:/repo/zone-flyway-test",
            }),
        });
        const body = await response.json();
        (0, vitest_1.expect)(response.status).toBe(200);
        (0, vitest_1.expect)(body).toMatchObject({
            ok: true,
            dialect: "postgresql",
            migrationFormat: "flyway",
            confidence: 90,
            summary: "Creates orders table",
            warnings: ["Existing index naming differs from default convention."],
        });
        (0, vitest_1.expect)(body.applyPatches).toHaveLength(1);
        (0, vitest_1.expect)(body.applyPatches[0].filePath).toBe("db/migration/V3__orders.sql");
    });
    (0, vitest_1.it)("returns contextFiles from the developer patch flow", async () => {
        runLlmPatchFlowMock.mockResolvedValue({
            ok: true,
            patchPreview: "=== LLM PATCH PREVIEW ===\nSummary: Update login flow",
            warnings: [],
            contextFiles: [
                "src/components/LoginForm.tsx",
                "server/routes/auth.ts",
            ],
            applyPatches: [
                {
                    filePath: "src/components/LoginForm.tsx",
                    fullContent: "export function LoginForm() {}",
                },
            ],
        });
        const response = await fetch(`${baseUrl}/api/patch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                task: "fix login form auth bug",
                repoPath: "C:/repo",
            }),
        });
        const body = await response.json();
        (0, vitest_1.expect)(response.status).toBe(200);
        (0, vitest_1.expect)(body.contextFiles).toEqual([
            "src/components/LoginForm.tsx",
            "server/routes/auth.ts",
        ]);
    });
    (0, vitest_1.it)("returns fileDiffs from /api/dry-run", async () => {
        runLlmPatchFlowMock.mockResolvedValue({
            ok: true,
            patchPreview: "=== LLM PATCH PREVIEW ===\nSummary: Dry run",
            warnings: [],
            patchResults: [
                { filePath: "src/foo.ts", status: "applied" },
            ],
            fileDiffs: [
                {
                    filePath: "src/foo.ts",
                    before: "export const foo = 1;",
                    after: "export const foo = 2;",
                    diff: [
                        { type: "removed", content: "export const foo = 1;", lineNumber: 1 },
                        { type: "added", content: "export const foo = 2;", lineNumber: 1 },
                    ],
                    addedLines: 1,
                    removedLines: 1,
                },
            ],
            applyPatches: [
                {
                    filePath: "src/foo.ts",
                    fullContent: "export const foo = 2;",
                },
            ],
        });
        const response = await fetch(`${baseUrl}/api/dry-run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                task: "update foo",
                repoPath: "C:/repo",
            }),
        });
        const body = await response.json();
        (0, vitest_1.expect)(response.status).toBe(200);
        (0, vitest_1.expect)(body.ok).toBe(true);
        (0, vitest_1.expect)(body.fileDiffs).toHaveLength(1);
        (0, vitest_1.expect)(body.patchResults).toEqual([
            { filePath: "src/foo.ts", status: "applied" },
        ]);
    });
});
//# sourceMappingURL=server.test.js.map